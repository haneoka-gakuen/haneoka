# L3 — GEB
# Input: Explicit Global SDK profile, email/original password or a saved SDK session.
# Output: Private SDK identity and access token, or a body-free error code.
# Pos: [Map](../../L2.md); email authentication independent of regional game roles.
# Effects/Dependencies: Signed HTTPS forms and RSA encryption; no retries or persistence.
import base64
from dataclasses import dataclass, field
import hashlib
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA


LOGIN_ORIGINS = frozenset(f'https://l{i}-sdk-login-intl.biligame.net' for i in (11, 12, 13))
RESPONSE_LIMIT = 1024 * 1024


class SdkLoginError(RuntimeError):
    def __init__(self, kind, code=None):
        self.kind = kind
        self.code = code
        super().__init__(kind if code is None else f'{kind}:{code}')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class SdkProfile:
    origin: str
    app_key: str = field(repr=False)
    # Decoded form values; device and channel values belong to the configured client.
    common_params: dict[str, str] = field(repr=False)
    email_country_id: int | None = None
    one_sdk_version: str | None = None

    def __post_init__(self):
        if self.origin not in LOGIN_ORIGINS:
            raise ValueError('invalid_sdk_origin')
        required = {'game_id', 'server_id', 'merchant_id', 'app_ver', 'sdk_ver',
                    'channel_id', 'platform', 'platform_type', 'udid'}
        if (not isinstance(self.app_key, str) or not self.app_key or not isinstance(self.common_params, dict)
                or not required <= self.common_params.keys()
                or any(not isinstance(value, str) for value in self.common_params.values())
                or any(not self.common_params[key] for key in required)
                or {'sign', 'timestamp', 'user_id', 'pwd', 'ticket', 'country_id', 'user_id_type'} & self.common_params.keys()
                or self.email_country_id is not None and (type(self.email_country_id) is not int or self.email_country_id < 0)
                or self.one_sdk_version is not None and (not isinstance(self.one_sdk_version, str)
                    or not self.one_sdk_version or any(not 32 <= ord(c) < 127 for c in self.one_sdk_version))):
            raise ValueError('invalid_sdk_profile')


@dataclass(frozen=True, repr=False)
class SdkSession:
    uid: str
    access_key: str
    id_token: str
    mid: str | None = None


def sdk_session(data, *, access_key=None):
    uid, key, token, mid = data.get('uid'), access_key if access_key is not None else data.get('access_key'), data.get('id_token', ''), data.get('mid')
    if (not isinstance(uid, (str, int)) or isinstance(uid, bool) or not str(uid)
            or not isinstance(key, str) or not key or not isinstance(token, str)
            or mid is not None and (not isinstance(mid, (str, int)) or isinstance(mid, bool))):
        raise SdkLoginError('sdk_invalid_response')
    return SdkSession(str(uid), key, token, None if mid is None else str(mid))


def signed_form(params, app_key):
    material = ''.join(params[key] for key in sorted(params)
                       if key.lower() not in ('item_name', 'item_desc')) + app_key
    signature = hashlib.md5(material.encode('utf-8'), usedforsecurity=False).hexdigest()
    return urlencode({**params, 'sign': signature}).encode('ascii')


def encrypted_password(public_key, salt, password):
    try:
        key = RSA.import_key(public_key)
    except (ValueError, IndexError, TypeError):
        raise SdkLoginError('sdk_invalid_rsa_key') from None
    if key.has_private():
        raise SdkLoginError('sdk_invalid_rsa_key')
    payload = (salt + password).encode('utf-8')
    if len(payload) > key.size_in_bytes() - 11:
        raise SdkLoginError('sdk_password_too_long')
    return base64.b64encode(PKCS1_v1_5.new(key).encrypt(payload)).decode('ascii')


class GlobalEmailLogin:
    def __init__(self, profile: SdkProfile, *, timeout=15, deadline=None):
        self.profile = profile
        self.timeout = timeout
        self.deadline = deadline
        self.opener = build_opener(NoRedirect())

    def _post(self, path, fields):
        timeout = self.timeout if self.deadline is None else min(self.timeout, self.deadline - time.time())
        if timeout <= 0:
            raise SdkLoginError('sdk_deadline_exceeded')
        params = {**self.profile.common_params, **fields, 'timestamp': str(time.time_ns() // 1_000_000)}
        headers = {
            'User-Agent': 'Mozilla/5.0 BSGameSDK', 'Api-Version': '1',
            'Content-Type': 'application/x-www-form-urlencoded',
        }
        if self.profile.one_sdk_version is not None:
            headers['one-sdk-ver'] = self.profile.one_sdk_version
        request = Request(self.profile.origin + path, signed_form(params, self.profile.app_key), headers=headers, method='POST')
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(RESPONSE_LIMIT + 1)
        except HTTPError as error:
            error.close()
            raise SdkLoginError('sdk_http_error', error.code) from None
        except (URLError, TimeoutError):
            raise SdkLoginError('sdk_network_error') from None
        if len(raw) > RESPONSE_LIMIT:
            raise SdkLoginError('sdk_invalid_response')
        try:
            envelope = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise SdkLoginError('sdk_invalid_response') from None
        if not isinstance(envelope, dict) or type(envelope.get('code')) is not int:
            raise SdkLoginError('sdk_invalid_response')
        if envelope['code'] != 0:
            raise SdkLoginError('sdk_login_rejected', envelope['code'])
        data = envelope.get('data')
        if not isinstance(data, dict):
            raise SdkLoginError('sdk_invalid_response')
        return data

    def login(self, email, password, *, ticket=None):
        challenge = self._post('/gapi/client/rsa', {})
        public_key, salt = challenge.get('rsa_key'), challenge.get('hash')
        if not isinstance(public_key, str) or not public_key or not isinstance(salt, str):
            raise SdkLoginError('sdk_invalid_response')
        fields = {'user_id': email, 'pwd': encrypted_password(public_key, salt, password)}
        if ticket:
            fields['ticket'] = ticket
        if self.profile.email_country_id is not None:
            fields.update(country_id=str(self.profile.email_country_id), user_id_type='0')
        data = self._post('/gapi/client/login', fields)
        return sdk_session(data)

    def resume(self, session: SdkSession):
        fields = {'access_key': session.access_key, 'uid': session.uid}
        if session.mid is not None:
            fields['mid'] = session.mid
        data = self._post('/gapi/client/cache.login', fields)
        restored = sdk_session(data, access_key=session.access_key)
        if restored.uid != session.uid:
            raise SdkLoginError('sdk_identity_mismatch')
        return restored
