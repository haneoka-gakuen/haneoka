import unittest
from unittest.mock import Mock

from build.api import _stamps
from core.server_policy import is_test_server, project_catalog


class PreviewAssetTests(unittest.TestCase):
    def data(self, server, image=None):
        data = Mock()
        data.server = server
        data.rows.return_value = [{"_id": 1000000007, "_stampAsset": "Stamp/illust/stamp_illust_bili_00005", "_nameTextId": 1}]
        data.asset.return_value = image
        data.text.return_value = ["Stamp"]
        return data

    def test_preview_keeps_native_id_and_records_unavailable_art(self):
        for server in ("intl-test", "jp-test", "intl-test-next"):
            with self.subTest(server=server):
                row = _stamps(self.data(server))["1000000007"]
                self.assertEqual(row["stampId"], 1000000007)
                self.assertNotIn("image", row)
                self.assertEqual(row["assetAvailability"]["status"], "unavailable")

    def test_production_still_rejects_missing_art(self):
        for server in ("jp", "intl"):
            with self.subTest(server=server), self.assertRaisesRegex(ValueError, "image is absent"):
                _stamps(self.data(server))

    def test_existing_preview_art_uses_its_own_asset(self):
        row = _stamps(self.data("intl-test", "/assets/intl-test/stamp.png"))["1000000007"]
        self.assertEqual(row["image"], "/assets/intl-test/stamp.png")
        self.assertNotIn("assetAvailability", row)

    def test_asset_path_validation_applies_to_preview(self):
        data = self.data("intl-test")
        data.rows.return_value[0]["_stampAsset"] = "Stamp/../outside"
        with self.assertRaisesRegex(ValueError, "invalid asset path"):
            _stamps(data)

    def test_test_policy_covers_all_named_test_servers(self):
        for server in ("intl-test", "jp-test", "jp-test-next"):
            self.assertTrue(is_test_server(server))
        for server in ("jp", "intl", "intl-cbt", "jp-cbt"):
            self.assertFalse(is_test_server(server))

    def test_incomplete_projection_uses_empty_result_only_for_test_servers(self):
        def missing():
            raise ValueError("missing model asset")
        self.assertEqual(project_catalog("jp-test", "live2d", missing), {})
        self.assertEqual(project_catalog("intl-test", "songs", missing, fallback=({}, {})), ({}, {}))
        with self.assertRaises(ValueError):
            project_catalog("intl", "live2d", missing)
