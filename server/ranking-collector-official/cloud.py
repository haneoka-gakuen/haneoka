# L3 — GEB
# Input: Authenticated bounded jobs from the regional Durable Object.
# Output: Durable collection callbacks or private SDK/game/guest-phase results for the owning DO.
# Pos: [Map](../L2.md); collector HTTP entry point in a Cloudflare Container or on a self-hosted Docker host.
# Effects/Dependencies: Binds port 8080; per-region exclusive jobs, asynchronous collection with service-failure callbacks, deadline-protected replay state; SIGTERM closes the entry listener.
import hmac
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent/'core'))
from cloud_job import CallbackError, Updates, callback_url, failure_info, report_failure, run_job, validate_job
from account_job import run_account_job, validate_account_job
from guest_job import run_guest_job, validate_guest_job


def serve():
    token = os.environ.get('OFFICIAL_COLLECTOR_TOKEN', '')
    origin = os.environ.get('OFFICIAL_CALLBACK_ORIGIN', 'https://haneoka.org')
    if len(token) < 32:
        raise ValueError('collector service token missing')
    # One host can serve every region, as one Container per region did: each
    # region keeps its own run and lookup slots.
    locks = {}
    locks_guard = threading.Lock()

    def slots(region):
        with locks_guard:
            return locks.setdefault(region, (threading.Lock(), threading.Lock()))

    completed = {}

    def remember(key, generation, result, deadline_ms):
        completed[key] = (generation, result, deadline_ms)
        now = time.time()*1000
        for prior_key, prior in list(completed.items()):
            if len(completed) <= 16:
                break
            if prior[2] <= now:
                completed.pop(prior_key, None)

    def run_detached(job, gate):
        try:
            result = run_job(job, origin)
            remember(job['runId'], job['credentialGeneration'], result, job['deadlineMs'])
        except Exception as error:
            failure = (error.failure if isinstance(error, CallbackError) else None) or failure_info('container', error)
            report_failure(job['region'], failure)
            try:
                Updates(job, origin).send('service-failure', failure=failure)
            except Exception:
                # Past the deadline the Worker closes the run itself.
                pass
        finally:
            gate.release()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def authorized(self):
            authorizations = self.headers.get_all('Authorization', [])
            if len(authorizations) != 1 or not hmac.compare_digest(authorizations[0].encode(), ('Bearer '+token).encode()):
                self.reply(403, {'error': 'unauthorized'})
                return False
            return True

        def do_GET(self):
            if self.path.startswith('/guest-result/'):
                if not self.authorized():
                    return
                run_id = self.path.removeprefix('/guest-result/')
                if not re.fullmatch('[a-f0-9]{32}', run_id):
                    self.reply(400, {'error': 'invalid_run'})
                    return
                prior = completed.get(('guest', 'register', run_id))
                if prior is None:
                    self.reply(404, {'error': 'result_not_found'})
                elif prior[1] is None:
                    self.reply(202, {'error': 'result_unavailable'})
                else:
                    self.reply(200, prior[1])
                return
            self.reply(200 if self.path == '/health' else 404, {'ready': self.path == '/health'})

        def do_POST(self):
            if not self.authorized():
                return
            account_login = self.path in ('/account-sdk','/account-game')
            guest_job = self.path == '/guest-job'
            private_job = account_login or guest_job
            if self.path not in ('/collect', '/account-sdk', '/account-game', '/guest-job'):
                self.reply(404, {'error': 'not_found'})
                return
            lengths = self.headers.get_all('Content-Length', [])
            if (len(lengths) != 1 or not lengths[0].isdecimal()
                    or not 0 < int(lengths[0]) <= 196608 or self.headers.get('Transfer-Encoding')):
                self.reply(400, {'error': 'invalid_job'})
                return
            self.connection.settimeout(10)
            try:
                job = json.loads(self.rfile.read(int(lengths[0])))
                if account_login:
                    validate_account_job(job)
                    if job['action'] != ('sdk' if self.path == '/account-sdk' else 'game'):
                        raise ValueError('invalid_account_phase')
                elif guest_job:
                    validate_guest_job(job)
                else:
                    validate_job(job)
                    callback_url(job, origin)
            except Exception:
                self.reply(400, {'error': 'invalid_job'})
                return
            lock, lookup_lock = slots(job['region'])
            gate = lookup_lock if not private_job and job.get('mode') == 'lookup' else lock
            if not gate.acquire(blocking=False):
                self.reply(409, {'error': 'busy'})
                return
            if private_job and not lookup_lock.acquire(blocking=False):
                gate.release()
                self.reply(409, {'error': 'busy'})
                return
            # A remote host accepts a scheduled run at once: its end reaches the
            # Worker through the run's callbacks, so the caller does not wait.
            if not private_job and job.get('mode') != 'lookup' and self.headers.get('X-Haneoka-Collector-Async') == '1':
                if job['runId'] in completed:
                    gate.release()
                    self.reply(409, {'error': 'run_conflict'})
                    return
                remember(job['runId'], job['credentialGeneration'], None, job['deadlineMs'])
                threading.Thread(target=run_detached, args=(job, gate), daemon=True).start()
                self.reply(202, {'accepted': job['runId']})
                return
            try:
                run_id = job['runId']
                cache_key = ('guest', job['action'], run_id) if guest_job else ('account', job['action'], run_id) if account_login else run_id
                generation = hashlib.sha256(json.dumps(job, sort_keys=True).encode()).hexdigest() if private_job else job['credentialGeneration']
                prior = completed.get(cache_key)
                if prior is not None:
                    if prior[0] != generation:
                        self.reply(409, {'error': 'run_conflict'})
                    elif prior[1] is None:
                        self.reply(409, {'error': 'run_uncertain'})
                    else:
                        self.reply(200, prior[1])
                    return
                if account_login or guest_job and job['action'] == 'register':
                    remember(cache_key, generation, None, job['deadlineMs'])
                result = run_guest_job(job) if guest_job else run_account_job(job) if account_login else run_job(job, origin)
                remember(cache_key, generation, result, job['deadlineMs'])
                self.reply(200, result)
            except CallbackError as error:
                self.reply(502, {'error': 'callback_unavailable', 'failure': error.failure})
            except Exception as error:
                failure = failure_info('container', error)
                report_failure(job['region'], failure)
                self.reply(500, {'error': 'guest_job_failed' if guest_job else 'account_job_failed' if account_login else 'collection_failed', 'failure': failure})
            finally:
                if private_job:
                    lookup_lock.release()
                gate.release()

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(('0.0.0.0', 8080), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    serve()
