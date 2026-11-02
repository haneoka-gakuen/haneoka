# L3 — GEB
# Input: Authenticated SDK/game phases or registered regional sessions with fresh catalog/version configuration.
# Output: Private verified SDK/role credentials for new and existing players, shared JP/Global readiness checks and body-free failure states.
# Pos: [Map](../../L2.md); Container account login and collection-permission verification.
# Effects/Dependencies: SDK authentication or game login/verification in separate phases; private temporary Master files, no password/session receipts.
from dataclasses import asdict
from pathlib import Path
import re
import tempfile
import time
import uuid

from google.protobuf import json_format, message_factory
from google.protobuf.message import DecodeError

from cloud_job import private_json
from http2 import post
from lifecycle import board_call, targets
from official_catalog import OfficialCatalog, CatalogRequestError
from platform_login import GlobalEmailLogin, SdkLoginError, SdkProfile, sdk_session
from player_login import GlobalPlayerProfile, PlayerLoginError, login_player
from regions import region_config, select_api_origin
from transport import frame, pool_from_file, unframe, VersionError


CONTRACT = 'haneoka:official-account-job/1'


def validate_account_job(job):
    if (not isinstance(job, dict) or job.get('contract') != CONTRACT
            or job.get('action') not in ('sdk','game')
            or job.get('region') not in ('tw', 'en', 'kr')
            or not isinstance(job.get('runId'), str) or not re.fullmatch('[a-f0-9]{32}', job['runId'])
            or type(job.get('deadlineMs')) is not int or not 0 < job['deadlineMs'] - time.time()*1000 <= 150000
            or not isinstance(job.get('apiOrigin'), str)
            or not isinstance(job.get('masterConfig'), dict) or not job['masterConfig']):
        raise ValueError('invalid_account_job')
    if job['action'] == 'sdk':
        if (not isinstance(job.get('email'), str) or not 0 < len(job['email']) <= 254
                or not isinstance(job.get('password'), str) or not 0 < len(job['password']) <= 1024):
            raise ValueError('invalid_account_job')
    elif 'email' in job or 'password' in job:
        raise ValueError('invalid_account_job')
    try:
        sdk = SdkProfile(**job['sdkProfile'])
        player = GlobalPlayerProfile(**job['playerProfile'])
    except (KeyError, TypeError):
        raise ValueError('invalid_account_profile') from None
    if (not isinstance(player.client_version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', player.client_version)
            or sdk.common_params['app_ver'] != player.client_version
            or any(not isinstance(value, str) or not value or len(value) > 256
                   for name, value in asdict(player).items() if name not in ('global_channel_id','brand_id','area_id','initial_data_group'))
            or any(type(value) is not int or not 0 <= value <= 0xffffffff
                   for value in (player.global_channel_id, player.brand_id, player.area_id))
            or not isinstance(player.initial_data_group, str) or len(player.initial_data_group) > 256):
        raise ValueError('invalid_account_profile')
    pin = job.get('expectedPlayerId')
    if pin is not None and (not isinstance(pin, str) or not pin or len(pin) > 128
                            or any(ord(c) < 32 or ord(c) > 126 for c in pin)):
        raise ValueError('invalid_player_pin')
    sdk_pin = job.get('expectedSdkUid')
    if sdk_pin is not None and (not isinstance(sdk_pin, str) or not 0 < len(sdk_pin) <= 4096
                                or any(not 32 <= ord(c) < 127 for c in sdk_pin)):
        raise ValueError('invalid_sdk_pin')
    cached = None
    if job.get('sdkSession') is not None:
        if not isinstance(job['sdkSession'], dict):
            raise ValueError('invalid_sdk_session')
        try:
            cached = sdk_session(job['sdkSession'])
        except SdkLoginError:
            raise ValueError('invalid_sdk_session') from None
        if sdk_pin is not None and cached.uid != sdk_pin:
            raise ValueError('sdk_identity_mismatch')
    select_api_origin(job['region'], job['apiOrigin'])
    if job['action'] == 'game' and (cached is None or sdk_pin is None):
        raise ValueError('unbound_game_job')
    return sdk, player, cached


def verification_boards(catalog, now):
    boards = []
    for kind, challenge in targets(catalog, now):
        method, fields = board_call(kind, catalog['event'], challenge)
        boards.append(('app.event.EventService', method, fields))
    arena = catalog.get('arena')
    if arena and arena['startAtMs'] <= now < arena['rankingEndAtMs'] and arena['bandIds']:
        for band in arena['bandIds']:
            boards.append(('app.arena.ArenaService', 'ArenaRanking', dict(arena_season_id=arena['seasonId'],
                band_id=band, ranking_start=1, ranking_end=100)))
    return boards


class AccountVerificationError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def verify_role(catalog, role, client_version, deadline):
    def remaining():
        left = deadline - time.time()
        if left <= 0:
            raise TimeoutError('account_deadline_exceeded')
        return min(20, left)

    def check_control():
        remaining()

    boards = verification_boards(catalog, int(time.time()*1000))
    if not boards:
        raise AccountVerificationError('verification_unavailable')
    pool = pool_from_file(Path(__file__).with_name(region_config(role.region).descriptor))
    last_request = time.monotonic()

    def rpc(service, method, fields, authenticated):
        nonlocal last_request
        descriptor = pool.FindServiceByName(service).methods_by_name[method]
        request = message_factory.GetMessageClass(descriptor.input_type)()
        json_format.ParseDict(fields, request)
        headers = [('te','trailers'),('x-platform','android'),('x-client-version',client_version),
            ('x-request-id',str(uuid.uuid4()))]
        if authenticated:
            headers.extend([('x-player-id',role.player_id),('x-player-credential',role.credential),
                ('x-master-version',catalog['masterVersion'])])
            if role.region != 'jp':
                headers.append(('x-resource-version',catalog['resourceVersion']))
            if role.bid:
                headers.append(('x-player-bid',role.bid))
            if role.device_id:
                headers.append(('x-device-id',role.device_id))
        pause = 2 - (time.monotonic() - last_request)
        if pause > 0:
            if pause >= remaining():
                raise TimeoutError('account_deadline_exceeded')
            time.sleep(pause)
        last_request = time.monotonic()
        wire = post('/'+service+'/'+method, frame(request.SerializeToString()), lambda: headers,
            region=role.region, api_origin=role.origin, timeout=remaining(), check_control=check_control)
        metadata = {k.lower():v for source in ('headers','trailers') for k,v in wire[source].items()}
        status = metadata.get('grpc-status')
        if wire.get('error_type') or wire['status'] != 200 or status != '0':
            code = ('ranking_authentication_failed' if wire['status'] == 401 or status == '16' else
                    'ranking_permission_denied' if wire['status'] == 403 or status == '7' else 'verification_failed')
            raise AccountVerificationError(code)
        response = message_factory.GetMessageClass(descriptor.output_type)()
        try:
            response.ParseFromString(unframe(wire['body']))
        except (ValueError, DecodeError):
            raise AccountVerificationError('verification_invalid_response') from None
        return response

    version = rpc('app.masterdata.MasterdataService','Version',{},False)
    observed = (version.version,) if role.region == 'jp' else (version.version, version.resource_version)
    expected = (catalog['masterVersion'],) if role.region == 'jp' else (catalog['masterVersion'], catalog['resourceVersion'])
    if any(not value or any(ord(char) < 32 or ord(char) > 126 for char in value)
           for value in observed):
        raise AccountVerificationError('verification_invalid_version')
    if observed != expected or catalog['apiOrigin'] != role.origin:
        raise AccountVerificationError('verification_version_changed')
    for board in boards:
        if verification_boards(catalog, int(time.time()*1000)) != boards:
            raise AccountVerificationError('verification_target_changed')
        rpc(*board, True)

def run_account_job(job):
    sdk_profile, profile, cached = validate_account_job(job)
    base = dict(contract='haneoka:official-account-result/1', action=job['action'], region=job['region'], runId=job['runId'])
    role = None
    stage = 'catalog'
    deadline = job['deadlineMs']/1000 - 2

    def remaining():
        left = deadline - time.time()
        if left <= 0:
            raise TimeoutError('account_deadline_exceeded')
        return min(20, left)

    def check_control():
        remaining()

    try:
        with tempfile.TemporaryDirectory(prefix='official-account-') as temporary:
            root = Path(temporary)
            master_file = root/'master.json'
            private_json(master_file, job['masterConfig'])
            provider = OfficialCatalog(master_file, root, '', profile.client_version, deadline=deadline,
                region=job['region'], api_origin=job['apiOrigin'], include_arena=True)
            try:
                catalog = provider()
            except ValueError:
                raise AccountVerificationError('account_catalog_invalid') from None
            boards = verification_boards(catalog, int(time.time()*1000))
            if not boards:
                raise AccountVerificationError('verification_unavailable')
            remaining()
            sdk = cached
            if job['action'] == 'sdk':
                stage = 'sdk'
                client = GlobalEmailLogin(sdk_profile, deadline=deadline)
                if cached is None:
                    sdk = client.login(job['email'], job['password'])
                else:
                    try:
                        sdk = client.resume(cached)
                    except SdkLoginError as error:
                        if error.kind != 'sdk_login_rejected' or error.code != -101:
                            raise
                        base['sdkSession'] = None
                        sdk = client.login(job['email'], job['password'])
                        if sdk.uid != cached.uid:
                            raise SdkLoginError('sdk_identity_mismatch')
            if job.get('expectedSdkUid') is not None and sdk.uid != job['expectedSdkUid']:
                raise SdkLoginError('sdk_identity_mismatch')
            if job['action'] == 'sdk':
                return dict(base, status='sdk_ready', sdkSession=asdict(sdk))
            stage = 'game'
            role = login_player(job['region'], sdk, profile, expected_player_id=job.get('expectedPlayerId'),
                api_origin=job['apiOrigin'], timeout=remaining(), check_control=check_control)
            stage = 'verification'
            verify_role(catalog, role, profile.client_version, deadline)
            return dict(base, status='ready', playerId=role.player_id, credentials=dict(
                player_id=role.player_id, credential=role.credential, device_id=role.device_id, bid=role.bid))
    except SdkLoginError as error:
        return dict(base, status='auth_required' if error.kind in ('sdk_login_rejected','sdk_identity_mismatch') else 'failed', errorCode=str(error))
    except PlayerLoginError as error:
        status = 'auth_required' if error.kind == 'game_player_mismatch' or error.http_status == 401 or error.grpc_status == '16' else 'auth_uncertain'
        return dict(base, status=status, errorCode=error.kind)
    except AccountVerificationError as error:
        return dict(base, status='auth_required' if error.code == 'ranking_authentication_failed' else 'failed',
            errorCode=error.code, **({'playerId':role.player_id} if role else {}))
    except (CatalogRequestError, VersionError):
        return dict(base, status='failed', errorCode='account_catalog_failed')
    except TimeoutError:
        return dict(base, status='auth_uncertain' if stage == 'game' else 'failed',
            errorCode='verification_incomplete' if stage == 'verification' else 'account_deadline_exceeded',
            **({'playerId':role.player_id} if role else {}))
    except OSError:
        return dict(base, status='auth_uncertain' if stage == 'game' else 'failed', errorCode='account_network_failed',
            **({'playerId':role.player_id} if role else {}))
