# L3 — GEB
# Input: Authenticated bounded jobs from the regional Durable Object.
# Output: Durable Worker callbacks and a bounded completion response.
# Pos: [Map](../L2.md); Cloudflare Container HTTP entry point.
# Effects/Dependencies: Binds container port 8080; shared Python collector performs official reads.
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent/'core'))
from cloud_job import CallbackError, callback_url, failure_info, report_failure, run_job, validate_job


def serve():
    token = os.environ.get('OFFICIAL_COLLECTOR_TOKEN', '')
    origin = os.environ.get('OFFICIAL_CALLBACK_ORIGIN', 'https://haneoka.org')
    if len(token) < 32:
        raise ValueError('collector service token missing')
    lock = threading.Lock()
    lookup_lock = threading.Lock()
    completed = {}

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

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'ready': self.path == '/health'})

        def do_POST(self):
            authorizations = self.headers.get_all('Authorization', [])
            if len(authorizations) != 1 or not hmac.compare_digest(authorizations[0].encode(), ('Bearer '+token).encode()):
                self.reply(403, {'error': 'unauthorized'})
                return
            if self.path != '/collect':
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
                validate_job(job)
                callback_url(job, origin)
            except Exception:
                self.reply(400, {'error': 'invalid_job'})
                return
            gate = lookup_lock if job.get('mode') == 'lookup' else lock
            if not gate.acquire(blocking=False):
                self.reply(409, {'error': 'busy'})
                return
            try:
                run_id = job['runId']
                prior = completed.get(run_id)
                if prior is not None:
                    if prior[0] != job['credentialGeneration']:
                        self.reply(409, {'error': 'run_conflict'})
                    else:
                        self.reply(200, prior[1])
                    return
                result = run_job(job, origin)
                completed[run_id] = (job['credentialGeneration'], result)
                if len(completed) > 16:
                    del completed[next(iter(completed))]
                self.reply(200, result)
            except CallbackError as error:
                self.reply(502, {'error': 'callback_unavailable', 'failure': error.failure})
            except Exception as error:
                report_failure(job['region'],failure_info('container',error))
                self.reply(500, {'error': 'collection_failed'})
            finally:
                gate.release()

        def log_message(self, *_args):
            pass

    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


if __name__ == '__main__':
    serve()
