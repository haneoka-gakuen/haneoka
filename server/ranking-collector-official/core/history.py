# L3 — GEB
# Input: Region-scoped catalogs, observations and a local SQLite database.
# Output: Immutable history and a durable single-region database identity.
# Pos: [Map](../../L2.md); collector storage and legacy database adoption.
# Effects/Dependencies: SQLite transactions and compressed content-addressed payloads.
import gzip
import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager

CONTRACT = 'haneoka:ranking-observation/2'

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def decode_payload(digest, compressed):
    raw=gzip.decompress(compressed)
    if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('payload checksum mismatch')
    body=json.loads(raw)
    if not isinstance(body,dict) or not isinstance(body.get('players'),list) or len(body['players'])>100:
        raise ValueError('invalid stored ranking payload')
    return body

class History:
    def __init__(self, path, read_only=False, region=None):
        self.path = str(path)
        self.read_only = read_only
        self.region = region
        if read_only:
            if region is not None:
                self.assert_region(region)
            return
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS payloads(hash TEXT PRIMARY KEY, body BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS observations(
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
              region TEXT NOT NULL, event_id TEXT NOT NULL, board_kind TEXT NOT NULL,
              challenge_id TEXT NOT NULL, observed_ms INTEGER NOT NULL,
              payload_hash TEXT REFERENCES payloads(hash), receipt BLOB, error TEXT);
            CREATE INDEX IF NOT EXISTS board_observations ON observations(
              region,event_id,board_kind,challenge_id,sequence);
            CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS collector_identity(
              id INTEGER PRIMARY KEY CHECK(id=1), region TEXT NOT NULL);
            ''')
        if region is not None:
            self.bind_region(region)

    @contextmanager
    def connect(self):
        if self.read_only:
            from pathlib import Path
            db = sqlite3.connect(Path(self.path).resolve().as_uri()+'?mode=ro', uri=True, timeout=10)
        else:
            db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def _database_region(self, db, audit=False):
        from regions import region_config
        stored = None
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_identity'").fetchone():
            row = db.execute('SELECT region FROM collector_identity WHERE id=1').fetchone()
            stored = row[0] if row else None
        if stored is not None and not audit:
            region_config(stored)
            return stored
        values = {row[0] for row in db.execute('SELECT DISTINCT region FROM observations')}
        if stored is not None:
            values.add(stored)
        row = db.execute('SELECT body FROM catalog WHERE id=1').fetchone()
        if row:
            body = json.loads(row[0])
            if not isinstance(body, dict):
                raise ValueError('invalid stored catalog')
            values.add(body.get('region'))
        for value in values:
            region_config(value)
        if len(values) > 1:
            raise ValueError('database contains multiple ranking regions')
        return next(iter(values), None)

    def _check_region(self, db, region, audit=False):
        from regions import region_config
        region_config(region)
        if self.region is not None and self.region != region:
            raise ValueError('history region changed')
        stored = self._database_region(db, audit)
        if stored is not None and stored != region:
            raise ValueError('database region changed')

    def assert_region(self, region, audit=True):
        with self.connect() as db:
            self._check_region(db, region, audit)

    def bind_region(self, region):
        if self.read_only:
            raise ValueError('read-only history cannot bind a region')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._check_region(db, region, audit=True)
            db.execute('INSERT OR IGNORE INTO collector_identity VALUES(1,?)', (region,))
        self.region = region

    def _claim_region(self, db, region):
        self._check_region(db, region)
        db.execute('INSERT OR IGNORE INTO collector_identity VALUES(1,?)', (region,))
        self._check_region(db, region)

    def catalog(self, value=None):
        with self.connect() as db:
            if value is not None:
                db.execute('BEGIN IMMEDIATE')
                self._claim_region(db, value['region'])
                db.execute('INSERT INTO catalog VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
                           (json.dumps(value),))
            row = db.execute('SELECT body FROM catalog WHERE id=1').fetchone()
            body = json.loads(row[0]) if row else None
            if row:
                if not isinstance(body, dict):
                    raise ValueError('invalid stored catalog')
                self._check_region(db, body['region'])
            return body

    def record(self, identity, observation_id, observed_ms, body=None, receipt=None, error=None):
        region, event, kind, challenge = identity
        if region not in ('jp','tw','en','kr') or not event.isdecimal() or kind not in ('challenge', 'total', 'point'):
            raise ValueError('invalid board identity')
        if (kind != 'challenge' and challenge) or (kind == 'challenge' and not challenge.isdecimal()):
            raise ValueError('invalid challenge identity')
        if (body is None) == (error is None):
            raise ValueError('exactly one of payload and failure required')
        raw = canonical(body) if body is not None else None
        digest = hashlib.sha256(raw).hexdigest() if raw is not None else None
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._claim_region(db, region)
            existing = db.execute('SELECT * FROM observations WHERE id=?', (observation_id,)).fetchone()
            if existing:
                expected = (region,event,kind,challenge,observed_ms,digest,error)
                actual = tuple(existing[k] for k in ('region','event_id','board_kind','challenge_id','observed_ms','payload_hash','error'))
                if actual != expected:
                    raise ValueError('observation identity conflict')
                return existing['sequence']
            if raw is not None:
                db.execute('INSERT OR IGNORE INTO payloads VALUES(?,?)', (digest,gzip.compress(raw,mtime=0)))
            cursor = db.execute('''INSERT INTO observations
              (id,region,event_id,board_kind,challenge_id,observed_ms,payload_hash,receipt,error)
              VALUES(?,?,?,?,?,?,?,?,?)''', (observation_id,region,event,kind,challenge,observed_ms,digest,
                  gzip.compress(canonical(receipt),mtime=0) if receipt else None,error))
            return cursor.lastrowid

    def read(self, identity, after=None):
        with self.connect() as db:
            self._check_region(db, identity[0])
            query = '''SELECT o.*,p.body FROM observations o LEFT JOIN payloads p ON p.hash=o.payload_hash
              WHERE region=? AND event_id=? AND board_kind=? AND challenge_id=?'''
            if after is None:
                rows = db.execute(query+' AND error IS NULL ORDER BY sequence DESC LIMIT 1', identity).fetchall()
            else:
                rows = db.execute(query+' AND sequence>? ORDER BY sequence LIMIT 100', (*identity,after)).fetchall()
            result=[]
            for row in rows:
                if (row['payload_hash'] is None)==(row['error'] is None):
                    raise ValueError('observation payload status mismatch')
                if row['payload_hash'] is not None and row['body'] is None:
                    raise ValueError('observation payload is missing')
                body=None
                if row['body'] is not None:
                    body=decode_payload(row['payload_hash'],row['body'])
                age=time.time()*1000-row['observed_ms']
                result.append(dict(contract=CONTRACT, snapshotId=row['id'], cursor=row['sequence'],
                    region=row['region'],eventId=row['event_id'],boardKind=row['board_kind'],
                    challengeId=row['challenge_id'] or None, observedAtMs=row['observed_ms'],
                    sourceFetchedAtMs=None,timeBasis='collector_received',source='official-game',
                    payloadHash=row['payload_hash'],error=row['error'],
                    stale=age<0 or age>600000,positionSource='responseOrder',
                    coverage={'limit':100,'returned':len(body['players']) if body else 0},
                    provenance=body.get('provenance') if body else None,
                    players=body['players'] if body else []))
            return result
