"""Project verified Spine build metadata into the public catalog contract.

``metadata/spine.json`` is a build-stage artifact: it is intentionally rich
enough to audit Unity object links and compose Anon Tokyo avatars.  The public
catalog keeps that provenance, but exposes models as a partitioned collection
so a generic Spine browser never needs to download every skeleton up front.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from build.spine import PREVIEW_SCHEMA as SPINE_PREVIEW_SCHEMA
from build.spine import SCHEMA as SPINE_BUILD_SCHEMA
from core.contracts import SPINE_CATALOG_SCHEMA


JsonObject = dict[str, Any]
_UNITY_SOURCE_PREFIXES = ("Assets/", "Packages/")


def source_key(value: str) -> str:
    """Return non-public Unity provenance without making it look requestable."""

    return value.removeprefix("Assets/AddressableResources/")


def sanitize_spine_value(data: Any, value: Any) -> Any:
    """Replace unmaterialized Unity paths while preserving verified URLs.

    A SkeletonDataAsset often exists only as an object container, whereas the
    extracted TextAsset bytes are available under ``runtime/``.  Publishing the
    former as ``sourcePath`` would make generic URL validators and consumers
    treat it as a downloadable asset, so retain it as provenance instead.
    """

    if isinstance(value, list):
        return [sanitize_spine_value(data, item) for item in value]
    if not isinstance(value, dict):
        return value
    output: JsonObject = {}
    for key, item in value.items():
        if (
            key in {"sourcePath", "assetPath"}
            and isinstance(item, str)
            and item.startswith(_UNITY_SOURCE_PREFIXES)
            and not data.asset(item)
        ):
            output[f"{key}Key"] = source_key(item)
        else:
            output[key] = sanitize_spine_value(data, item)
    return output


def spine_records(value: Any, label: str) -> JsonObject:
    """Normalize old list-shaped and current ID-keyed Spine metadata safely."""

    if isinstance(value, dict):
        output: JsonObject = {}
        for key, item in value.items():
            if not isinstance(key, str) or not isinstance(item, dict):
                raise ValueError(f"Spine {label} record map is invalid")
            identity = item.get("id")
            if identity is not None and identity != key:
                raise ValueError(f"Spine {label} record id does not match its key: {key}")
            output[key] = item
        return output
    if value in (None, []):
        return {}
    if not isinstance(value, list):
        raise ValueError(f"Spine {label} records must be a map or list")
    output = {}
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError(f"Spine {label} record has no stable id")
        identity = str(item["id"])
        if identity in output:
            raise ValueError(f"Spine {label} record repeats id: {identity}")
        output[identity] = item
    return output


def read_spine_metadata(data: Any, source_id: str) -> tuple[JsonObject | None, str]:
    """Load only metadata whose identity belongs to this catalog build."""

    file = data.root / "metadata" / "spine.json"
    if not file.is_file():
        return None, "spine-build-metadata-missing"
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Spine build metadata is invalid: {file}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Spine build metadata is not an object: {file}")
    if value.get("server") != data.server or value.get("sourceId") != source_id:
        return None, "spine-build-metadata-identity-mismatch"
    if value.get("schema") != SPINE_BUILD_SCHEMA:
        return None, "spine-build-metadata-schema-mismatch"
    return value, "spine-build-metadata-present"


def _runtime_status(value: Any) -> str:
    runtime = value.get("runtime") if isinstance(value, dict) else None
    return str(runtime.get("status") or "") if isinstance(runtime, dict) else ""


def _current_rendered_preview(preview: Any, preview_schema: Any) -> bool:
    """Return whether a preview belongs to the current static-render policy.

    ``schema`` describes the metadata graph while ``previewSchema`` describes
    the pixels.  Keep those contracts separate so a source with an older
    idle/uncropped PNG can still publish its playable Spine model without
    republishing the obsolete image.
    """

    return bool(
        preview_schema == SPINE_PREVIEW_SCHEMA
        and isinstance(preview, dict)
        and preview.get("status") == "rendered"
        and preview.get("schema") == SPINE_PREVIEW_SCHEMA
    )


def _model_document(
    data: Any,
    identity: str,
    value: Any,
    preview_schema: Any,
) -> JsonObject:
    if not isinstance(value, dict):
        raise ValueError(f"Spine model is not an object: {identity}")
    model = sanitize_spine_value(data, value)
    if model.get("id") not in {None, identity}:
        raise ValueError(f"Spine model id does not match its key: {identity}")
    model["id"] = identity
    preview = model.get("preview")
    # Older build metadata has no preview schema even when it claims a setup
    # pose.  Its PNG can be a stale square capture or a renderer failure, so
    # retain the model but remove only that rendered preview.
    if isinstance(preview, dict) and preview.get("status") == "rendered" and not _current_rendered_preview(
        preview, preview_schema
    ):
        model.pop("preview", None)
    runtime = model.get("runtime")
    runtime = runtime if isinstance(runtime, dict) else {}
    ready = runtime.get("status") == "ready"
    model["status"] = "available" if ready else "unavailable"
    if not ready and "reason" not in model:
        model["reason"] = runtime.get("reason") or runtime.get("reasons") or "runtime-unavailable"
    animations = model.get("animations")
    skins = model.get("skins")
    model["animationCount"] = len(animations) if isinstance(animations, list) else 0
    model["skinCount"] = len(skins) if isinstance(skins, list) else 0
    skeleton = model.get("skeleton")
    if isinstance(skeleton, dict):
        if "spineVersion" not in model and skeleton.get("spineVersion") is not None:
            model["spineVersion"] = skeleton.get("spineVersion")
        if "bounds" not in model and skeleton.get("bounds") is not None:
            model["bounds"] = skeleton.get("bounds")
    if "scale" not in model and runtime.get("scale") is not None:
        model["scale"] = runtime.get("scale")
    model["runtimeSummary"] = {
        key: runtime[key]
        for key in (
            "status",
            "format",
            "package",
            "packageVersion",
            "runtimeSeries",
            "loader",
            "scale",
        )
        if key in runtime
    }
    return model


def spine_model_reference(value: Any) -> JsonObject:
    """Return the small cross-catalog reference retained by Anon Tokyo.

    The complete model is intentionally available only from the standalone
    ``spine`` collection entity; Anon Tokyo has enough information to link to
    it without duplicating its skeleton, atlas and texture graph.
    """

    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        raise ValueError("Spine model reference has no stable id")
    runtime = value.get("runtime")
    runtime = runtime if isinstance(runtime, dict) else {}
    reference: JsonObject = {
        "id": value["id"],
        "status": value.get("status", "unavailable"),
        "animationCount": value.get("animationCount", 0),
        "skinCount": value.get("skinCount", 0),
        "preview": value.get("preview"),
        "runtime": {
            key: runtime[key]
            for key in ("status", "package", "packageVersion", "runtimeSeries", "format")
            if key in runtime
        },
    }
    for key in ("family", "spineVersion", "scale"):
        if key in value:
            reference[key] = value[key]
    return reference


def _ordered_ids(value: Any, records: JsonObject) -> list[str]:
    requested = value if isinstance(value, list) else []
    ordered = [item for item in requested if isinstance(item, str) and item in records]
    return list(dict.fromkeys([*ordered, *sorted(key for key in records if key not in ordered)]))


def build_spine_catalog(data: Any, source_id: str) -> JsonObject:
    """Project all verified Spine models as a release-scoped collection."""

    metadata, metadata_reason = read_spine_metadata(data, source_id)
    base: JsonObject = {
        "schema": SPINE_CATALOG_SCHEMA,
        "server": data.server,
        "sourceId": source_id,
        "available": False,
        "status": "unavailable",
        "reason": metadata_reason,
        "runtime": {},
        "counts": {
            "models": 0,
            "playableModels": 0,
            "unavailableModels": 0,
            "renderedPreviews": 0,
            "unavailablePreviews": 0,
        },
        "models": {},
        "modelOrder": [],
        "unavailableModels": {},
        "unavailableModelOrder": [],
    }
    if metadata is None:
        return base

    raw_models = spine_records(metadata.get("models"), "model")
    preview_schema = metadata.get("previewSchema")
    models = {
        identity: _model_document(data, identity, value, preview_schema)
        for identity, value in raw_models.items()
    }
    order = _ordered_ids(metadata.get("modelOrder"), models)
    unavailable_ids = [
        identity for identity in order if models[identity].get("status") != "available"
    ]
    unavailable = {
        identity: spine_model_reference(models[identity]) for identity in unavailable_ids
    }
    playable = len(models) - len(unavailable)
    preview_rendered = sum(
        1
        for model in models.values()
        if isinstance(model.get("preview"), dict)
        and model["preview"].get("status") == "rendered"
    )
    browser_runtime = sanitize_spine_value(data, metadata.get("browserRuntime"))
    output: JsonObject = {
        **base,
        "available": playable > 0,
        "status": "available" if playable > 0 else "unavailable",
        "reason": (
            "spine-build-playable-models-present"
            if playable > 0
            else "spine-build-has-no-playable-models"
        ),
        **(
            {"previewSchema": SPINE_PREVIEW_SCHEMA}
            if preview_schema == SPINE_PREVIEW_SCHEMA
            else {}
        ),
        "runtime": browser_runtime if isinstance(browser_runtime, dict) else {},
        "counts": {
            "models": len(models),
            "playableModels": playable,
            "unavailableModels": len(unavailable),
            "renderedPreviews": preview_rendered,
            "unavailablePreviews": len(models) - preview_rendered,
        },
        "models": {identity: models[identity] for identity in order},
        "modelOrder": order,
        "unavailableModels": unavailable,
        "unavailableModelOrder": unavailable_ids,
        "evidence": {
            "models": "Verified Unity SkeletonDataAsset -> SpineAtlasAsset -> Material -> Texture2D links.",
            "preview": "Only renderer-produced setup-pose previews may be marked rendered; no animation state or physics pose is applied. Raw atlas pages remain explicitly unavailable fallbacks.",
            "runtime": "Runtime URLs are emitted only for extracted, release-local assets.",
        },
    }
    skipped = sanitize_spine_value(data, metadata.get("skippedSources"))
    if isinstance(skipped, list):
        output["skippedSources"] = skipped
    anon_tokyo = sanitize_spine_value(data, metadata.get("anonTokyo"))
    if isinstance(anon_tokyo, dict):
        output["anonTokyo"] = anon_tokyo
    return output
