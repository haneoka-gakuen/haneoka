"""L3: server/L2.md -> ranking-collector-official; allowlisted offline candidate bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = ('collector.py', 'account-pool.mjs', 'setup.py', 'requirements.txt', 'build-requirements.txt',
         'README.md', 'INTERFACES.md', 'NOTICES.md', 'LICENSE', 'LICENSE.py3rijndael.txt',
         'build.py', 'core/history.py', 'core/lifecycle.py', 'core/sample.py', 'core/arena.py',
         'core/continuous.py', 'core/status.py', 'core/api.py', 'core/transport.py',
         'core/regions.py', 'core/demand.py', 'core/intl-descriptors.pb', 'core/official_catalog.py', 'core/http2.py', 'core/process_lock.py', 'core/total-descriptors.pb', 'core/pool_query.py')
DISTRIBUTIONS = {
    'protobuf-6.33.0-py3-none-any.whl': '25c9e1963c6734448ea2d308cfa610e692b801304ba0908d7bfa564ac5132995',
    'py3rijndael-0.3.3.tar.gz': 'b6655a3ebff3a10540eaed049e8788eea3ac93d6b71b3a6ac2b00224bbece9a8',
    'setuptools-80.9.0-py3-none-any.whl': '062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922',
    'wheel-0.45.1-py3-none-any.whl': '708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248',
    'h2-4.4.1-py3-none-any.whl': '0e25f1462b23c9cb82d9eb02e28bc706dac2a68cb457c6a0d74d63c8a2a5d0e6',
    'hpack-4.2.0-py3-none-any.whl': '858ac0b02280fa582b5080d68db0899c62a80375e0e5413a74970c5e518b6986',
    'hyperframe-6.1.0-py3-none-any.whl': 'b03380493a519fce58ea5af42e4a42317bf9bd425596f7a0835ffce80f1a42e5',
}


def build(wheelhouse, output):
    payloads = {name: (ROOT / name).read_bytes() for name in FILES}
    for name, expected in DISTRIBUTIONS.items():
        data = (Path(wheelhouse) / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('Pinned distribution checksum mismatch: ' + name)
        payloads['wheelhouse/' + name] = data
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(payloads.items())}
    payloads['MANIFEST.json'] = json.dumps(manifest, indent=2).encode()
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(payloads.items()):
            info = zipfile.ZipInfo('haneoka-ranking-collector-official/' + name, date_time=(2026, 10, 29, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    print(json.dumps(dict(file=str(Path(output).resolve()), files=len(payloads),
                         sha256=hashlib.sha256(Path(output).read_bytes()).hexdigest())))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheelhouse', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.wheelhouse, args.output)
