"""Build browser-ready Cubism files from canonical Unity object archives.

Every input is resolved through ``AssetBundle.m_Container`` metadata.  The
builder never infers a Unity source path from a downloaded bundle filename.
"""

from __future__ import annotations

import math
import re
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

from core.config import ServerConfig
from core.manifests import atomic_write, read_json, write_json
from core.paths import build_layout
from core.unity_objects import UnityObjectStore


LIVE2D_ROOT = re.compile(
    r"^(Assets/AddressableResources/Character/Live2D/"
    r"(?:([0-9]{3})_(adv|live)|sub_([^/]+))/([^/]+))/",
    re.IGNORECASE,
)
DEFAULT_TANGENT_WEIGHT = 1 / 3


def _number(value: Any, fallback: float = 0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _slope(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return 0 if math.isnan(number) else number


def _weight(value: Any) -> float:
    return max(0, min(1, _number(value, DEFAULT_TANGENT_WEIGHT)))


def motion3_from_fade_asset(data: dict[str, Any]) -> dict[str, Any]:
    """Convert serialized Unity AnimationCurves to Cubism motion3 curves."""

    ids = data.get("ParameterIds") if isinstance(data.get("ParameterIds"), list) else []
    source_curves = data.get("ParameterCurves") if isinstance(data.get("ParameterCurves"), list) else []
    fade_in = data.get("ParameterFadeInTimes") if isinstance(data.get("ParameterFadeInTimes"), list) else []
    fade_out = data.get("ParameterFadeOutTimes") if isinstance(data.get("ParameterFadeOutTimes"), list) else []
    curves: list[dict[str, Any]] = []
    key_duration = 0.0
    total_segments = 0
    total_points = 0
    restricted = True

    for index, raw_id in enumerate(ids):
        parameter_id = str(raw_id or "")
        raw_points = source_curves[index].get("m_Curve", []) if index < len(source_curves) else []
        points = sorted(
            (
                {
                    "time": _number(point.get("time")),
                    "value": _number(point.get("value")),
                    "inSlope": _slope(point.get("inSlope")),
                    "outSlope": _slope(point.get("outSlope")),
                    "weightedMode": int(_number(point.get("weightedMode"))),
                    "inWeight": _weight(point.get("inWeight")),
                    "outWeight": _weight(point.get("outWeight")),
                }
                for point in raw_points
                if isinstance(point, dict)
            ),
            key=lambda point: point["time"],
        )
        if not parameter_id or not points:
            continue

        segments: list[float | int] = [points[0]["time"], points[0]["value"]]
        curve_points = 1
        for left, right in zip(points, points[1:]):
            duration = right["time"] - left["time"]
            if not math.isfinite(left["outSlope"]) or not math.isfinite(right["inSlope"]):
                segments.extend((2, right["time"], right["value"]))
                curve_points += 1
                continue
            linear_slope = (right["value"] - left["value"]) / duration if duration > 0 else 0
            if left["outSlope"] == linear_slope and right["inSlope"] == linear_slope:
                segments.extend((0, right["time"], right["value"]))
                curve_points += 1
                continue
            out_weight = left["outWeight"] if left["weightedMode"] & 2 else DEFAULT_TANGENT_WEIGHT
            in_weight = right["inWeight"] if right["weightedMode"] & 1 else DEFAULT_TANGENT_WEIGHT
            segments.extend(
                (
                    1,
                    left["time"] + duration * out_weight,
                    left["value"] + left["outSlope"] * duration * out_weight,
                    right["time"] - duration * in_weight,
                    right["value"] - right["inSlope"] * duration * in_weight,
                    right["time"],
                    right["value"],
                )
            )
            curve_points += 3
            if out_weight != DEFAULT_TANGENT_WEIGHT or in_weight != DEFAULT_TANGENT_WEIGHT:
                restricted = False

        key_duration = max(key_duration, points[-1]["time"])
        total_segments += max(0, len(points) - 1)
        total_points += curve_points
        curve: dict[str, Any] = {"Target": "Parameter", "Id": parameter_id, "Segments": segments}
        parameter_fade_in = _number(fade_in[index], -1) if index < len(fade_in) else -1
        parameter_fade_out = _number(fade_out[index], -1) if index < len(fade_out) else -1
        if parameter_fade_in >= 0:
            curve["FadeInTime"] = parameter_fade_in
        if parameter_fade_out >= 0:
            curve["FadeOutTime"] = parameter_fade_out
        curves.append(curve)

    raw_duration = data.get("MotionLength")
    duration = _number(raw_duration, key_duration)
    if duration < 0:
        duration = key_duration
    return {
        "Version": 3,
        "Meta": {
            "Duration": duration,
            "Fps": 30,
            "Loop": False,
            "AreBeziersRestricted": restricted,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_segments,
            "TotalPointCount": total_points,
            "UserDataCount": 0,
            "TotalUserDataSize": 0,
        },
        "Curves": curves,
    }


def exp3_from_expression_asset(data: dict[str, Any]) -> dict[str, Any]:
    blends = ("Overwrite", "Add", "Multiply")
    parameters = []
    for value in data.get("Parameters", []):
        if not isinstance(value, dict) or not value.get("Id"):
            continue
        raw_blend = value.get("Blend", 1)
        try:
            blend_index = int(raw_blend)
        except (TypeError, ValueError):
            blend_index = -1
        blend = blends[blend_index] if 0 <= blend_index < len(blends) else str(raw_blend or "Add")
        parameters.append({"Id": str(value["Id"]), "Value": _number(value.get("Value")), "Blend": blend})
    return {
        "Type": "Live2D Expression",
        "FadeInTime": _number(data.get("FadeInTime"), 1),
        "FadeOutTime": _number(data.get("FadeOutTime"), 1),
        "Parameters": parameters,
    }


def _vector2(value: Any, fallback: dict[str, float] | None = None) -> dict[str, float]:
    value = value if isinstance(value, dict) else (fallback or {})
    return {"X": _number(value.get("x")), "Y": _number(value.get("y"))}


def _normalization(value: Any) -> dict[str, float]:
    value = value if isinstance(value, dict) else {}
    return {
        "Minimum": _number(value.get("Minimum")),
        "Default": _number(value.get("Default")),
        "Maximum": _number(value.get("Maximum")),
    }


def physics3_from_rig(rig: dict[str, Any]) -> dict[str, Any] | None:
    sub_rigs = rig.get("SubRigs") if isinstance(rig.get("SubRigs"), list) else []
    if not sub_rigs:
        return None
    component_names = ("X", "Y", "Angle")
    settings = []
    input_count = output_count = vertex_count = 0
    for index, sub_rig in enumerate(sub_rigs):
        setting_id = f"PhysicsSetting{index + 1}"
        inputs = []
        for value in sub_rig.get("Input", []):
            source_id = str(value.get("SourceId") or "")
            if not source_id:
                continue
            component = int(_number(value.get("SourceComponent"), 2))
            inputs.append(
                {
                    "Source": {"Target": "Parameter", "Id": source_id},
                    "Weight": _number(value.get("Weight")),
                    "Type": component_names[component] if 0 <= component < 3 else "Angle",
                    "Reflect": bool(value.get("IsInverted")),
                }
            )
        outputs = []
        for value in sub_rig.get("Output", []):
            destination = str(value.get("DestinationId") or "")
            if not destination:
                continue
            component = int(_number(value.get("SourceComponent"), 2))
            component_name = component_names[component] if 0 <= component < 3 else "Angle"
            translation = value.get("TranslationScale") if isinstance(value.get("TranslationScale"), dict) else {}
            scale = value.get("AngleScale") if component_name == "Angle" else translation.get(component_name.lower())
            outputs.append(
                {
                    "Destination": {"Target": "Parameter", "Id": destination},
                    "VertexIndex": max(0, int(_number(value.get("ParticleIndex")))),
                    "Scale": _number(scale),
                    "Weight": _number(value.get("Weight")),
                    "Type": component_name,
                    "Reflect": bool(value.get("IsInverted")),
                }
            )
        vertices = [
            {
                "Position": _vector2(value.get("InitialPosition")),
                "Mobility": _number(value.get("Mobility")),
                "Delay": _number(value.get("Delay")),
                "Acceleration": _number(value.get("Acceleration")),
                "Radius": _number(value.get("Radius")),
            }
            for value in sub_rig.get("Particles", [])
            if isinstance(value, dict)
        ]
        input_count += len(inputs)
        output_count += len(outputs)
        vertex_count += len(vertices)
        normalization = sub_rig.get("Normalization") if isinstance(sub_rig.get("Normalization"), dict) else {}
        settings.append(
            {
                "Id": setting_id,
                "Input": inputs,
                "Output": outputs,
                "Vertices": vertices,
                "Normalization": {
                    "Position": _normalization(normalization.get("Position")),
                    "Angle": _normalization(normalization.get("Angle")),
                },
            }
        )
    return {
        "Version": 3,
        "Meta": {
            "PhysicsSettingCount": len(settings),
            "TotalInputCount": input_count,
            "TotalOutputCount": output_count,
            "TotalVertexCount": vertex_count,
            "VertexCount": vertex_count,
            "EffectiveForces": {
                "Gravity": _vector2(rig.get("Gravity"), {"x": 0, "y": -1}),
                "Wind": _vector2(rig.get("Wind"), {"x": 0, "y": 0}),
            },
            "Fps": _number(rig.get("Fps"), 60),
            "PhysicsDictionary": [
                {"Id": setting["Id"], "Name": str(sub_rigs[index].get("Name") or setting["Id"])}
                for index, setting in enumerate(settings)
            ],
        },
        "PhysicsSettings": settings,
    }


def _reference_id(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    try:
        file_id = int(value.get("m_FileID") or value.get("file_id") or 0)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Live2D pointer has an invalid file ID: {value!r}") from error
    if file_id:
        raise ValueError(
            "Live2D local object graph contains an unsupported external pointer: "
            f"{file_id}:{value.get('m_PathID') or value.get('path_id') or 0}"
        )
    raw = value.get("m_PathID") or value.get("path_id") or ""
    return str(raw) if raw else ""


def _model_identity(match: re.Match[str]) -> tuple[str, str, str, str, int | None, bool]:
    _, character, raw_mode, sub_character, directory = match.groups()
    model_name = directory
    if character:
        costume = re.sub(r"^(?:adv_)?live2d_[a-z0-9]+_[0-9]{3}_", "", model_name, flags=re.IGNORECASE)
        return f"{character}_{costume}", costume, raw_mode or "adv", character, int(character), False
    costume = re.sub(
        rf"^adv_live2d_sub_{re.escape(sub_character or '')}_",
        "",
        model_name,
        flags=re.IGNORECASE,
    )
    character_key = f"sub_{sub_character}"
    return f"{character_key}_{costume}", costume or directory, "adv", character_key, None, True


def _profile(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    for record in records.values():
        data = record.get("data")
        if not isinstance(data, dict) or ("BasePosition" not in data and "BaseScale" not in data):
            continue
        position = data.get("BasePosition") if isinstance(data.get("BasePosition"), dict) else {}
        return {
            "basePosition": {axis: _number(position.get(axis)) for axis in ("x", "y", "z")},
            "baseScale": _number(data.get("BaseScale"), 1),
            "defaultMotionName": str(data.get("DefaultMotionName") or ""),
            "defaultExpressionName": str(data.get("DefaultExpressionName") or ""),
            "anchors": _anchors(records),
        }
    return {"basePosition": {"x": 0, "y": 0, "z": 0}, "baseScale": 1, "anchors": {}}


def _anchors(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    transforms = {object_id: value for object_id, value in records.items() if value.get("type") == "Transform"}
    result = {}
    for key, game_object_name in (("head", "Head"), ("stomach", "Stomach")):
        game_object = next(
            (
                value.get("data", {})
                for value in records.values()
                if value.get("type") == "GameObject" and value.get("data", {}).get("m_Name") == game_object_name
            ),
            None,
        )
        if not game_object:
            continue
        components = game_object.get("m_Component") or []
        transform_id = _reference_id(components[0].get("component")) if components else ""
        chain: list[dict[str, Any]] = []
        seen = set()
        while transform_id and transform_id not in seen and transform_id in transforms:
            seen.add(transform_id)
            data = transforms[transform_id].get("data", {})
            chain.append(data)
            transform_id = _reference_id(data.get("m_Father"))
        position = {"x": 0.0, "y": 0.0, "z": 0.0}
        scale = {"x": 1.0, "y": 1.0, "z": 1.0}
        for data in reversed(chain):
            local_position = data.get("m_LocalPosition") if isinstance(data.get("m_LocalPosition"), dict) else {}
            local_scale = data.get("m_LocalScale") if isinstance(data.get("m_LocalScale"), dict) else {}
            for axis in position:
                position[axis] += scale[axis] * _number(local_position.get(axis))
                scale[axis] *= _number(local_scale.get(axis), 1) or 1
        if chain:
            result[key] = {"position": position, "scale": scale}
    return result


def _harmonic_motion(records: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    controller = None
    parameters = []
    for record in records.values():
        if record.get("type") != "MonoBehaviour":
            continue
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if isinstance(data.get("ChannelTimescales"), list):
            controller = {
                "blendMode": int(_number(data.get("BlendMode"))),
                "channelTimescales": [_number(value, 1) for value in data["ChannelTimescales"]] or [1],
            }
            continue
        if not all(key in data for key in ("NormalizedOrigin", "NormalizedRange", "Duration")):
            continue
        game_object = records.get(_reference_id(data.get("m_GameObject")), {}).get("data", {})
        parameter_id = str(game_object.get("m_Name") or "")
        duration = _number(data.get("Duration"))
        if parameter_id and duration > 0:
            parameters.append(
                {
                    "id": parameter_id,
                    "channel": int(_number(data.get("Channel"))),
                    "direction": int(_number(data.get("Direction"), 2)),
                    "normalizedOrigin": _number(data.get("NormalizedOrigin"), 0.5),
                    "normalizedRange": _number(data.get("NormalizedRange"), 0.5),
                    "duration": duration,
                }
            )
    if not controller and not parameters:
        return None
    return {
        "blendMode": controller["blendMode"] if controller else 0,
        "channelTimescales": controller["channelTimescales"] if controller else [1],
        "parameters": sorted(parameters, key=lambda value: (value["channel"], value["id"])),
    }


def _motion_sync(records: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    parameter_ids: dict[str, str] = {}
    for object_id, record in records.items():
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        name = str(data.get("m_Name") or "")
        if record.get("type") != "GameObject" or not name.startswith("Param"):
            continue
        parameter_ids[object_id] = name
        for component in data.get("m_Component", []):
            reference = _reference_id(component.get("component"))
            if reference:
                parameter_ids[reference] = name
    for record in records.values():
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        source = data.get("_motionSyncData")
        if not isinstance(source, dict) or not isinstance(source.get("Settings"), list):
            continue
        settings = []
        for setting in source["Settings"]:
            parameters = [
                {
                    "id": parameter_ids.get(_reference_id(value.get("Parameter")), ""),
                    "min": _number(value.get("Min")),
                    "max": _number(value.get("Max")),
                    "damper": _number(value.get("Damper")),
                    "smooth": int(_number(value.get("Smooth"))),
                }
                for value in setting.get("CubismParameters", [])
            ]
            parameters = [value for value in parameters if value["id"]]
            audio_parameters = [
                {
                    "id": str(value.get("Id") or ""),
                    "name": str(value.get("Name") or value.get("Id") or ""),
                    "min": _number(value.get("Min")),
                    "max": _number(value.get("Max"), 1),
                    "scale": _number(value.get("Scale"), 1),
                    "enabled": bool(value.get("Enabled")),
                }
                for value in setting.get("AudioParameters", [])
                if value.get("Id")
            ]
            mappings = []
            for mapping in setting.get("Mappings", []):
                targets = [
                    {
                        "id": parameter_ids.get(_reference_id(target.get("Parameter")), ""),
                        "value": _number(target.get("Value")),
                    }
                    for target in mapping.get("Targets", [])
                ]
                targets = [target for target in targets if target["id"]]
                audio_id = str(mapping.get("AudioParameterId") or "")
                if audio_id and targets:
                    mappings.append({"type": int(_number(mapping.get("Type"))), "audioParameterId": audio_id, "targets": targets})
            if parameters and audio_parameters and mappings:
                post = setting.get("PostProcessing") if isinstance(setting.get("PostProcessing"), dict) else {}
                settings.append(
                    {
                        "id": str(setting.get("Id") or ""),
                        "parameters": parameters,
                        "audioParameters": audio_parameters,
                        "mappings": mappings,
                        "postProcessing": {
                            "blendRatio": _number(post.get("BlendRatio"), 1),
                            "smoothing": int(_number(post.get("Smoothing"), 100)),
                            "sampleRate": _number(post.get("SampleRate"), 30),
                        },
                        "emphasisLevel": _number(setting.get("EmphasisLevel")),
                    }
                )
        return {"settings": settings} if settings else None
    return None


def _moc_payload(store: UnityObjectStore, paths: list[str], model_root: str) -> tuple[bytes, str]:
    prefix = f"{model_root}/model/generated/"
    for source_path in paths:
        if not source_path.startswith(prefix) or not source_path.endswith(".asset") or "masktexture" in source_path.casefold():
            continue
        data = store.source_data(source_path) or {}
        raw = data.get("_bytes")
        if isinstance(raw, list):
            payload = bytes(int(value) & 255 for value in raw)
            if payload.startswith(b"MOC3"):
                return payload, source_path
    raise ValueError(f"Live2D MOC3 source is missing: {model_root}")


def _runtime_url(server: str, key: str, relative: str) -> str:
    return f"/runtime/{server}/live2d/{key}/{relative}"


def build_live2d(config: ServerConfig, source_id: str, build_id: str) -> dict[str, Any]:
    layout = build_layout(config.id, build_id)
    index = read_json(layout.metadata / "source-index.json")
    paths = sorted(index.get("sources", {}))
    store = UnityObjectStore(layout, index)
    models: dict[str, dict[str, Any]] = {}
    skipped_models: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    shutil.rmtree(layout.runtime / "live2d", ignore_errors=True)

    roots: dict[str, re.Match[str]] = {}
    for path in paths:
        if match := LIVE2D_ROOT.match(path):
            roots.setdefault(match.group(1), match)

    for model_root, match in sorted(roots.items()):
        key, live2d_name, raw_mode, character_key, character_id, sub_character = _model_identity(match)
        if key in seen_keys:
            raise ValueError(f"duplicate Live2D key: {key}")
        seen_keys.add(key)
        model_name = PurePosixPath(model_root).name
        source_path = f"{model_root}/model/{model_name}.prefab"

        missing = []
        if source_path not in index.get("sources", {}):
            missing.append("prefab")
        try:
            moc, moc_source = _moc_payload(store, paths, model_root)
        except ValueError:
            moc = b""
            moc_source = ""
            missing.append("moc3")
        texture_prefix = f"{model_root}/model/"
        texture_paths = [
            value
            for value in paths
            if value.startswith(texture_prefix)
            and f"/{model_name}.2048/" in value
            and value.casefold().endswith(".png")
            and (layout.assets / Path(*PurePosixPath(value).parts)).is_file()
        ]
        if not texture_paths:
            missing.append("textures")
        if missing:
            skipped_models.append(
                {
                    "live2dKey": key,
                    "modelRoot": model_root,
                    "expectedPrefabPath": source_path,
                    "reason": "incomplete-source",
                    "missing": missing,
                    **({"sourcePath": source_path} if "prefab" not in missing else {}),
                }
            )
            continue

        descriptor = store.descriptor(source_path)
        records = store.records(
            descriptor["selectedBundle"], descriptor["serializedFile"]
        )
        runtime_dir = layout.runtime / "live2d" / key

        atomic_write(runtime_dir / "model.moc3", moc)
        textures = [f"/assets/{config.id}/{value}" for value in texture_paths]

        motions = []
        motion_references = []
        motion_prefix = f"{model_root}/common/motions/"
        for value in paths:
            if not value.startswith(motion_prefix) or not value.casefold().endswith(".fade.asset"):
                continue
            data = store.source_data(value)
            if not data:
                continue
            name = PurePosixPath(value).name.removesuffix(".fade.asset")
            relative = f"motions/{name}.motion3.json"
            write_json(runtime_dir / relative, motion3_from_fade_asset(data))
            fade_in = _number(data.get("FadeInTime"), 1)
            fade_out = _number(data.get("FadeOutTime"), 1)
            motions.append(
                {
                    "name": name,
                    "sourcePath": value,
                    "runtime": _runtime_url(config.id, key, relative),
                    "fadeInTime": fade_in,
                    "fadeOutTime": fade_out,
                }
            )
            motion_references.append({"File": relative, "FadeInTime": fade_in, "FadeOutTime": fade_out})

        expressions = []
        expression_references = []
        expression_prefix = f"{model_root}/common/expressions/"
        for value in paths:
            if not value.startswith(expression_prefix) or not value.casefold().endswith(".exp3.asset"):
                continue
            data = store.source_data(value)
            if not data:
                continue
            name = PurePosixPath(value).name.removesuffix(".exp3.asset")
            relative = f"expressions/{name}.exp3.json"
            write_json(runtime_dir / relative, exp3_from_expression_asset(data))
            expressions.append({"name": name, "sourcePath": value, "runtime": _runtime_url(config.id, key, relative)})
            expression_references.append({"Name": name, "File": relative})

        physics = next(
            (
                physics3_from_rig(data["_rig"])
                for record in records.values()
                if isinstance((data := record.get("data")), dict)
                and isinstance(data.get("_rig"), dict)
                and data["_rig"].get("SubRigs")
            ),
            None,
        )
        if physics:
            write_json(runtime_dir / "physics3.json", physics)

        model3 = {
            "Version": 3,
            "FileReferences": {
                "Moc": "model.moc3",
                "Textures": textures,
                **({"Physics": "physics3.json"} if physics else {}),
                "Motions": {"Motion": motion_references},
                "Expressions": expression_references,
            },
            "Groups": [
                {"Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen", "ParamEyeROpen"]},
                {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]},
            ],
        }
        write_json(runtime_dir / "model3.json", model3)
        harmonic = _harmonic_motion(records)
        motion_sync = _motion_sync(records)
        runtime = {
            "model": _runtime_url(config.id, key, "model3.json"),
            "moc": _runtime_url(config.id, key, "model.moc3"),
            "physics": _runtime_url(config.id, key, "physics3.json") if physics else None,
            "textures": textures,
            "harmonicMotion": harmonic,
            "motionSync": motion_sync,
        }
        models[key] = {
            "live2dKey": key,
            "live2dName": live2d_name,
            "modelType": "live" if raw_mode == "live" else "adv",
            "mode": raw_mode,
            "quality": "low" if key.casefold().endswith("_low") else None,
            "costumeId": None,
            "assetId": None,
            "characterId": character_id,
            "characterKey": character_key,
            "subCharacter": sub_character,
            "sourcePath": source_path,
            "mocSourcePath": moc_source,
            "profile": _profile(records),
            "runtime": runtime,
            "motions": motions,
            "expressions": expressions,
            "harmonicMotion": harmonic,
        }

    result = {
        "schema": "haneoka-live2d-build-v1",
        "server": config.id,
        "sourceId": source_id,
        "modelCount": len(models),
        "skippedModelCount": len(skipped_models),
        "models": models,
        "skippedModels": skipped_models,
    }
    write_json(layout.metadata / "live2d.json", result, pretty=True)
    return result
