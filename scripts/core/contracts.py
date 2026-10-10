"""Versioned contracts shared by every resource-pipeline stage."""

import re

PIPELINE_CONTRACT = "haneoka-resource-pipeline-v1"
SOURCE_SCHEMA = "haneoka-resource-source-v1"
BUILD_SCHEMA = "haneoka-resource-build-v1"
RELEASE_SCHEMA = "haneoka-resource-release-v1"
RELEASE_IDENTITY_SCHEMA = "haneoka-resource-release-identity-v1"
RELEASE_IDENTITY_FILENAME = "release-identity.json"
POINTER_SCHEMA = "haneoka-resource-pointer-v1"
RELEASE_TREES = ("assets", "runtime", "objects", "api", "metadata", "game-client")
GAME_CLIENT_SCHEMA = "haneoka-game-client-v1"
GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA = "haneoka-game-client-addressables-index-v1"
UNITY_INDEX_SCHEMA = "haneoka-unity-index-v1"
CATALOG_PROVENANCE_SCHEMA = "haneoka-catalog-provenance-v1"
CATALOG_STORAGE_SCHEMA = "haneoka-catalog-storage-v2"
CATALOG_SUMMARY_SCHEMA = "haneoka-catalog-summary-v1"
STORY_ASSETS_SCHEMA = "haneoka-story-assets-v2"
ANON_TOKYO_SCHEMA = "haneoka-anon-tokyo-v1"
SPINE_CATALOG_SCHEMA = "haneoka-spine-catalog-v1"
SOURCE_INDEX_STORAGE_SCHEMA = "haneoka-source-index-storage-v2"
CATALOG_PARTITION_ALGORITHM = "fnv1a32-mod-256"
CATALOG_PARTITION_SHARDS = 256
# Keep package ingestion aligned with the Worker upload policy and D1 contract.
PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024

CATALOG_RESOURCES = (
    "bands",
    "characters",
    "cards",
    "support-cards",
    "songs",
    "song-meta",
    "comics",
    "stamps",
    "stories",
    "story-runtime",
    "story-assets",
    "anon-tokyo",
    "live2d",
    "spine",
    "voices",
    "audio",
    "items",
    "progression",
    "character-missions",
    "friendships",
    "band-items",
    "leader-skills",
    "skills",
    "support-skills",
    "gekisou-skills",
    "gekisou-support-skills",
    "skill-reference",
    "gekisou",
    "videos",
    "help",
    "options",
    "live-tools",
    "provenance",
    "feature-status",
    "events",
    "real-lives",
    "home-banners",
    "gacha",
    "login-campaigns",
    "shop",
    "exchange",
    "circle",
    "challenge",
    "missions",
    "passes",
    "stickers",
    "backgrounds",
    "tgw-card",
    "studio",
)

# Storage manifests created before additive feature read models shipped do not
# contain them. Consumers may keep reading those releases; every newly
# compiled catalog still uses the complete CATALOG_RESOURCES tuple.
CATALOG_OPTIONAL_RESOURCES = (
    "story-assets", "anon-tokyo", "spine", "events", "real-lives", "home-banners", "gacha",
    "login-campaigns", "shop", "exchange", "circle", "challenge",
    "missions", "passes", "stickers", "backgrounds", "tgw-card", "studio",
)
CATALOG_REQUIRED_RESOURCES = tuple(
    resource for resource in CATALOG_RESOURCES if resource not in CATALOG_OPTIONAL_RESOURCES
)


def release_identity_descriptor(server: str, release_id: str, manifest: dict) -> dict[str, str]:
    source_id = manifest.get("sourceId")
    if (
        manifest.get("schema") != RELEASE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("releaseId") != release_id
        or not re.fullmatch(r"r-[a-f0-9]{20}", release_id)
        or not isinstance(source_id, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", source_id)
    ):
        raise ValueError("release manifest identity cannot produce a release descriptor")
    return {
        "schema": RELEASE_IDENTITY_SCHEMA,
        "server": server,
        "releaseId": release_id,
        "sourceId": source_id,
    }
