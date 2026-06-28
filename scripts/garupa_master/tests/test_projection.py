from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from scripts.garupa_master.archive import DecodedSuite
from scripts.garupa_master.projection import ProjectionError, build_projections


def decoded_suite() -> DecodedSuite:
    tables = {
        1: {
            "decoded": {
                "entries": [
                    {
                        "musicId": 10,
                        "musicTitle": "First",
                        "bandId": 1,
                        "jacketImage": "first",
                        "seq": 2,
                    },
                    {
                        "musicId": 11,
                        "musicTitle": "Second",
                        "bandId": 1,
                        "jacketImage": "second",
                        "seq": 1,
                    },
                ]
            }
        },
        16: {
            "decoded": {
                "entries": [
                    {
                        "key": 1,
                        "value": {
                            "bandId": 1,
                            "bandName": "Band One",
                            "bandType": "normal",
                            "seq": 1,
                        },
                    },
                    {
                        "key": 99,
                        "value": {
                            "bandId": 99,
                            "bandName": "NPC",
                            "bandType": "other",
                            "seq": 99,
                        },
                    },
                ]
            }
        },
        1190: {
            "decoded": {
                "entries": [
                    {
                        "id": 7,
                        "description": "Concert set",
                        "bandId": 1,
                        "stageChallengeType": "normal",
                    }
                ]
            }
        },
        1191: {
            "decoded": {
                "entries": [
                    {
                        "key": 7,
                        "value": {
                            "entries": [
                                {"stageChallengeStageNo": 3, "musicId": 10},
                                {"stageChallengeStageNo": 1, "musicId": 404},
                                {"stageChallengeStageNo": 2, "musicId": 10},
                            ]
                        },
                    }
                ]
            }
        },
    }
    return DecodedSuite(
        tables=tables,
        top_level_values={},
        coverage={
            "semanticStatus": "partial",
            "unknownTopLevelFields": [999],
        },
    )


def responses() -> SimpleNamespace:
    return SimpleNamespace(
        versions=SimpleNamespace(
            client_version="9.9.9",
            data_version="9.9.8",
            master_data_version="9.9.7",
        )
    )


SCHEMA = {
    "packageName": "jp.co.craftegg.band",
}


class ProjectionTests(unittest.TestCase):
    def test_preserves_stage_order_duplicates_and_missing_tracks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            publish_dir = Path(directory)
            manifest = build_projections(
                publish_dir,
                responses(),  # type: ignore[arg-type]
                decoded_suite(),
                SCHEMA,
            )
            playlists = json.loads(
                (publish_dir / "playlists.json").read_text(encoding="utf-8")
            )["playlists"]

        self.assertEqual(manifest["counts"]["bandPlaylists"], 1)
        self.assertEqual(manifest["counts"]["stageChallengePlaylists"], 1)
        self.assertEqual(manifest["counts"]["unavailablePlaylistTracks"], 1)
        self.assertFalse(any(item["sourceId"] == 99 for item in playlists))
        band = next(item for item in playlists if item["source"] == "band")
        self.assertIsNone(band["description"])

        stage = next(item for item in playlists if item["source"] == "stage-challenge")
        self.assertEqual([track["musicId"] for track in stage["tracks"]], [404, 10, 10])
        self.assertEqual([track["position"] for track in stage["tracks"]], [1, 2, 3])
        self.assertFalse(stage["tracks"][0]["available"])
        self.assertEqual(stage["tracks"][0]["missingReason"], "music-not-in-master")

    def test_rejects_duplicate_required_top_level_table(self) -> None:
        decoded = decoded_suite()
        decoded.coverage["duplicateTopLevelFields"] = [1190]
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(
                ProjectionError,
                r"masterStageChallengeList \(1190\) occurred more than once",
            ),
        ):
            build_projections(
                Path(directory),
                responses(),  # type: ignore[arg-type]
                decoded,
                SCHEMA,
            )


if __name__ == "__main__":
    unittest.main()
