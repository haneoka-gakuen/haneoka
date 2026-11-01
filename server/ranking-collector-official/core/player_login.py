# L3 — GEB
# Input: SDK session, explicit game client profile and selected Global region.
# Output: Private regional credential and new-user flag, with optional player pinning.
# Pos: [Map](../../L2.md); PlayerLogin protocol independent of collection receipts.
# Effects/Dependencies: One official HTTP/2 login, owning descriptors; no files or retries.
from dataclasses import dataclass
from pathlib import Path
import uuid

from google.protobuf import message_factory
from google.protobuf.message import DecodeError

from http2 import post
from regions import select_api_origin
from transport import frame, pool_from_file, unframe


PLAYER_LOGIN = '/app.playerlogin.PlayerLoginService/PlayerLogin'


class PlayerLoginError(RuntimeError):
    def __init__(self, kind, *, http_status=None, grpc_status=None):
        self.kind = kind
        self.http_status = http_status
        self.grpc_status = grpc_status
        super().__init__(kind)


@dataclass(frozen=True)
class GlobalPlayerProfile:
    client_version: str
    device_model: str
    operating_system: str
    device_id: str
    client_package: str
    global_channel_id: int
    brand_id: int
    area_id: int
    initial_data_group: str = ''


@dataclass(frozen=True, repr=False)
class PlayerSession:
    region: str
    origin: str
    player_id: str
    credential: str
    device_id: str
    bid: str
    is_new_user: bool


def login_player(region, sdk_session, profile: GlobalPlayerProfile, *, expected_player_id=None,
                 api_origin=None, timeout=20, check_control=lambda: None):
    if region not in ('tw', 'en', 'kr'):
        raise ValueError('invalid_global_region')
    origin = select_api_origin(region, api_origin)
    pool = pool_from_file(Path(__file__).with_name('intl-descriptors.pb'))
    method = pool.FindServiceByName('app.playerlogin.PlayerLoginService').methods_by_name['PlayerLogin']
    request = message_factory.GetMessageClass(method.input_type)(
        sdkUid=sdk_session.uid, sdkAccessToken=sdk_session.access_key,
        deviceModel=profile.device_model, operatingSystem=profile.operating_system,
        clientVersion=profile.client_version, clientPackage=profile.client_package,
        globalChannelId=profile.global_channel_id, brandId=profile.brand_id, areaId=profile.area_id,
        initial_data_group=profile.initial_data_group, idToken=sdk_session.id_token,
    )
    request.uuid.identifier = profile.device_id
    headers = [('te', 'trailers'), ('x-platform', 'android'), ('x-client-version', profile.client_version),
               ('x-request-id', str(uuid.uuid4())), ('x-player-bid', sdk_session.uid)]
    if any(not value or any(ord(char) < 32 or ord(char) > 126 for char in value) for _, value in headers):
        raise PlayerLoginError('game_invalid_header')
    wire = post(PLAYER_LOGIN, frame(request.SerializeToString()), lambda: headers,
                region=region, api_origin=origin, timeout=timeout, check_control=check_control)
    metadata = {key.lower(): value for source in ('headers', 'trailers') for key, value in wire[source].items()}
    status = metadata.get('grpc-status')
    if wire.get('error_type') or wire['status'] != 200 or status != '0':
        raise PlayerLoginError('game_login_failed', http_status=wire['status'], grpc_status=status)
    response = message_factory.GetMessageClass(method.output_type)()
    try:
        response.ParseFromString(unframe(wire['body']))
    except (ValueError, DecodeError):
        raise PlayerLoginError('game_invalid_response') from None
    credential = response.credential
    if any(not value or any(ord(char) < 32 or ord(char) > 126 for char in value)
           for value in (credential.id, credential.credential)):
        raise PlayerLoginError('game_invalid_response')
    if credential.device_id and any(ord(char) < 32 or ord(char) > 126 for char in credential.device_id):
        raise PlayerLoginError('game_invalid_response')
    if expected_player_id is not None and credential.id != expected_player_id:
        raise PlayerLoginError('game_player_mismatch')
    return PlayerSession(region, origin, credential.id, credential.credential,
                         credential.device_id, sdk_session.uid, response.isNewUser != 0)
