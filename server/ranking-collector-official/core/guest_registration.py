# L3 — GEB
# Input: Explicit JP client profile and selected official API origin.
# Output: Private registered guest identity, credential and exact profile ID.
# Pos: [Map](../../L2.md); guest bootstrap separate from regional collection.
# Effects/Dependencies: One HTTP/2 Register request; no retries, persistence or pool enrollment.
from dataclasses import dataclass
from pathlib import Path
import uuid

from google.protobuf import message_factory
from google.protobuf.message import DecodeError

from http2 import post
from player_login import PlayerSession
from regions import select_api_origin
from transport import frame, pool_from_file, unframe


REGISTER = '/app.player.PlayerService/Register'


class GuestRegistrationError(RuntimeError):
    def __init__(self, kind, *, http_status=None, grpc_status=None):
        self.kind = kind
        self.http_status = http_status
        self.grpc_status = grpc_status
        super().__init__(kind)


@dataclass(frozen=True)
class GuestProfile:
    client_version: str
    device_id: str = ''
    initial_data_group: str = ''

    def __post_init__(self):
        if (not isinstance(self.client_version, str) or not self.client_version
                or not isinstance(self.device_id, str) or not isinstance(self.initial_data_group, str)
                or any(not 32 <= ord(c) < 127 for c in self.client_version + self.device_id)):
            raise ValueError('invalid_guest_profile')


@dataclass(frozen=True, repr=False)
class RegisteredGuest:
    session: PlayerSession
    profile_id: str


def register_guest(profile: GuestProfile, *, api_origin=None, timeout=20, check_control=lambda: None):
    origin = select_api_origin('jp', api_origin)
    pool = pool_from_file(Path(__file__).with_name('total-descriptors.pb'))
    method = pool.FindServiceByName('app.player.PlayerService').methods_by_name['Register']
    request = message_factory.GetMessageClass(method.input_type)(initial_data_group=profile.initial_data_group)
    headers = [('te', 'trailers'), ('x-platform', 'android'), ('x-client-version', profile.client_version),
               ('x-request-id', str(uuid.uuid4()))]
    if profile.device_id:
        headers.append(('x-device-id', profile.device_id))
    wire = post(REGISTER, frame(request.SerializeToString()), lambda: headers,
                region='jp', api_origin=origin, timeout=timeout, check_control=check_control)
    metadata = {key.lower(): value for source in ('headers', 'trailers') for key, value in wire[source].items()}
    status = metadata.get('grpc-status')
    if wire.get('error_type') or wire['status'] != 200 or status != '0':
        raise GuestRegistrationError('guest_registration_failed', http_status=wire['status'], grpc_status=status)
    response = message_factory.GetMessageClass(method.output_type)()
    try:
        response.ParseFromString(unframe(wire['body']))
    except (ValueError, DecodeError):
        raise GuestRegistrationError('guest_invalid_response') from None
    credential = response.credential
    if (any(not value or any(not 32 <= ord(c) < 127 for c in value) for value in (credential.id, credential.credential))
            or any(not 32 <= ord(c) < 127 for c in credential.device_id)):
        raise GuestRegistrationError('guest_invalid_response')
    return RegisteredGuest(PlayerSession('jp', origin, credential.id, credential.credential,
                                        credential.device_id, '', True), str(response.profile_id))
