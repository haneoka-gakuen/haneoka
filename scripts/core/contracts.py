"""Versioned contracts shared by every resource-pipeline stage."""

PIPELINE_CONTRACT = "haneoka-resource-pipeline-v1"
SOURCE_SCHEMA = "haneoka-resource-source-v1"
BUILD_SCHEMA = "haneoka-resource-build-v1"
RELEASE_SCHEMA = "haneoka-resource-release-v1"
POINTER_SCHEMA = "haneoka-resource-pointer-v1"
RELEASE_TREES = ("assets", "runtime", "objects", "api", "metadata", "game-client")
GAME_CLIENT_SCHEMA = "haneoka-game-client-v1"
GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA = "haneoka-game-client-addressables-index-v1"
UNITY_INDEX_SCHEMA = "haneoka-unity-index-v1"
CATALOG_PROVENANCE_SCHEMA = "haneoka-catalog-provenance-v1"
CATALOG_STORAGE_SCHEMA = "haneoka-catalog-storage-v2"
CATALOG_SUMMARY_SCHEMA = "haneoka-catalog-summary-v1"
STORY_ASSETS_SCHEMA = "haneoka-story-assets-v2"
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
    "live2d",
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
)

# Storage manifests created before the story editor shipped do not contain the
# additive story-assets read model.  Consumers may keep reading those releases;
# every newly compiled catalog still uses the complete CATALOG_RESOURCES tuple.
CATALOG_REQUIRED_RESOURCES = tuple(
    resource for resource in CATALOG_RESOURCES if resource != "story-assets"
)
