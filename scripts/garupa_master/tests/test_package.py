from __future__ import annotations

import json
import stat
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.garupa_master.package import (
    PackagePreparationError,
    prepare_package,
)


class PackagePreparationTests(unittest.TestCase):
    def test_extracts_only_manifest_listed_splits(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "game.xapk"
            manifest = {
                "package_name": "jp.co.craftegg.band",
                "version_name": "9.9.9",
                "split_apks": [
                    {"id": "base", "file": "base.apk"},
                    {"id": "config.arm64_v8a", "file": "arm64.apk"},
                ],
            }
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("base.apk", b"base")
                archive.writestr("arm64.apk", b"arm64")
                archive.writestr("unlisted.bin", b"ignored")

            output = root / "output"
            selection = prepare_package(
                package,
                output,
                root / "selection.json",
                package_name="jp.co.craftegg.band",
            )

            self.assertEqual(selection["kind"], "xapk")
            self.assertEqual(Path(selection["baseApk"]).read_bytes(), b"base")
            self.assertEqual(
                sorted(path.name for path in output.iterdir()),
                ["arm64.apk", "base.apk"],
            )

    def test_rejects_symlink_entry(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "game.xapk"
            manifest = {
                "package_name": "jp.co.craftegg.band",
                "version_name": "9.9.9",
                "split_apks": [{"id": "base", "file": "base.apk"}],
            }
            symlink = zipfile.ZipInfo("link")
            symlink.create_system = 3
            symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("base.apk", b"base")
                archive.writestr(symlink, "base.apk")

            with self.assertRaisesRegex(PackagePreparationError, "non-regular"):
                prepare_package(
                    package,
                    root / "output",
                    root / "selection.json",
                    package_name="jp.co.craftegg.band",
                )


if __name__ == "__main__":
    unittest.main()
