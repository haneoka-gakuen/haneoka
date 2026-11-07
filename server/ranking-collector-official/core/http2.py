# L3 — GEB
# Input: Allowlisted regional API origin, unary request, credential header factory and bounded I/O controls.
# Output: HTTP/2 status, allowlisted metadata and response body, using the JP gateway's TLS 1.2 compatibility profile.
# Pos: [Map](../../L2.md); direct Python transport for the standalone collector.
# Effects/Dependencies: TCP/TLS with optional loopback CONNECT; h2 framing and no persistence.
import errno
import ipaddress
import select
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import ResponseReceived, TrailersReceived, DataReceived, StreamEnded, StreamReset, ConnectionTerminated, PushedStreamReceived
from h2.exceptions import H2Error, ProtocolError
from h2.settings import SettingCodes

from lifecycle import normalize_proxy
from regions import select_api_origin

HOST = 'api.bang-dream-on.jp'
MAX_BODY = 16777216
HEADER_NAMES = {'server', 'date', 'grpc-status', 'grpc-message', 'x-asset-version', 'x-error-code', 'retry-after'}
TRAILER_NAMES = {'grpc-status', 'grpc-message', 'x-error-code', 'retry-after'}
_resolutions = {}
_resolution_lock = threading.Lock()


def remaining(deadline, check_control):
    check_control()
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError('Official API request timed out')
    return left


def wait_socket(stream, deadline, check_control, writing=False):
    timeout = min(.2, remaining(deadline, check_control))
    readable, writable, failed = select.select([] if writing else [stream], [stream] if writing else [], [stream], timeout)
    if failed:
        raise OSError('Official API connection failed')
    return bool(readable or writable)


def send(stream, data, deadline, check_control):
    pending = memoryview(data)
    while pending:
        remaining(deadline, check_control)
        try:
            count = stream.send(pending)
            if not count:
                raise OSError('Official API connection closed')
            pending = pending[count:]
        except (BlockingIOError, ssl.SSLWantWriteError):
            wait_socket(stream, deadline, check_control, True)
        except ssl.SSLWantReadError:
            wait_socket(stream, deadline, check_control)


def receive(stream, deadline, check_control):
    while True:
        remaining(deadline, check_control)
        try:
            return stream.recv(65536)
        except (BlockingIOError, ssl.SSLWantReadError):
            wait_socket(stream, deadline, check_control)
        except ssl.SSLWantWriteError:
            wait_socket(stream, deadline, check_control, True)


def addresses(deadline, check_control, host=HOST):
    remaining(deadline, check_control)
    with _resolution_lock:
        _resolution = _resolutions.get(host)
        if (_resolution is None or (_resolution['done'].is_set()
                and (_resolution.get('error') is not None or time.monotonic() - _resolution['started'] > 60))):
            result = {'done': threading.Event(), 'started': time.monotonic()}
            _resolutions[host] = result

            def resolve():
                try:
                    result['addresses'] = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
                except OSError as error:
                    result['error'] = error
                finally:
                    result['done'].set()

            threading.Thread(target=resolve, daemon=True).start()
        result = _resolutions[host]
    while not result['done'].wait(min(.2, remaining(deadline, check_control))):
        pass
    if result.get('error') is not None:
        raise OSError('Official API name resolution failed')
    return result['addresses']


def numeric_address(address, port):
    ip = ipaddress.ip_address(address)
    family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
    target = (str(ip), port, 0, 0) if ip.version == 6 else (str(ip), port)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', target)]


def connect(candidates, deadline, check_control):
    pending_errors = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
    for family, kind, protocol, _, target in candidates:
        remaining(deadline, check_control)
        stream = socket.socket(family, kind, protocol)
        stream.setblocking(False)
        try:
            error = stream.connect_ex(target)
            connection_deadline = min(deadline, time.monotonic() + 8)
            while error:
                if error not in pending_errors:
                    raise OSError(error, 'Official API connect failed')
                if wait_socket(stream, connection_deadline, check_control, True):
                    error = stream.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            return stream
        except InterruptedError:
            stream.close()
            raise
        except OSError:
            stream.close()
    raise OSError('Official API connect failed')


def connect_proxy(stream, deadline, check_control, host=HOST):
    send(stream, f'CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n'.encode('ascii'), deadline, check_control)
    response = bytearray()
    while b'\r\n\r\n' not in response:
        chunk = receive(stream, deadline, check_control)
        if not chunk:
            raise OSError('Proxy tunnel closed')
        response.extend(chunk)
        if len(response) > 65536:
            raise OSError('Proxy response headers too large')
    head, extra = bytes(response).split(b'\r\n\r\n', 1)
    status = head.split(b'\r\n', 1)[0].split()
    if len(status) < 2 or status[0] not in (b'HTTP/1.0', b'HTTP/1.1') or not status[1].isdigit() or not 200 <= int(status[1]) < 300 or extra:
        raise OSError('Proxy tunnel rejected')


def secure_socket(stream, deadline, check_control, host=HOST):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs(ssl.Purpose.SERVER_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    # JP rejects the Container runtime's TLS 1.3 handshake before RPC authentication.
    if host == HOST:
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    context.set_ciphers('ECDHE+AESGCM:ECDHE+CHACHA20')
    context.set_alpn_protocols(['h2'])
    connection = context.wrap_socket(stream, server_hostname=host, do_handshake_on_connect=False)
    connection.setblocking(False)
    try:
        while True:
            remaining(deadline, check_control)
            try:
                connection.do_handshake()
                break
            except ssl.SSLWantReadError:
                wait_socket(connection, deadline, check_control)
            except ssl.SSLWantWriteError:
                wait_socket(connection, deadline, check_control, True)
        if connection.selected_alpn_protocol() != 'h2':
            raise OSError('Official API did not negotiate HTTP/2')
        return connection
    except BaseException:
        connection.close()
        raise


def add_headers(response, values, trailer=False, include_cdn=False):
    target = response['trailers'] if trailer else response['headers']
    allowed = TRAILER_NAMES if trailer else HEADER_NAMES
    for name, value in values:
        name = name.decode('ascii')
        if name == ':status':
            if len(value) != 3 or not value.isdigit():
                raise ProtocolError('Invalid HTTP response status')
            response['status'] = int(value)
        elif name in allowed:
            text = value.decode('utf-8', errors='replace')
            target[name] = target[name] + ', ' + text if name in target else text
        elif include_cdn and response['status'] == 200 and not trailer and name in ('x-sirius-env', 'x-sirius-cred'):
            response['cdn'][name] = value.decode('utf-8', errors='replace')


def post(path, body, header_factory, *, proxy='', connect_ip=None, timeout=20, check_control=lambda: None, include_cdn=False, region='jp', api_origin=None):
    host = urlsplit(select_api_origin(region, api_origin)).hostname
    if len(body) > 4096:
        raise ValueError('Request too large')
    proxy = normalize_proxy(proxy)
    if proxy and connect_ip:
        raise ValueError('Choose either proxy or direct IP transport')
    response = {'status': None, 'headers': {}, 'trailers': {}, 'body': b'', 'cdn': {}}
    deadline = time.monotonic() + timeout
    stream = None
    try:
        if proxy:
            endpoint = urlsplit(proxy)
            candidates = numeric_address(endpoint.hostname, endpoint.port)
        else:
            candidates = numeric_address(connect_ip, 443) if connect_ip else addresses(deadline, check_control, host)
        stream = connect(candidates, deadline, check_control)
        if proxy:
            connect_proxy(stream, deadline, check_control, host)
        stream = secure_socket(stream, deadline, check_control, host)
        response['http_version'] = '2.0'
        headers = header_factory()
        connection = H2Connection(config=H2Configuration(client_side=True))
        connection.initiate_connection()
        connection.update_settings({SettingCodes.ENABLE_PUSH: 0, SettingCodes.MAX_HEADER_LIST_SIZE: 65536})
        connection.send_headers(1, [(':method', 'POST'), (':scheme', 'https'), (':authority', host),
            (':path', path), ('content-type', 'application/grpc'), ('content-length', str(len(body))), *headers])
        connection.send_data(1, body, end_stream=True)
        send(stream, connection.data_to_send(), deadline, check_control)
        received = bytearray()
        ended = False
        while not ended:
            raw = receive(stream, deadline, check_control)
            if not raw:
                raise OSError('Official API stream closed before completion')
            for event in connection.receive_data(raw):
                if isinstance(event, ResponseReceived) and event.stream_id == 1:
                    add_headers(response, event.headers, include_cdn=include_cdn)
                elif isinstance(event, TrailersReceived) and event.stream_id == 1:
                    add_headers(response, event.headers, trailer=True)
                elif isinstance(event, DataReceived):
                    if event.stream_id != 1 or len(received) + len(event.data) > MAX_BODY:
                        raise ProtocolError('Unexpected or oversized response data')
                    received.extend(event.data)
                    connection.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                elif isinstance(event, StreamEnded) and event.stream_id == 1:
                    ended = True
                elif isinstance(event, (StreamReset, PushedStreamReceived)):
                    raise ProtocolError('Official API stream reset or unexpected push')
                elif isinstance(event, ConnectionTerminated) and not ended:
                    raise ProtocolError('Official API connection terminated')
            if not ended:
                send(stream, connection.data_to_send(), deadline, check_control)
        if response['status'] is None:
            raise ProtocolError('Missing HTTP response status')
        response['body'] = bytes(received)
    except InterruptedError:
        raise
    except (OSError, H2Error) as error:
        response['error_type'] = type(error).__name__
        response['cdn'] = {}
    finally:
        if stream is not None:
            stream.close()
    return response
