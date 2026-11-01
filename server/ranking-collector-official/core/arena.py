"""L3: server/L2.md; live/final Arena and event point windows and resumable, freshly witnessed population counts."""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import time
import uuid

from google.protobuf import json_format


class ArenaDeferred(Exception):
    pass


class ArenaChanged(Exception):
    pass


class ArenaStopped(Exception):
    def __init__(self, status, failure, retry_after=None):
        self.status, self.failure, self.retry_after = status, failure, retry_after


def witnessed_counts(window, thresholds):
    rows, start, maximum = window['players'], window['startRank'], window['maxRank']
    for index, threshold in enumerate(thresholds):
        if threshold == 0:
            yield index, maximum, None
            continue
        below = next((offset for offset, row in enumerate(rows) if row['point'] < threshold), len(rows))
        if 0 < below < len(rows):
            yield index, start - 1 + below, None
        elif below == 0 and start == 1:
            yield index, 0, maximum if not rows else None
        elif rows and below == len(rows) and start + len(rows) - 1 == maximum:
            yield index, maximum, maximum


class EventWindows:
    """Event point ranks past the top board, read in windows of 100."""

    def __init__(self, job, catalog, sampler, updates, deadline, provenance):
        self.job, self.catalog, self.sampler, self.updates = job, catalog, sampler, updates
        self.deadline = min(time.time() + 25, deadline)
        self.provenance = provenance

    def run(self):
        """Reads the requested windows; a refused read ends them and is returned for the caller to judge."""
        event = self.catalog['event']
        for demand in self.job.get('eventWindows', [])[:20]:
            start = demand['startRank']
            if (time.time() + 3 >= self.deadline or demand['eventId'] != event['id']
                    or type(start) is not int or start < 1 or (start - 1) % 100 != 0):
                continue
            receipt = self.window(event['id'], start)
            if receipt is not None:
                return receipt
        return None

    def window(self, event_id, start):
        end = start + 99
        snapshot = uuid.uuid4().hex
        observation = dict(snapshotId=snapshot, region=self.job['region'], eventId=event_id,
                           startRank=start, endRank=end, observedAtMs=int(time.time() * 1000))
        self.updates.send('attempt', snapshotId=snapshot)
        receipt, refused = None, None
        try:
            request = self.sampler.message('app.event.GetRankingListRequest',
                                           dict(event_id=event_id, ranks=list(range(start, end + 1))))
            receipt, response, _ = self.sampler.rpc('/app.event.EventService/GetRankingList', request,
                                                    'app.event.GetRankingListResponse', snapshot)
            observation['observedAtMs'] = int(datetime.fromisoformat(receipt['received_at']).timestamp() * 1000)
            if response is None:
                raise RuntimeError('event window rejected')
            body = json_format.MessageToDict(response, preserving_proto_field_name=True)
            rows = sorted(body.get('ranking', []), key=lambda row: row.get('rank', 0))
            if len(rows) > 100 or any(not start <= row.get('rank', 0) <= end for row in rows):
                raise ValueError('invalid event window')
            for row in rows:
                row.setdefault('point', 0)
            # Ties can leave the last few ranks of a full window unused.
            if rows and rows[-1]['rank'] > end - 10:
                maximum = None
            else:
                maximum = rows[-1]['rank'] if rows else start - 1
            observation.update(players=rows, maxRank=maximum, provenance=self.provenance())
        except Exception as error:
            observation.update(error=type(error).__name__,
                               httpStatus=receipt.get('status') if receipt else None,
                               grpcStatus=receipt.get('grpc_status') if receipt else None)
            refused = receipt or dict(status=None, grpc_status=None)
        self.updates.send('event-window', observation=observation)
        return refused


class ArenaCollector:
    def __init__(self, job, catalog, sampler, updates, deadline, failure_status, failure_info, retry_delay):
        self.job, self.catalog, self.sampler, self.updates = job, catalog, sampler, updates
        self.deadline = deadline
        self.arena = catalog['arena']
        self.capabilities = set(job.get('capabilities', []))
        self.failure_status, self.failure_info, self.retry_delay = failure_status, failure_info, retry_delay
        self.windows = {}
        self.maxima = {}
        self.stage = 'arena_board'
        self.band = None
        self.thresholds, self.counts = [], []
        self.verified, self.eof = set(), {}
        self.pending = None
        self.cursor = 0
        self.published = False
        self.descriptor_digest = hashlib.sha256(Path(self.sampler.args.descriptors).read_bytes()).hexdigest()

    def active(self):
        if self.job.get('finalArena') is not None:
            return time.time() * 1000 >= self.arena['rankingEndAtMs']
        return self.arena['startAtMs'] <= time.time() * 1000 < self.arena['rankingEndAtMs']

    def room(self):
        if not self.active() or time.time() + 3 >= self.deadline:
            raise ArenaDeferred()

    def window(self, band, start=1, refresh=False):
        key = (band, start)
        if key in self.windows and not refresh:
            return self.windows[key]
        self.room()
        snapshot = uuid.uuid4().hex
        observation = dict(snapshotId=snapshot, region=self.job['region'], seasonId=self.arena['seasonId'],
                           bandId=band, startRank=start, endRank=start + 99,
                           observedAtMs=int(time.time() * 1000))
        self.stage = 'attempt_callback'
        self.updates.send('attempt', snapshotId=snapshot)
        receipt, response, stopped = None, None, None
        self.stage = 'arena_board'
        try:
            request = self.sampler.message('app.arena.ArenaRankingRequest', dict(
                arena_season_id=self.arena['seasonId'], band_id=band, ranking_start=start, ranking_end=start + 99))
            receipt, response, _ = self.sampler.rpc('/app.arena.ArenaService/ArenaRanking', request,
                'app.arena.ArenaRankingResponse', snapshot)
            observation['observedAtMs'] = int(datetime.fromisoformat(receipt['received_at']).timestamp() * 1000)
            if response is None:
                raise RuntimeError('Arena request rejected')
            body = json_format.MessageToDict(response, preserving_proto_field_name=True)
            rows, maximum = body.get('ranking', []), int(body.get('max_rank', 0))
            if not 0 <= maximum <= 9007199254740991 or len(rows) > 100:
                raise ValueError('invalid Arena window')
            for row in rows:
                row.setdefault('point', 0)
                if type(row['point']) is not int or row['point'] < 0:
                    raise ValueError('invalid Arena points')
            if any(left['point'] < right['point'] for left, right in zip(rows, rows[1:])):
                raise ValueError('unordered Arena points')
            if (rows and (maximum == 0 or start + len(rows) - 1 > maximum)
                    or len(rows) != min(100, max(0, maximum - start + 1))):
                raise ValueError('incomplete Arena window')
            if len(json.dumps(rows, ensure_ascii=False).encode()) > 7 * 1024 * 1024:
                raise ValueError('Arena payload too large')
            observation.update(players=rows, maxRank=maximum, provenance=self.provenance())
        except Exception as error:
            status = self.failure_status(receipt)
            if self.job.get('finalArena') is not None and receipt and (receipt.get('status') == 403 or str(receipt.get('grpc_status')) == '7'):
                status = 'failed'
            observation.update(error='authentication_failed' if status == 'auth_paused' else type(error).__name__,
                               httpStatus=receipt.get('status') if receipt else None,
                               grpcStatus=receipt.get('grpc_status') if receipt else None)
            retry = self.retry_delay(receipt, 300) if status == 'rate_limited' else None
            if retry is not None:
                observation['retryAfterSeconds'] = retry
            stopped = ArenaStopped(status, self.failure_info('arena_board', error, receipt), retry)
        self.stage = 'arena_observation_callback'
        self.updates.send('arena-observation', observation=observation)
        if stopped:
            raise stopped
        self.windows[key] = observation
        self.maxima[band] = observation['maxRank']
        if band == self.band:
            self.learn(observation)
        return observation

    def provenance(self):
        return dict(clientVersion=self.job['clientVersion'], masterVersion=self.sampler.master_version,
                    resourceVersion=self.sampler.resource_version, apiOrigin=self.sampler.origin,
                    catalogSource='official-master', catalogTableHashes=self.catalog.get('tableHashes'),
                    descriptorSha256=self.descriptor_digest)

    def top(self):
        try:
            if self.job.get('finalArena') is not None:
                for demand in self.job.get('arenaWindows', []):
                    self.window(demand['bandId'], demand['startRank'])
                return
            if 'arena-demand-v1' in self.capabilities:
                demand_deadline = min(time.time() + 40, self.deadline - 22)
                plan = self.population_plan() if 'arena-population-v1' in self.capabilities else None
                previous = plan[-1] if plan else None
                if previous and all(value is not None for value in previous['counts']):
                    pages = {1 + (position - 1) // 100 * 100 for count in previous['counts']
                        for position in (count, count + 1) if 0 < position <= previous['maxRank']}
                    demand_deadline = min(demand_deadline, self.deadline - 22 - 2 * len(pages - {1}))
                for demand in self.job.get('arenaWindows', [])[:20]:
                    if time.time() + 2 >= demand_deadline:
                        break
                    if (demand['seasonId'] == self.arena['seasonId'] and demand['bandId'] in self.arena['bandIds']
                            and type(demand['startRank']) is int and demand['startRank'] > 0
                            and (demand['startRank'] - 1) % 100 == 0 and demand['endRank'] == demand['startRank'] + 99):
                        self.window(demand['bandId'], demand['startRank'])
            for band in self.arena['bandIds']:
                self.window(band)
        except ArenaDeferred:
            pass

    def point(self, position):
        if position < 1:
            raise ArenaChanged()
        window = self.window(self.band, 1 + (position - 1) // 100 * 100)
        offset = position - window['startRank']
        if offset >= len(window['players']):
            raise ArenaChanged()
        return window['players'][offset]['point']

    def remember(self, index, count, eof=None):
        self.counts[index] = count
        self.verified.add(index)
        if eof is None:
            self.eof.pop(index, None)
        else:
            self.eof[index] = eof

    def learn(self, window):
        for index, count, eof in witnessed_counts(window, self.thresholds):
            self.remember(index, count, eof)

    def witness(self, index, count):
        threshold, maximum = self.thresholds[index], self.maxima[self.band]
        if threshold == 0:
            self.remember(index, maximum)
            return True
        if not 0 <= count <= maximum:
            return False
        above = count == 0 or self.point(count) >= threshold
        maximum = self.maxima[self.band]
        below = count == maximum or count < maximum and self.point(count + 1) < threshold
        if above and below:
            self.remember(index, count, maximum if count == maximum else None)
            return True
        return False

    def solve(self, index, old_pending):
        threshold, maximum = self.thresholds[index], self.maxima[self.band]
        lower = max((self.counts[i] for i in self.verified if i > index), default=0)
        upper = min((self.counts[i] for i in self.verified if i < index), default=maximum)
        if old_pending and old_pending.get('index') == index:
            neighbor_upper = upper
            lower = min(maximum, max(lower, old_pending['low']))
            upper = min(upper, old_pending['high'])
            if old_pending['high'] == old_pending.get('maxRank', maximum):
                upper = neighbor_upper
            if lower > 0 and self.point(lower) < threshold:
                upper, lower = lower - 1, 0
            if upper < maximum and self.point(upper + 1) >= threshold:
                lower, upper = upper + 1, maximum
        if lower > upper:
            lower, upper = 0, maximum
        if index in self.verified:
            self.pending = None
            return
        while lower < upper:
            before = (lower, upper)
            self.pending = dict(index=index, low=lower, high=upper)
            position = (lower + upper + 1) // 2
            window = self.window(self.band, 1 + (position - 1) // 100 * 100)
            if index in self.verified:
                self.pending = None
                return
            if window['players'] and window['players'][0]['point'] < threshold:
                upper = min(upper, window['startRank'] - 1)
            else:
                lower = max(lower, window['startRank'] - 1 + len(window['players']))
            if lower > upper:
                raise ArenaChanged()
            if (lower, upper) == before:
                raise ArenaChanged()
        self.pending = dict(index=index, low=lower, high=upper)
        if not self.witness(index, lower):
            raise ArenaChanged()
        self.pending = None

    def progress(self):
        maximum = self.maxima.get(self.band, 0)
        counts = [value if value is not None and value <= maximum else None for value in self.counts]
        pending = self.pending
        if pending:
            pending = dict(index=pending['index'], low=min(pending['low'], maximum), high=min(pending['high'], maximum))
        cursor = pending['index'] if pending else next((i for i in range(len(counts)) if i not in self.verified or counts[i] is None), len(counts))
        if cursor == len(counts) and not self.published:
            cursor = 0
        return dict(seasonId=self.arena['seasonId'], bandId=self.band, thresholds=self.thresholds,
                    maxRank=maximum, counts=counts, cursor=cursor, **({'pending': pending} if pending else {}))

    def population_plan(self):
        candidates = []
        for band in self.arena['bandIds']:
            if self.job.get('finalArena') is not None and band not in self.job['finalPopulationBands']:
                continue
            thresholds = self.arena['thresholdsByBand'][band]
            if not thresholds:
                continue
            progress = self.job.get('arenaProgress', []) if 'arena-progress-v1' in self.capabilities else []
            previous = next((entry for entry in progress if entry.get('seasonId') == self.arena['seasonId']
                and entry.get('bandId') == band and entry.get('thresholds') == thresholds), None)
            unfinished = previous is None or previous.get('cursor', 0) < len(thresholds) or any(value is None for value in previous.get('counts', []))
            candidates.append((not unfinished, previous.get('updatedAtMs', 0) if previous else 0, int(band), band, thresholds, previous))
        return min(candidates) if candidates else None

    def population(self):
        if 'arena-population-v1' not in self.capabilities:
            return
        plan = self.population_plan()
        if not plan:
            return
        _, _, _, self.band, self.thresholds, previous = plan
        self.counts = list(previous['counts']) if previous else [None] * len(self.thresholds)
        self.verified, self.eof = set(), {}
        self.pending = None
        self.published = False
        save_progress = False
        try:
            head = self.window(self.band)
            self.learn(head)
            for (band, _), window in list(self.windows.items()):
                if band == self.band:
                    self.learn(window)
            if self.maxima[self.band] == 0:
                for index in range(len(self.thresholds)):
                    self.remember(index, 0, 0)
            order = []
            def divide(low, high):
                if low > high:
                    return
                middle = (low + high) // 2
                order.append(middle)
                divide(low, middle - 1)
                divide(middle + 1, high)
            divide(0, len(self.thresholds) - 1)
            old_pending = dict(previous['pending'], maxRank=previous['maxRank']) if previous and previous.get('pending') else None
            if old_pending:
                order.remove(old_pending['index'])
                order.insert(0, old_pending['index'])
            for index in order:
                if index in self.verified:
                    continue
                self.cursor = index
                value = self.counts[index]
                if value is not None and (self.witness(index, value) or index in self.verified):
                    continue
                self.counts[index] = None
                self.solve(index, old_pending)
            maximum = self.maxima[self.band]
            for index, threshold in enumerate(self.thresholds):
                if threshold == 0:
                    self.remember(index, maximum)
            invalid = [index for index, endpoint in self.eof.items() if endpoint != maximum]
            if invalid or any(value is None or value > maximum for value in self.counts) or any(
                    left < right for left, right in zip(self.counts, self.counts[1:])):
                for index in invalid:
                    self.verified.discard(index)
                raise ArenaChanged()
            observed = min(window['observedAtMs'] for (band, _), window in self.windows.items() if band == self.band)
            self.stage = 'arena_population_callback'
            self.updates.send('arena-population', observation=dict(snapshotId=uuid.uuid4().hex, region=self.job['region'],
                seasonId=self.arena['seasonId'], bandId=self.band, observedAtMs=observed, maxRank=maximum,
                atLeast=[dict(threshold=threshold, count=count) for threshold, count in zip(self.thresholds, self.counts)],
                provenance=dict(self.provenance(), sourceThreshold='MasterArenaRank._lp')))
            self.published = True
            save_progress = True
        except (ArenaDeferred, ArenaChanged):
            save_progress = True
        finally:
            if save_progress and self.band in self.maxima and 'arena-progress-v1' in self.capabilities:
                self.stage = 'arena_progress_callback'
                self.updates.send('arena-progress', checkpointId=uuid.uuid4().hex, progress=self.progress())
