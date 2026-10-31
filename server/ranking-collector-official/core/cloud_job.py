# L3 — GEB
# Input: A bounded region job, private credentials and authenticated durable callbacks.
# Output: Official catalog and immutable board observations acknowledged by the Worker.
# Pos: [Map](../../L2.md); cloud adapter for the shared official protocol.
# Effects/Dependencies: Official HTTPS/HTTP2 reads, temporary private files and Worker callbacks; no local history authority.
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from types import SimpleNamespace
from urllib.request import build_opener, ProxyHandler, Request
from urllib.error import HTTPError
from urllib.parse import urlsplit
import uuid

from lifecycle import authentication_failed, board_call, board_players, read_credentials, targets, retry_delay
from official_catalog import OfficialCatalog, CatalogRequestError, NoRedirect
from regions import region_config
from transport import Sampler, VersionError
from arena import ArenaCollector, ArenaStopped
from demand import Demand


class CallbackError(RuntimeError):
    def __init__(self,message,receipt=None):
        self.receipt=receipt or {}
        self.failure=None
        super().__init__(message)


def failure_info(stage, error, receipt=None):
    receipt=receipt or {}
    names={'TimeoutError','SSLError','SSLCertVerificationError','OSError','URLError','gaierror',
           'ValueError','RuntimeError','VersionError','CatalogRequestError','CallbackError',
           'ImportError','ModuleNotFoundError','FileNotFoundError','PermissionError','JSONDecodeError',
           'ConnectionError','ConnectionRefusedError','ConnectionResetError','ProtocolError','H2Error'}
    code=receipt.get('error_type') or type(error).__name__
    result={'stage':stage,'code':code if code in names else 'Error'}
    status=receipt.get('status')
    if type(status) is int and 100<=status<=599:result['httpStatus']=status
    grpc=str(receipt.get('grpc_status',''))
    if re.fullmatch(r'[0-9]{1,3}',grpc):result['grpcStatus']=grpc
    return result


def report_failure(region, failure):
    print(json.dumps(dict(event='official_ranking_job_failed',region=region,**failure)),flush=True)


def callback_url(job, origin):
    value = job['callbackUrl']
    url, allowed = urlsplit(value), urlsplit(origin)
    local = allowed.scheme == 'http' and allowed.hostname in ('127.0.0.1', 'localhost', '::1')
    if (allowed.scheme != 'https' and not local) or allowed.username or allowed.password:
        raise ValueError('invalid callback origin')
    if (url.scheme, url.netloc) != (allowed.scheme, allowed.netloc):
        raise ValueError('invalid callback origin')
    expected = '/api/internal/official-rankings/%s/%s' % (job['region'], job['runId'])
    if url.path != expected or url.query or url.fragment or url.username or url.password:
        raise ValueError('invalid callback path')
    return value


class Updates:
    def __init__(self, job, origin):
        self.url = callback_url(job, origin)
        self.token = job['callbackToken']
        self.deadline = job['deadlineMs'] / 1000
        self.base = {key: job[key] for key in ('region', 'runId', 'credentialGeneration')}
        self.base['contract'] = 'haneoka:official-ranking-update/1'
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def send(self, kind, **fields):
        raw = json.dumps(dict(self.base, type=kind, **fields), ensure_ascii=False).encode()
        request = Request(self.url, data=raw, method='POST', headers={
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'User-Agent': 'Haneoka-Official-Ranking-Collector/1.0 (+https://haneoka.org)',
            'Authorization': 'Bearer ' + self.token})
        receipt = None
        for attempt in range(3):
            remaining = self.deadline - time.time()
            if remaining <= 0:
                raise CallbackError('callback deadline')
            try:
                with self.opener.open(request, timeout=min(5, remaining)) as response:
                    if response.status != 200:
                        raise CallbackError('callback rejected',{'status':response.status})
                return
            except HTTPError as error:
                status = error.code
                receipt = {'status':status}
                error.close()
                if status < 500 and status != 429:
                    raise CallbackError('callback rejected',receipt) from None
            except CallbackError:
                raise
            except Exception as error:
                receipt = {'error_type':type(error).__name__}
            if attempt < 2:
                remaining = self.deadline - time.time()
                if remaining > 0:
                    time.sleep(min(.25 * (attempt + 1), remaining))
        raise CallbackError('callback unavailable',receipt)


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream)


def failure_status(receipt, authenticated=True):
    receipt = receipt or {}
    if receipt.get('status') == 429 or str(receipt.get('grpc_status')) == '8':
        return 'rate_limited'
    if authenticated and (authentication_failed(receipt) or receipt.get('status') == 403 or str(receipt.get('grpc_status')) == '7'):
        return 'auth_paused'
    return 'failed'


def validate_job(job):
    if not isinstance(job, dict) or job.get('contract') != 'haneoka:official-ranking-job/1':
        raise ValueError('invalid job contract')
    region_config(job.get('region'))
    for key in ('runId', 'credentialGeneration', 'callbackToken'):
        value = job.get(key)
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', value):
            raise ValueError('invalid job identity')
    if not isinstance(job.get('clientVersion'), str) or not re.fullmatch(r'\d+\.\d+\.\d+', job['clientVersion']):
        raise ValueError('invalid client version')
    deadline = job.get('deadlineMs')
    if type(deadline) is not int or not time.time() * 1000 < deadline <= time.time() * 1000 + 125_000:
        raise ValueError('invalid job deadline')
    if not isinstance(job.get('credentials'), dict) or not isinstance(job.get('masterConfig'), dict):
        raise ValueError('private configuration missing')
    capabilities = job.get('capabilities', [])
    if not isinstance(capabilities, list) or len(capabilities) > 16 or any(not isinstance(value, str) for value in capabilities):
        raise ValueError('invalid capabilities')


def run_job(job, origin):
    validate_job(job)
    updates = Updates(job, origin)
    region = job['region']
    configured = region_config(region)
    final_status = 'ok'
    retry_after = None
    failure = None
    stage = 'catalog'
    arena_collector = None
    include_arena = 'arena-ranking-v1' in job.get('capabilities', [])
    with tempfile.TemporaryDirectory(prefix='official-ranking-') as temporary:
        root = Path(temporary)
        os.chmod(root, 0o700)
        credentials = root / 'credentials.json'
        master_config = root / 'master.json'
        private_json(credentials, job['credentials'])
        private_json(master_config, job['masterConfig'])
        identity, _, auth = read_credentials(credentials, region)
        deadline = job['deadlineMs'] / 1000 - (12 if include_arena else 2)
        try:
            provider = OfficialCatalog(master_config, root, '', job['clientVersion'], deadline=deadline,
                                      region=region, api_origin=auth['origin'], include_arena=include_arena)
            catalog = provider()
            stage = 'catalog_callback'
            updates.send('catalog', catalog=catalog)
            boards = targets(catalog, int(time.time() * 1000))
            arena_active = include_arena and catalog.get('arena') is not None
            if boards or arena_active:
                sampler = Sampler(SimpleNamespace(region=region, descriptors=Path(__file__).parent/configured.descriptor,
                    output=root/'receipts', client_version=job['clientVersion'], proxy='', connect_ip=None,
                    credentials=credentials, credential_identity=identity, stop_file=None, deadline=deadline,
                    api_origin=auth['origin']))
                if include_arena:
                    sampler.last_request = provider.last_request
                stage = 'version'
                sampler.version()
                if (catalog['masterVersion'] != sampler.master_version
                        or catalog.get('resourceVersion') != sampler.resource_version
                        or catalog['apiOrigin'] != sampler.origin):
                    raise RuntimeError('catalog version changed')
                if arena_active:
                    arena_collector = ArenaCollector(job, catalog, sampler, updates, deadline,
                        failure_status, failure_info, retry_delay)
                    stage = 'arena_board'
                    arena_collector.top()
                for kind, challenge in boards:
                    if (kind, challenge) not in targets(catalog, int(time.time() * 1000)):
                        continue
                    if time.time() >= deadline:
                        if not include_arena:
                            final_status = 'failed'
                            failure = failure_info('board',TimeoutError())
                        break
                    snapshot = uuid.uuid4().hex
                    stage = 'attempt_callback'
                    updates.send('attempt', snapshotId=snapshot)
                    event = catalog['event']
                    observation = dict(snapshotId=snapshot, region=region, eventId=event['id'], kind=kind,
                                       challengeId=challenge, observedAtMs=int(time.time()*1000))
                    receipt = None
                    stage = 'board'
                    try:
                        window_end = event['endAtMs'] if kind != 'challenge' else next(
                            row['endAtMs'] for row in event['challenges'] if row['id'] == challenge)
                        sampler.args.deadline = min(deadline, window_end/1000 + event['aggregationSeconds'])
                        method, fields = board_call(kind, event, challenge)
                        request = sampler.message('app.event.' + method + 'Request', fields)
                        receipt, response, _ = sampler.rpc('/app.event.EventService/' + method, request,
                            'app.event.' + method + 'Response', snapshot)
                        observation['observedAtMs'] = int(datetime.fromisoformat(receipt['received_at']).timestamp()*1000)
                        if response is None:
                            raise RuntimeError('upstream rejected')
                        from google.protobuf import json_format
                        players = board_players(kind, json_format.MessageToDict(response, preserving_proto_field_name=True))
                        if len(players) > 100 or any(int(player.get('score', 0)) < 0 for player in players):
                            raise ValueError('invalid ranking payload')
                        for player in players:
                            player.setdefault('score', '0')
                        if len(json.dumps(players, ensure_ascii=False).encode()) > 7 * 1024 * 1024:
                            raise ValueError('ranking payload too large')
                        observation['players'] = players
                        observation['provenance'] = dict(clientVersion=job['clientVersion'],
                            masterVersion=sampler.master_version, resourceVersion=sampler.resource_version,
                            apiOrigin=sampler.origin, catalogSource='official-master',
                            catalogTableHashes=catalog.get('tableHashes'),
                            descriptorSha256=hashlib.sha256((Path(__file__).parent/configured.descriptor).read_bytes()).hexdigest())
                    except Exception as error:
                        observation['httpStatus'] = receipt.get('status') if receipt else None
                        observation['grpcStatus'] = receipt.get('grpc_status') if receipt else None
                        status = failure_status(receipt)
                        observation['error'] = 'authentication_failed' if status == 'auth_paused' else type(error).__name__
                        if status == 'rate_limited':
                            retry_after = retry_delay(receipt, 300)
                            observation['retryAfterSeconds'] = retry_after
                        final_status = status
                        failure = failure_info(stage,error,receipt)
                    finally:
                        sampler.args.deadline = deadline
                    stage = 'observation_callback'
                    updates.send('observation', observation=observation)
                    if final_status in ('auth_paused', 'rate_limited'):
                        break
                if final_status not in ('auth_paused', 'rate_limited') and 'player-demand-v1' in job.get('capabilities', []):
                    stage = 'demand'
                    stopped = Demand(job, sampler, updates, deadline).run()
                    # A refused read ends demand for this run; it says nothing about the account.
                    if stopped and failure_status(stopped) == 'rate_limited':
                        final_status, failure = 'rate_limited', failure_info(stage, RuntimeError('demand rejected'), stopped)
                        retry_after = retry_delay(stopped, 300)
                if arena_collector and final_status not in ('auth_paused', 'rate_limited'):
                    stage = 'arena_population_callback'
                    arena_collector.population()
        except ArenaStopped as error:
            final_status, failure, retry_after = error.status, error.failure, error.retry_after
        except CallbackError as error:
            error.failure=failure_info(arena_collector.stage if arena_collector and stage.startswith('arena_') else stage,error,error.receipt)
            report_failure(region,error.failure)
            raise
        except (CatalogRequestError, VersionError) as error:
            final_status = failure_status(error.receipt, authenticated=False)
            catalog_stages={'version':'catalog_version','server-list':'catalog_server_list',
                'MasterManifest.json':'catalog_manifest','MasterEvent.bin':'catalog_event',
                'MasterChallengeMusic.bin':'catalog_challenges','MasterParameter.bin':'catalog_parameters',
                'MasterArenaSeason.bin':'catalog_arena_season','MasterArenaLeague.bin':'catalog_arena_league',
                'MasterArenaRank.bin':'catalog_arena_rank'}
            failure = failure_info(catalog_stages.get(getattr(error,'stage',None),stage),error,error.receipt)
            if final_status == 'rate_limited':
                retry_after = retry_delay(error.receipt, 300)
        except Exception as error:
            final_status = 'failed'
            failure = failure_info(stage,error)
        fields = {'status': final_status}
        if failure is not None:
            fields['failure']=failure
            report_failure(region,failure)
        if retry_after is not None:
            fields['retryAfterSeconds'] = retry_after
        try:updates.send('complete', **fields)
        except CallbackError as error:
            error.failure=failure_info('complete_callback',error,error.receipt)
            report_failure(region,error.failure)
            raise
    return {'runId': job['runId'], 'status': final_status}
