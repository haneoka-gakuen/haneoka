import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.config import load_server_config
from core.private_config import redact_private_text


class PrivateConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / 'intl-test.json').write_text(json.dumps({
            'id': 'intl-test', 'configurationEnv': 'RESOURCE_PIPELINE_CONFIG'}))
        self.settings = {
            'id': 'intl-test', 'packageName': 'example.client', 'platform': 'Android',
            'unityVersion': '6000.3.12f1', 'extractionShards': 32, 'r2Bucket': 'fixture',
            'releaseRetention': 3, 'authorizationRequired': False,
            'remoteRoot': 'https://assets.example.invalid/asset/Android',
            'masterRemoteRoot': 'https://assets.example.invalid/master',
            'masterVersionEndpoint': 'https://api.example.invalid/service/Version',
            'criHcaKey': '123456789', 'masterCrypto': {'salt': 'a'*64, 'key': 'b'*64, 'iv': 'c'*64},
            'bundleCrypto': {'key': 'd'*32, 'nonceSeed': 'e'*16},
            'catalog': {'version': '1.0.0.400', 'locales': []},
        }
        self.stderr = sys.stderr
        self.registry = patch('core.config.CONFIG_ROOT', self.root)
        self.registry.start()
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()

    def tearDown(self):
        sys.stderr = self.stderr
        self.environment.stop()
        self.registry.stop()
        self.directory.cleanup()

    def load(self):
        os.environ['RESOURCE_PIPELINE_CONFIG'] = json.dumps(self.settings)
        return load_server_config('intl-test')

    def test_resolves_private_configuration_and_redacts_diagnostics(self):
        config = self.load()
        self.assertEqual(config.catalog_version, '1.0.0.400')
        self.assertEqual(config.remote_root, self.settings['remoteRoot'])
        output = redact_private_text('URL=' + config.remote_root + '; key=' + config.master_crypto['key'])
        self.assertNotIn(config.remote_root, output)
        self.assertNotIn(config.master_crypto['key'], output)
        self.assertNotIn('assets.example.invalid', redact_private_text('DNS lookup failed: assets.example.invalid'))

    def test_missing_secret_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'requires.*secret'):
            load_server_config('intl-test')

    def test_rejects_wrong_environment_identity(self):
        self.settings['id'] = 'intl'
        with self.assertRaisesRegex(ValueError, 'different server'):
            self.load()

    def test_rejects_inline_private_configuration(self):
        (self.root / 'intl-test.json').write_text(json.dumps(self.settings))
        with self.assertRaisesRegex(ValueError, 'configuration reference'):
            self.load()

    def test_keeps_https_origin_and_crypto_validation(self):
        self.settings['masterRemoteRoot'] = 'https://other.example.invalid/master'
        with self.assertRaisesRegex(ValueError, 'configured CDN origin'):
            self.load()
        self.settings['masterRemoteRoot'] = 'https://assets.example.invalid/master'
        self.settings['bundleCrypto']['key'] = 'broken'
        with self.assertRaisesRegex(ValueError, 'bundleCrypto'):
            self.load()

    def test_private_file_permissions_and_conflicting_sources(self):
        file = self.root / 'private.json'
        file.write_text(json.dumps(self.settings))
        file.chmod(0o644)
        os.environ['RESOURCE_PIPELINE_CONFIG_FILE'] = str(file)
        with self.assertRaisesRegex(ValueError, 'private regular file'):
            load_server_config('intl-test')
        file.chmod(0o600)
        self.assertEqual(load_server_config('intl-test').id, 'intl-test')
        with self.assertRaisesRegex(ValueError, 'not both'):
            self.load()

    def test_invalid_json_never_echoes_secret_material(self):
        os.environ['RESOURCE_PIPELINE_CONFIG'] = '{"token":"do-not-print-this"'
        with self.assertRaises(ValueError) as failure:
            load_server_config('intl-test')
        self.assertNotIn('do-not-print-this', str(failure.exception))

    def test_duplicate_json_fields_are_rejected(self):
        os.environ['RESOURCE_PIPELINE_CONFIG'] = '{"id":"intl-test","id":"intl"}'
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            load_server_config('intl-test')
