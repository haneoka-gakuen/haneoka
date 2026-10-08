import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from sync_pipeline_config import secret_payload, sync_configuration


class ConfigurationSyncTests(unittest.TestCase):
    def test_secret_has_one_line_even_with_multiline_strings(self):
        settings = {"id": "intl-test", "locales": ["ja", "en"], "value": "a\nb\r中文"}
        payload = secret_payload(settings)
        self.assertNotIn("\n", payload)
        self.assertNotIn("\r", payload)
        self.assertEqual(json.loads(payload), settings)

    def test_upload_uses_stdin_and_restores_environment(self):
        settings = {"id": "intl-test", "secret": "private-value", "locales": ["ja", "en"]}
        with patch.dict(os.environ, {"RESOURCE_PIPELINE_CONFIG": "original"}), \
                patch("sync_pipeline_config.load_server_config") as validate, \
                patch("sync_pipeline_config.runtime_settings", return_value=settings), \
                patch("sync_pipeline_config.subprocess.run") as upload:
            upload.return_value.returncode = 0
            result = sync_configuration("intl-test", Path("private"), "owner/repo")
            validate.assert_called_once_with("intl-test")
            arguments, options = upload.call_args
            self.assertNotIn("private-value", " ".join(arguments[0]))
            self.assertEqual(options["input"], secret_payload(settings))
            self.assertEqual(os.environ["RESOURCE_PIPELINE_CONFIG"], "original")
            self.assertEqual(result["environment"], "resource-intl-test")

    def test_validation_failure_never_uploads(self):
        with patch("sync_pipeline_config.load_server_config", side_effect=ValueError("invalid")), \
                patch("sync_pipeline_config.subprocess.run") as upload:
            with self.assertRaises(ValueError):
                sync_configuration("intl-test", Path("private"), "owner/repo")
            upload.assert_not_called()

    def test_check_does_not_upload(self):
        with patch("sync_pipeline_config.load_server_config"), \
                patch("sync_pipeline_config.runtime_settings", return_value={"id": "intl-test"}), \
                patch("sync_pipeline_config.subprocess.run") as upload:
            sync_configuration("intl-test", Path("private"), "owner/repo", check_only=True)
            upload.assert_not_called()

    def test_upload_failure_omits_process_output(self):
        with patch("sync_pipeline_config.load_server_config"), \
                patch("sync_pipeline_config.runtime_settings", return_value={"id": "intl-test"}), \
                patch("sync_pipeline_config.subprocess.run") as upload:
            upload.return_value.returncode = 1
            upload.return_value.stderr = "private-value"
            with self.assertRaises(RuntimeError) as error:
                sync_configuration("intl-test", Path("private"), "owner/repo")
            self.assertNotIn("private-value", str(error.exception))
