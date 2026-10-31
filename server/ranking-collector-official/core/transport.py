"""L3: server/L2.md -> ranking-collector-official; regional read-only RPCs bound to the selected official API origin."""
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import re
import time
import uuid
from google.protobuf import descriptor_pb2, descriptor_pool, json_format, message_factory
from http2 import post
from lifecycle import read_credentials
from regions import select_api_origin

VERSION = '/app.masterdata.MasterdataService/Version'
SERVERS = '/app.playerlogin.PlayerLoginService/GetServerList'
ANONYMOUS = {VERSION, SERVERS}
ALLOWED = {VERSION, SERVERS, '/app.event.EventService/GetChallengeMusicRanking', '/app.event.EventService/GetChallengeMusicTotalRanking',
           '/app.event.EventService/GetRankingList',
           '/app.arena.ArenaService/ArenaRanking', '/app.friend.FriendService/FindByProfileID',
           '/app.player.PlayerService/GetPlayerFavoriteStatus', '/app.livemusic.LiveMusicService/GetRanking'}


class VersionError(RuntimeError):
    def __init__(self, receipt):
        headers={k.lower():v for k,v in receipt.get('headers',{}).items()}
        trailers={k.lower():v for k,v in receipt.get('trailers',{}).items()}
        self.receipt={'status':receipt.get('status'),'grpc_status':receipt.get('grpc_status'),
                      'error_type':receipt.get('error_type'),
                      'headers':{'retry-after':headers.get('retry-after') or trailers.get('retry-after','')}}
        super().__init__('Anonymous Version failed: HTTP=%s gRPC=%s' %
                         (self.receipt['status'],self.receipt['grpc_status']))

def pool_from_file(path):
    descriptor_set = descriptor_pb2.FileDescriptorSet.FromString(path.read_bytes())
    pool = descriptor_pool.DescriptorPool()
    pending = list(descriptor_set.file)
    while pending:
        remaining = []
        for file in pending:
            try:
                pool.Add(file)
            except TypeError:
                remaining.append(file)
        if len(remaining) == len(pending):
            raise ValueError('Unresolved descriptor dependencies: ' + ', '.join(f.name for f in remaining))
        pending = remaining
    return pool

def frame(payload):
    return b'\0' + len(payload).to_bytes(4, 'big') + payload

def unframe(raw):
    if len(raw) < 5 or raw[0] != 0:
        raise ValueError('Missing or unsupported gRPC frame')
    length = int.from_bytes(raw[1:5], 'big')
    if length != len(raw) - 5:
        raise ValueError('Truncated or multiple gRPC frames')
    return raw[5:]

class Sampler:
    def __init__(self, args):
        self.args = args
        self.region = getattr(args, "region", "jp")
        self.origin = select_api_origin(self.region, getattr(args, 'api_origin', None))
        self.resource_version = None
        self.pool = pool_from_file(args.descriptors)
        self.run_id = uuid.uuid4().hex
        self.output = args.output / self.run_id
        self.output.mkdir(parents=True)
        self.master_version = None
        self.last_request = None
        self.cdn = None

    def check_control(self):
        stop_file=getattr(self.args,'stop_file',None)
        deadline=getattr(self.args,'deadline',None)
        if (stop_file is not None and Path(stop_file).exists()) or (deadline is not None and time.time()>=deadline):
            raise InterruptedError('Collector stopped')

    def wait(self, seconds):
        until=time.monotonic()+max(0,seconds)
        while True:
            self.check_control()
            remaining=until-time.monotonic()
            if remaining<=0:return
            time.sleep(min(.2,remaining))

    def message(self, name, data=None):
        message = message_factory.GetMessageClass(self.pool.FindMessageTypeByName(name))()
        if data:
            json_format.ParseDict(data, message)
        return message

    def headers(self, name):
        self.check_control()
        headers = [('te', 'trailers'), ('x-client-version', self.args.client_version),
                   ('x-platform', 'android'), ('x-request-id', str(uuid.uuid4()))]
        if name not in ANONYMOUS:
            if not self.master_version:
                raise ValueError('Missing verified master version')
            if self.region!='jp' and not self.resource_version:
                raise ValueError('Missing verified resource version')
            identity, _, auth = read_credentials(self.args.credentials, self.region)
            if identity != self.args.credential_identity:
                raise ValueError('Collector account changed')
            if auth['origin'] != self.origin:
                raise ValueError('Collector API origin changed')
            headers.extend([('x-player-id', auth['player_id']), ('x-player-credential', auth['credential']),
                            ('x-master-version', self.master_version)])
            if self.region!='jp':
                headers.append(('x-resource-version', self.resource_version))
                if auth.get('bid'):headers.append(('x-player-bid', auth['bid']))
            if auth.get('device_id'):
                headers.append(('x-device-id', auth['device_id']))
        for _, value in headers:
            if not isinstance(value, str) or any(ord(char) < 32 or ord(char) > 126 for char in value):
                raise ValueError('Invalid RPC header')
        return headers

    def rpc(self, name, request, response_name, label, include_cdn=False):
        if name not in ALLOWED:
            raise ValueError('Unsupported read operation')
        if not re.fullmatch(r'\d+\.\d+\.\d+', self.args.client_version):
            raise ValueError('Invalid client version')
        self.check_control()
        rpc_deadline = time.monotonic() + 20
        if self.last_request is not None:
            self.wait(2 - (time.monotonic() - self.last_request))
        body = frame(request.SerializeToString())
        include_cdn = include_cdn and name == VERSION and self.region == 'jp'
        self.cdn = None
        for attempt in range(1, 4):
            self.check_control()
            attempt_label = label if attempt == 1 else f'{label}-attempt-{attempt}'
            response_file = self.output / (attempt_label + '-response.json')
            self.last_request = time.monotonic()
            started_at = datetime.now(timezone.utc).isoformat()
            started = time.monotonic()
            wire = post(name, body, lambda: self.headers(name), proxy=self.args.proxy,
                connect_ip=getattr(self.args, 'connect_ip', None), timeout=rpc_deadline-started,
                check_control=self.check_control, include_cdn=include_cdn, region=self.region, api_origin=self.origin)
            self.cdn = wire['cdn'] if include_cdn else None
            receipt = dict(started_at=started_at, received_at=datetime.now(timezone.utc).isoformat(),
                origin=self.origin, path=name, client_version=self.args.client_version,
                authenticated=name not in ANONYMOUS, transport='Python h2', runtime='Python '+platform.python_version(),
                proxy=self.args.proxy, connect_ip=getattr(self.args, 'connect_ip', None),
                elapsed_ms=round((time.monotonic()-started)*1000), status=wire['status'],
                http_version=wire.get('http_version'), headers=wire['headers'], trailers=wire['trailers'],
                bytes=len(wire['body']), body_base64=base64.b64encode(wire['body']).decode())
            if wire.get('error_type'):
                receipt['error_type'] = wire['error_type']
            response_file.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
            # Retry only transport failures before an HTTP response; HTTP/gRPC failures stop.
            if receipt.get('status') is not None or not receipt.get('error_type') or attempt == 3:
                break
            if rpc_deadline-time.monotonic() <= 5*attempt:
                break
            print(json.dumps({'operation': label, 'transport_attempt': attempt, 'retry_after_seconds': 5 * attempt}), flush=True)
            self.wait(5 * attempt)
        headers = {k.lower(): v for k, v in receipt['headers'].items()}
        trailers = {k.lower(): v for k, v in receipt['trailers'].items()}
        status = trailers.get('grpc-status', headers.get('grpc-status'))
        receipt['grpc_status'] = status
        if receipt.get('error_type') or receipt.get('status') != 200 or status != '0':
            return receipt, None, response_file
        response = self.message(response_name)
        response.ParseFromString(unframe(wire['body']))
        return receipt, response, response_file

    def version(self, include_cdn=False):
        receipt, response, path = self.rpc(VERSION, self.message('app.masterdata.VersionRequest'),
                                          'app.masterdata.VersionResponse', 'version', include_cdn=include_cdn)
        if response is None or not response.version:
            raise VersionError(receipt)
        self.master_version = response.version
        self.resource_version = getattr(response, "resource_version", None)
        return {'master_version': self.master_version, 'receipt': str(path),
                'http_status': receipt['status'], 'grpc_status': receipt['grpc_status']}
