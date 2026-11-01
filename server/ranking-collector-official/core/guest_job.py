# L3 — GEB
# Input: Authenticated, deadline-bound JP register or saved-credential verification job.
# Output: Private created identity, verified readiness or a body-free failure state.
# Pos: [Map](../../L2.md); registration and verification are separate persistence phases.
# Effects/Dependencies: Fresh catalog and one registration or read-only verification; no credential files or retries.
from pathlib import Path
import re
import tempfile
import time

from account_job import AccountVerificationError, verify_role
from cloud_job import private_json
from guest_registration import GuestProfile, GuestRegistrationError, register_guest
from official_catalog import OfficialCatalog, CatalogRequestError
from player_login import PlayerSession
from regions import select_api_origin
from transport import VersionError


CONTRACT = 'haneoka:official-guest-job/1'


def validate_guest_job(job):
    if (not isinstance(job, dict) or job.get('contract') != CONTRACT or job.get('region') != 'jp'
            or job.get('action') not in ('register', 'verify')
            or not isinstance(job.get('runId'), str) or not re.fullmatch('[a-f0-9]{32}', job['runId'])
            or not isinstance(job.get('guestId'), str)
            or not re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', job['guestId'])
            or type(job.get('deadlineMs')) is not int or not 0 < job['deadlineMs'] - time.time()*1000 <= 150000
            or not isinstance(job.get('apiOrigin'), str)
            or not isinstance(job.get('masterConfig'), dict) or not job['masterConfig']):
        raise ValueError('invalid_guest_job')
    origin = select_api_origin('jp', job['apiOrigin'])
    try:
        profile = GuestProfile(**job['guestProfile'])
    except (KeyError, TypeError):
        raise ValueError('invalid_guest_profile') from None
    role = None
    if job['action'] == 'register':
        if 'credentials' in job:
            raise ValueError('registration_has_credentials')
    else:
        credentials = job.get('credentials')
        if not isinstance(credentials, dict):
            raise ValueError('invalid_guest_credentials')
        player, secret, device = (credentials.get(key) for key in ('player_id', 'credential', 'device_id'))
        if (any(not isinstance(value, str) or not value for value in (player, secret))
                or not isinstance(device, str)
                or any(not 32 <= ord(c) < 127 for value in (player, secret, device) for c in value)):
            raise ValueError('invalid_guest_credentials')
        role = PlayerSession('jp', origin, player, secret, device, '', False)
    return profile, role


def run_guest_job(job):
    profile, role = validate_guest_job(job)
    base = dict(contract='haneoka:official-guest-result/1', action=job['action'], region='jp',
                runId=job['runId'], guestId=job['guestId'])
    deadline = job['deadlineMs']/1000 - 2
    attempted = False

    def check_control():
        if time.time() >= deadline:
            raise TimeoutError('guest_deadline_exceeded')

    try:
        with tempfile.TemporaryDirectory(prefix='official-guest-') as temporary:
            root = Path(temporary)
            master_file = root/'master.json'
            private_json(master_file, job['masterConfig'])
            provider = OfficialCatalog(master_file, root, '', profile.client_version, deadline=deadline,
                region='jp', api_origin=job['apiOrigin'], include_arena=True)
            try:
                catalog = provider()
            except ValueError:
                raise AccountVerificationError('guest_catalog_invalid') from None
            check_control()
            if job['action'] == 'register':
                timeout = min(20, deadline - time.time())
                attempted = True
                created = register_guest(profile, api_origin=job['apiOrigin'], timeout=timeout, check_control=check_control)
                return dict(base, status='created', playerId=created.session.player_id, profileId=created.profile_id,
                    credentials=dict(player_id=created.session.player_id, credential=created.session.credential,
                                     device_id=created.session.device_id))
            verify_role(catalog, role, profile.client_version, deadline)
            return dict(base, status='ready', playerId=role.player_id)
    except GuestRegistrationError as error:
        return dict(base, status='uncertain', errorCode=error.kind)
    except AccountVerificationError as error:
        return dict(base, status='created' if role else 'failed', errorCode=error.code)
    except (CatalogRequestError, VersionError):
        return dict(base, status='created' if role else 'failed', errorCode='guest_catalog_failed')
    except (TimeoutError, OSError):
        return dict(base, status='created' if role else 'uncertain' if attempted else 'failed',
                    errorCode='guest_verification_incomplete' if role else 'guest_creation_incomplete')
