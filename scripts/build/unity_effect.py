"""Serialize a Unity effect prefab for the shared Three.js particle runtime.

The normalized resource build keeps exact int64 object identifiers and the
complete Unity object archive.  This module translates that archive into the
same compact runtime contract consumed by ``UnityParticleEffect``; no
effect-specific visual adaptation belongs in the story player.
"""

from __future__ import annotations

import ast
import math
import struct
import zlib
from typing import Any


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _finite(value: Any, default: float = 0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return float(default)
    return result if math.isfinite(result) else float(default)


def _integer(value: Any, default: int = 0) -> int:
    return int(math.trunc(_finite(value, default)))


def _pointer_id(value: Any) -> str:
    raw = _record(value)
    try:
        return str(int(raw.get("m_PathID") or 0))
    except (TypeError, ValueError):
        return "0"


def _file_id(value: Any) -> int:
    return _integer(_record(value).get("m_FileID"))


def _identity_key(identity: tuple[str, str] | None) -> str:
    return f"{identity[0]}:{identity[1]}" if identity is not None else "0"


def _vector2(value: Any, default: float = 0) -> dict[str, float]:
    raw = _record(value)
    return {key: _finite(raw.get(key), default) for key in ("x", "y")}


def _vector3(value: Any, default: float = 0) -> dict[str, float]:
    raw = _record(value)
    return {key: _finite(raw.get(key), default) for key in ("x", "y", "z")}


def _quaternion(value: Any) -> dict[str, float]:
    raw = _record(value)
    return {
        "x": _finite(raw.get("x")),
        "y": _finite(raw.get("y")),
        "z": _finite(raw.get("z")),
        "w": _finite(raw.get("w"), 1),
    }


def _color(value: Any, default_alpha: float = 1) -> dict[str, float]:
    raw = _record(value)
    return {
        "r": _finite(raw.get("r"), 1),
        "g": _finite(raw.get("g"), 1),
        "b": _finite(raw.get("b"), 1),
        "a": _finite(raw.get("a"), default_alpha),
    }


def _curve(value: Any) -> dict[str, Any]:
    raw = _record(value)
    keys = raw.get("m_Curve") if isinstance(raw.get("m_Curve"), list) else []
    return {
        "preInfinity": _finite(raw.get("m_PreInfinity"), 2),
        "postInfinity": _finite(raw.get("m_PostInfinity"), 2),
        "rotationOrder": _finite(raw.get("m_RotationOrder"), 4),
        "keys": [
            {
                "time": _finite(_record(key).get("time")),
                "value": _finite(_record(key).get("value")),
                "inSlope": _finite(_record(key).get("inSlope")),
                "outSlope": _finite(_record(key).get("outSlope")),
                "weightedMode": _finite(_record(key).get("weightedMode")),
                "inWeight": _finite(_record(key).get("inWeight"), 1 / 3),
                "outWeight": _finite(_record(key).get("outWeight"), 1 / 3),
            }
            for key in keys
        ],
    }


def _min_max_curve(value: Any) -> dict[str, Any]:
    raw = _record(value)
    return {
        "mode": max(0, min(3, _integer(raw.get("minMaxState")))),
        "multiplier": _finite(raw.get("scalar")),
        "constantMin": _finite(raw.get("minScalar")),
        "constantMax": _finite(raw.get("scalar")),
        "curveMin": _curve(raw.get("minCurve")),
        "curveMax": _curve(raw.get("maxCurve")),
    }


def _gradient(value: Any) -> dict[str, Any]:
    raw = _record(value)
    color_count = max(0, min(8, _integer(raw.get("m_NumColorKeys"))))
    alpha_count = max(0, min(8, _integer(raw.get("m_NumAlphaKeys"))))
    return {
        "mode": _integer(raw.get("m_Mode")),
        "colorSpace": _integer(raw.get("m_ColorSpace"), -1),
        "colorKeys": [
            {
                "time": _finite(raw.get(f"ctime{index}")) / 65535,
                "color": _color(raw.get(f"key{index}")),
            }
            for index in range(color_count)
        ],
        "alphaKeys": [
            {
                "time": _finite(raw.get(f"atime{index}")) / 65535,
                "alpha": _finite(_record(raw.get(f"key{index}")).get("a"), 1),
            }
            for index in range(alpha_count)
        ],
    }


def _min_max_gradient(value: Any) -> dict[str, Any]:
    raw = _record(value)
    return {
        "mode": max(0, min(4, _integer(raw.get("minMaxState")))),
        "colorMin": _color(raw.get("minColor")),
        "colorMax": _color(raw.get("maxColor")),
        "gradientMin": _gradient(raw.get("minGradient")),
        "gradientMax": _gradient(raw.get("maxGradient")),
    }


def _module(data: dict[str, Any], name: str, serializer: Any) -> Any:
    value = _record(data.get(name))
    return serializer(value) if value.get("enabled") else None


def _particle_system(
    object_id: str,
    entry: dict[str, Any],
    source: str,
    mesh_key: Any,
    sprite_key: Any,
) -> dict[str, Any]:
    raw = _record(entry.get("data"))
    initial = _record(raw.get("InitialModule"))
    emission = _module(
        raw,
        "EmissionModule",
        lambda value: {
            "rateOverTime": _min_max_curve(value.get("rateOverTime")),
            "rateOverDistance": _min_max_curve(value.get("rateOverDistance")),
            "bursts": [
                {
                    "time": _finite(_record(burst).get("time")),
                    "count": _min_max_curve(_record(burst).get("countCurve")),
                    "cycleCount": max(0, _integer(_record(burst).get("cycleCount"), 1)),
                    "repeatInterval": _finite(_record(burst).get("repeatInterval")),
                    "probability": _finite(_record(burst).get("probability"), 1),
                }
                for burst in (
                    value.get("m_Bursts")[: max(0, _integer(value.get("m_BurstCount")))]
                    if isinstance(value.get("m_Bursts"), list)
                    else []
                )
            ],
        },
    )
    shape = _module(
        raw,
        "ShapeModule",
        lambda value: {
            "type": _integer(value.get("type")),
            "angle": _finite(value.get("angle"), 25),
            "length": _finite(value.get("length"), 5),
            "radius": _finite(_record(value.get("radius")).get("value"), 1),
            "radiusThickness": _finite(value.get("radiusThickness"), 1),
            "arc": _finite(_record(value.get("arc")).get("value"), 360),
            "boxThickness": _vector3(value.get("boxThickness")),
            "position": _vector3(value.get("m_Position")),
            "rotation": _vector3(value.get("m_Rotation")),
            "scale": _vector3(value.get("m_Scale"), 1),
            "placementMode": _integer(value.get("placementMode")),
            "meshId": mesh_key(value.get("m_Mesh")),
            "spriteId": sprite_key(value.get("m_Sprite")),
            "alignToDirection": bool(value.get("alignToDirection")),
            "randomDirectionAmount": _finite(value.get("randomDirectionAmount")),
            "sphericalDirectionAmount": _finite(value.get("sphericalDirectionAmount")),
            "randomPositionAmount": _finite(value.get("randomPositionAmount")),
        },
    )

    def size(value):
        return {
            "separateAxes": bool(value.get("separateAxes")),
            "x": _min_max_curve(value.get("curve")),
            "y": _min_max_curve(value.get("y")),
            "z": _min_max_curve(value.get("z")),
        }

    velocity = _module(
        raw,
        "VelocityModule",
        lambda value: {
            **{key: _min_max_curve(value.get(key)) for key in ("x", "y", "z")},
            "orbitalX": _min_max_curve(value.get("orbitalX")),
            "orbitalY": _min_max_curve(value.get("orbitalY")),
            "orbitalZ": _min_max_curve(value.get("orbitalZ")),
            "orbitalOffsetX": _min_max_curve(value.get("orbitalOffsetX")),
            "orbitalOffsetY": _min_max_curve(value.get("orbitalOffsetY")),
            "orbitalOffsetZ": _min_max_curve(value.get("orbitalOffsetZ")),
            "radial": _min_max_curve(value.get("radial")),
            "speedModifier": _min_max_curve(value.get("speedModifier")),
            "inWorldSpace": bool(value.get("inWorldSpace")),
        },
    )
    limit_velocity = _module(
        raw,
        "ClampVelocityModule",
        lambda value: {
            "separateAxes": bool(value.get("separateAxis")),
            **{key: _min_max_curve(value.get(key)) for key in ("x", "y", "z")},
            "magnitude": _min_max_curve(value.get("magnitude")),
            "dampen": _finite(value.get("dampen")),
            "drag": _min_max_curve(value.get("drag")),
            "inWorldSpace": bool(value.get("inWorldSpace")),
            "multiplyDragByParticleSize": bool(value.get("multiplyDragByParticleSize")),
            "multiplyDragByParticleVelocity": bool(value.get("multiplyDragByParticleVelocity")),
        },
    )
    noise = _module(
        raw,
        "NoiseModule",
        lambda value: {
            "separateAxes": bool(value.get("separateAxes")),
            "strengthX": _min_max_curve(value.get("strength")),
            "strengthY": _min_max_curve(value.get("strengthY")),
            "strengthZ": _min_max_curve(value.get("strengthZ")),
            "frequency": _finite(value.get("frequency"), 0.5),
            "damping": bool(value.get("damping")),
            "octaves": max(1, _integer(value.get("octaves"), 1)),
            "octaveMultiplier": _finite(value.get("octaveMultiplier"), 0.5),
            "octaveScale": _finite(value.get("octaveScale"), 2),
            "quality": _integer(value.get("quality"), 1),
            "scrollSpeed": _min_max_curve(value.get("scrollSpeed")),
            "remapEnabled": bool(value.get("remapEnabled")),
            "remapX": _min_max_curve(value.get("remap")),
            "remapY": _min_max_curve(value.get("remapY")),
            "remapZ": _min_max_curve(value.get("remapZ")),
            "positionAmount": _min_max_curve(value.get("positionAmount")),
            "rotationAmount": _min_max_curve(value.get("rotationAmount")),
            "sizeAmount": _min_max_curve(value.get("sizeAmount")),
        },
    )
    texture_sheet = _module(
        raw,
        "UVModule",
        lambda value: {
            "mode": _integer(value.get("mode")),
            "timeMode": _integer(value.get("timeMode")),
            "fps": _finite(value.get("fps")),
            "frameOverTime": _min_max_curve(value.get("frameOverTime")),
            "startFrame": _min_max_curve(value.get("startFrame")),
            "tilesX": max(1, _integer(value.get("tilesX"), 1)),
            "tilesY": max(1, _integer(value.get("tilesY"), 1)),
            "animationType": _integer(value.get("animationType")),
            "rowIndex": _integer(value.get("rowIndex")),
            "rowMode": _integer(value.get("rowMode")),
            "cycles": _finite(value.get("cycles"), 1),
            "flipU": _finite(value.get("flipU")),
            "flipV": _finite(value.get("flipV")),
            "uvChannelMask": _integer(value.get("uvChannelMask")),
            "sprites": [
                sprite_key(pointer)
                for pointer in value.get("sprites", [])
                if isinstance(pointer, dict)
            ],
        },
    )
    custom_data = _module(
        raw,
        "CustomDataModule",
        lambda value: {
            "streams": [
                {
                    "mode": _integer(value.get(f"mode{index}")),
                    "componentCount": max(
                        1, min(4, _integer(value.get(f"vectorComponentCount{index}"), 4))
                    ),
                    "color": _min_max_gradient(value.get(f"color{index}")),
                    "vector": [
                        _min_max_curve(value.get(f"vector{index}_{component}"))
                        for component in range(4)
                    ],
                }
                for index in range(2)
            ]
        },
    )
    return {
        "id": object_id,
        "nodeId": _pointer_id(raw.get("m_GameObject")),
        "source": source,
        "duration": _finite(raw.get("lengthInSec"), 5),
        "simulationSpeed": _finite(raw.get("simulationSpeed"), 1),
        "looping": bool(raw.get("looping")),
        "prewarm": bool(raw.get("prewarm")),
        "playOnAwake": bool(raw.get("playOnAwake")),
        "useUnscaledTime": bool(raw.get("useUnscaledTime")),
        "moveWithTransform": _integer(raw.get("moveWithTransform")),
        "scalingMode": _integer(raw.get("scalingMode"), 1),
        "autoRandomSeed": bool(raw.get("autoRandomSeed")),
        "randomSeed": _integer(raw.get("randomSeed")) & 0xFFFFFFFF,
        "startDelay": _min_max_curve(raw.get("startDelay")),
        "initial": {
            "startLifetime": _min_max_curve(initial.get("startLifetime")),
            "startSpeed": _min_max_curve(initial.get("startSpeed")),
            "startColor": _min_max_gradient(initial.get("startColor")),
            "startSize": _min_max_curve(initial.get("startSize")),
            "startSizeY": _min_max_curve(initial.get("startSizeY")),
            "startSizeZ": _min_max_curve(initial.get("startSizeZ")),
            "startRotationX": _min_max_curve(initial.get("startRotationX")),
            "startRotationY": _min_max_curve(initial.get("startRotationY")),
            "startRotationZ": _min_max_curve(initial.get("startRotation")),
            "randomizeRotationDirection": _finite(initial.get("randomizeRotationDirection")),
            "gravityModifier": _min_max_curve(initial.get("gravityModifier")),
            "gravitySource": _integer(initial.get("gravitySource")),
            "maxParticles": max(0, _integer(initial.get("maxNumParticles"), 1000)),
            "size3D": bool(initial.get("size3D")),
            "rotation3D": bool(initial.get("rotation3D")),
            "customEmitterVelocity": _vector3(initial.get("customEmitterVelocity")),
        },
        "emission": emission,
        "shape": shape,
        "sizeOverLifetime": _module(raw, "SizeModule", size),
        "rotationOverLifetime": _module(raw, "RotationModule", size),
        "colorOverLifetime": _module(
            raw,
            "ColorModule",
            lambda value: {"color": _min_max_gradient(value.get("gradient"))},
        ),
        "velocityOverLifetime": velocity,
        "limitVelocityOverLifetime": limit_velocity,
        "noise": noise,
        "textureSheetAnimation": texture_sheet,
        "customData": custom_data,
    }


def _property_pairs(value: Any) -> list[tuple[str, Any]]:
    if isinstance(value, dict):
        return [(str(key), child) for key, child in value.items()]
    if not isinstance(value, list):
        return []
    return [
        (str(entry[0]), entry[1])
        for entry in value
        if isinstance(entry, list) and len(entry) == 2
    ]


def _saved_properties(value: Any) -> dict[str, Any]:
    raw = _record(value)
    textures = {}
    for name, child in _property_pairs(raw.get("m_TexEnvs")):
        texture = _record(child)
        pointer = texture.get("m_Texture")
        textures[name] = {
            "textureId": _pointer_id(pointer),
            "fileId": _file_id(pointer),
            "reference": _record(pointer).get("reference"),
            "scale": _vector2(texture.get("m_Scale"), 1),
            "offset": _vector2(texture.get("m_Offset")),
        }
    return {
        "textures": textures,
        "floats": {name: _finite(child) for name, child in _property_pairs(raw.get("m_Floats"))},
        "colors": {name: _color(child) for name, child in _property_pairs(raw.get("m_Colors"))},
    }


def _bytes(value: Any) -> bytes | None:
    if isinstance(value, list):
        return bytes(_integer(item) & 0xFF for item in value)
    if isinstance(value, str) and value.startswith(("b'", 'b"')):
        try:
            result = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            return None
        return result if isinstance(result, bytes) else None
    return None


def _mesh(object_id: str, entry: dict[str, Any], source: str) -> dict[str, Any]:
    raw = _record(entry.get("data"))
    vertex_data = _record(raw.get("m_VertexData"))
    buffer = _bytes(vertex_data.get("m_DataSize"))
    channels = vertex_data.get("m_Channels") if isinstance(vertex_data.get("m_Channels"), list) else []
    position_channel = _record(channels[0] if channels else None)
    uv_channel = _record(channels[4] if len(channels) > 4 else None)
    stride = 0
    for channel_value in channels:
        channel = _record(channel_value)
        component_bytes = 4 if _integer(channel.get("format")) == 0 else 1
        stride = max(
            stride,
            _integer(channel.get("offset")) + _integer(channel.get("dimension")) * component_bytes,
        )
    aligned_stride = math.ceil(stride / 4) * 4 if stride else 0
    positions: list[float] = []
    uvs: list[float] = []
    if (
        buffer
        and aligned_stride
        and _integer(position_channel.get("format")) == 0
        and _integer(position_channel.get("dimension")) >= 3
    ):
        for index in range(max(0, _integer(vertex_data.get("m_VertexCount")))):
            base = index * aligned_stride + _integer(position_channel.get("offset"))
            if base + 12 > len(buffer):
                break
            positions.extend(struct.unpack_from("<fff", buffer, base))
            uv_base = index * aligned_stride + _integer(uv_channel.get("offset"))
            if (
                _integer(uv_channel.get("format")) == 0
                and _integer(uv_channel.get("dimension")) >= 2
                and uv_base + 8 <= len(buffer)
            ):
                uvs.extend(struct.unpack_from("<ff", buffer, uv_base))
    index_buffer = _bytes(raw.get("m_IndexBuffer")) or b""
    index_width = 4 if _integer(raw.get("m_IndexFormat")) == 1 else 2
    indices = [
        int.from_bytes(index_buffer[offset : offset + index_width], "little")
        for offset in range(0, len(index_buffer) - index_width + 1, index_width)
    ]
    return {
        "id": object_id,
        "name": str(raw.get("m_Name") or ""),
        "source": source,
        "positions": positions,
        "uvs": uvs,
        "indices": indices,
        "bounds": {
            "center": _vector3(_record(raw.get("m_LocalAABB")).get("m_Center")),
            "extent": _vector3(_record(raw.get("m_LocalAABB")).get("m_Extent")),
        },
    }


def _uint_float(value: Any) -> float:
    return struct.unpack("<f", struct.pack("<I", _integer(value) & 0xFFFFFFFF))[0]


def _streamed_curves(value: Any) -> list[list[dict[str, Any]]]:
    raw = _record(value)
    data = raw.get("data") if isinstance(raw.get("data"), list) else []
    count = max(0, _integer(raw.get("curveCount"))) + max(0, _integer(raw.get("discreteCurveCount")))
    curves: list[list[dict[str, Any]]] = [[] for _ in range(count)]
    offset = 0
    while offset + 1 < len(data):
        time = _uint_float(data[offset])
        segment_count = max(0, _integer(data[offset + 1]))
        offset += 2
        if not math.isfinite(time):
            break
        for _ in range(segment_count):
            if offset + 4 >= len(data):
                break
            curve_index = _integer(data[offset])
            coefficients = [_uint_float(data[offset + delta]) for delta in range(1, 5)]
            offset += 5
            if 0 <= curve_index < len(curves):
                curves[curve_index].append(
                    {
                        "time": 0 if time < -1e20 else time,
                        "coefficients": coefficients,
                        "value": coefficients[3],
                    }
                )
    return curves


def _crc32(value: str) -> int:
    return zlib.crc32(value.encode("utf-8")) & 0xFFFFFFFF


class _TextureResolver:
    def __init__(self, data: Any, owner_serialized_file: str):
        self.data = data
        self.owner_serialized_file = owner_serialized_file
        self.missing_outputs: set[str] = set()

    def _output_url(
        self,
        pointer: Any,
        owner_serialized_file: str,
        expected_type: str,
    ) -> str | None:
        try:
            return self.data.unity_output_url(
                pointer, owner_serialized_file, expected_type
            )
        except ValueError as error:
            if not str(error).startswith("Unity media pointer must resolve uniquely:") or not str(
                error
            ).endswith("found 0"):
                raise
            identity = self.data.unity_pointer_identity(
                pointer, owner_serialized_file
            )
            self.missing_outputs.add(_identity_key(identity))
            return None

    def texture(
        self, pointer: Any, owner_serialized_file: str | None = None
    ) -> tuple[str | None, dict[str, Any] | None]:
        owner = owner_serialized_file or self.owner_serialized_file
        identity = self.data.unity_pointer_identity(pointer, owner)
        if identity is None:
            return None, None
        texture = self.data.unity_object(pointer, owner, "Texture2D")
        raw = _record(texture.get("data")) if isinstance(texture, dict) else {}
        url = self._output_url(pointer, owner, "Texture2D")
        return url, {
            "fileId": _file_id(pointer),
            "pathId": identity[1],
            "cab": identity[0],
            "externalReference": _record(pointer).get("reference"),
            "name": str(raw.get("m_Name") or "") or None,
            "source": url,
        }

    def sprite(
        self,
        pointer: Any,
        owner_serialized_file: str | None = None,
    ) -> tuple[str | None, dict[str, Any] | None]:
        owner = owner_serialized_file or self.owner_serialized_file
        identity = self.data.unity_pointer_identity(pointer, owner)
        if identity is None:
            return None, None
        sprite = self.data.unity_object(pointer, owner, "Sprite")
        raw = _record(sprite.get("data")) if isinstance(sprite, dict) else {}
        texture_pointer = _record(raw.get("m_RD")).get("texture")
        _, texture_reference = self.texture(texture_pointer, identity[0])
        return self._output_url(pointer, owner, "Sprite"), texture_reference


def serialize_unity_effect(data: Any, source_path: str) -> dict[str, Any]:
    """Return the exact runtime graph for one canonical effect prefab source."""
    descriptor, objects = data.source_objects(source_path)
    root_ids = [str(int(value)) for value in descriptor.get("rootObjects", [])]
    if len(root_ids) != 1 or objects.get(root_ids[0], {}).get("type") != "GameObject":
        raise ValueError(f"ADV effect must have exactly one GameObject root: {source_path}")
    root_id = root_ids[0]

    transforms = {
        object_id: entry
        for object_id, entry in objects.items()
        if entry.get("type") in ("Transform", "RectTransform")
    }
    transform_by_game_object = {
        _pointer_id(_record(entry.get("data")).get("m_GameObject")): (object_id, entry)
        for object_id, entry in transforms.items()
    }
    root_transform = transform_by_game_object.get(root_id)
    if root_transform is None:
        raise ValueError(f"ADV effect root Transform is missing: {source_path}::{root_id}")

    transform_ids: set[str] = set()

    def collect(transform_id: str) -> None:
        if transform_id in transform_ids:
            return
        transform_ids.add(transform_id)
        raw = _record(transforms[transform_id].get("data"))
        for pointer in raw.get("m_Children", []):
            child = _pointer_id(pointer)
            if child in transforms:
                collect(child)

    collect(root_transform[0])
    game_object_ids = {
        _pointer_id(_record(transforms[transform_id].get("data")).get("m_GameObject"))
        for transform_id in transform_ids
    }
    included = {
        object_id: entry
        for object_id, entry in objects.items()
        if object_id in game_object_ids
        or _pointer_id(_record(entry.get("data")).get("m_GameObject")) in game_object_ids
    }
    owner_serialized_file = str(descriptor.get("serializedFile") or "")
    if not owner_serialized_file:
        raise ValueError(f"ADV effect has no serialized file identity: {source_path}")

    def pointer_key(pointer: Any, owner: str = owner_serialized_file) -> str:
        return _identity_key(data.unity_pointer_identity(pointer, owner))

    resolver = _TextureResolver(data, owner_serialized_file)

    sprites: list[dict[str, Any]] = []
    sprite_by_id: dict[str, dict[str, Any]] = {}

    def serialize_sprite(pointer: Any, owner: str = owner_serialized_file) -> dict[str, Any] | None:
        identity = data.unity_pointer_identity(pointer, owner)
        if identity is None:
            return None
        sprite_id = _identity_key(identity)
        cached = sprite_by_id.get(sprite_id)
        if cached is not None:
            return cached
        entry = data.unity_object(pointer, owner, "Sprite")
        raw = _record(entry.get("data")) if isinstance(entry, dict) else {}
        texture_pointer = _record(raw.get("m_RD")).get("texture")
        url, reference = resolver.sprite(pointer, owner)
        sprite = {
            "id": sprite_id,
            "name": str(raw.get("m_Name") or ""),
            "source": source_path,
            "textureId": pointer_key(texture_pointer, identity[0]),
            "textureUrl": url,
            "textureReference": reference,
            "rect": {
                key: _finite(_record(raw.get("m_Rect")).get(key))
                for key in ("x", "y", "width", "height")
            },
            "pivot": _vector2(raw.get("m_Pivot"), 0.5),
            "pixelsToUnits": _finite(raw.get("m_PixelsToUnits"), 100),
        }
        sprites.append(sprite)
        sprite_by_id[sprite_id] = sprite
        return sprite

    for object_id, entry in objects.items():
        if entry.get("type") == "Sprite":
            serialize_sprite({"m_FileID": 0, "m_PathID": object_id})

    materials: list[dict[str, Any]] = []
    material_by_id: dict[str, dict[str, Any]] = {}

    def serialize_material(pointer: Any, owner: str = owner_serialized_file) -> dict[str, Any] | None:
        identity = data.unity_pointer_identity(pointer, owner)
        if identity is None:
            return None
        material_id = _identity_key(identity)
        cached = material_by_id.get(material_id)
        if cached is not None:
            return cached
        entry = data.unity_object(pointer, owner, "Material")
        raw = _record(entry.get("data")) if isinstance(entry, dict) else {}
        properties = _saved_properties(raw.get("m_SavedProperties"))
        main = properties["textures"].get("_BaseMap") or properties["textures"].get("_MainTex")
        main_pointer = (
            {
                "m_FileID": main["fileId"],
                "m_PathID": main["textureId"],
                "reference": main.get("reference"),
            }
            if isinstance(main, dict)
            else None
        )
        texture_url, texture_reference = resolver.texture(main_pointer, identity[0])
        shader_pointer = raw.get("m_Shader")
        shader_identity = data.unity_pointer_identity(shader_pointer, identity[0])
        shader = data.unity_object(shader_pointer, identity[0], "Shader")
        shader_raw = _record(shader.get("data")) if isinstance(shader, dict) else {}
        shader_name = str(
            _record(shader_raw.get("m_ParsedForm")).get("m_Name")
            or shader_raw.get("m_Name")
            or ""
        )
        if not shader_name:
            raise ValueError(
                f"ADV effect Material shader name is unresolved: "
                f"{source_path}::{material_id}"
            )
        material = {
            "id": material_id,
            "name": str(raw.get("m_Name") or ""),
            "source": source_path,
            "shaderId": _identity_key(shader_identity),
            "shaderName": shader_name,
            "keywords": list(raw.get("m_ValidKeywords") or []),
            "renderQueue": _finite(raw.get("m_CustomRenderQueue"), -1),
            "tags": dict(_property_pairs(raw.get("stringTagMap"))),
            "properties": properties,
            "textureUrl": texture_url,
            "textureReference": texture_reference,
        }
        materials.append(material)
        material_by_id[material_id] = material
        return material

    for object_id, entry in objects.items():
        if entry.get("type") == "Material":
            serialize_material({"m_FileID": 0, "m_PathID": object_id})

    meshes: list[dict[str, Any]] = []
    mesh_by_id: dict[str, dict[str, Any]] = {}
    built_in_meshes: set[str] = set()

    def serialize_mesh(pointer: Any, owner: str = owner_serialized_file) -> dict[str, Any] | None:
        try:
            identity = data.unity_pointer_identity(pointer, owner)
        except ValueError as error:
            reference = _record(pointer).get("reference")
            external_path = str(_record(reference).get("externalPath") or "")
            if not str(error).startswith("Unity external pointer is unresolved:") or external_path not in {
                "Library/unity default resources",
                "Resources/unity_builtin_extra",
            }:
                raise
            # Built-in primitive meshes are supplied by the Unity engine and
            # consequently have no object in an Addressables archive.  Keep a
            # stable evidence key; the browser runtime already renders an
            # absent Unity mesh with its canonical unit quad fallback.
            built_in_id = f"builtin:{external_path}:{_pointer_id(pointer)}"
            built_in_meshes.add(built_in_id)
            cached = mesh_by_id.get(built_in_id)
            if cached is not None:
                return cached
            mesh = {
                "id": built_in_id,
                "name": external_path,
                "source": external_path,
                "positions": [],
                "uvs": [],
                "indices": [],
                "bounds": {
                    "center": {"x": 0, "y": 0, "z": 0},
                    "extent": {"x": 0.5, "y": 0.5, "z": 0},
                },
                "engineBuiltin": True,
                "pathId": _pointer_id(pointer),
            }
            meshes.append(mesh)
            mesh_by_id[built_in_id] = mesh
            return mesh
        if identity is None:
            return None
        mesh_id = _identity_key(identity)
        cached = mesh_by_id.get(mesh_id)
        if cached is not None:
            return cached
        entry = data.unity_object(pointer, owner, "Mesh")
        mesh = _mesh(mesh_id, entry, source_path) if isinstance(entry, dict) else None
        if mesh is None:
            return None
        meshes.append(mesh)
        mesh_by_id[mesh_id] = mesh
        return mesh

    def mesh_key(pointer: Any, owner: str = owner_serialized_file) -> str:
        mesh = serialize_mesh(pointer, owner)
        return str(mesh.get("id")) if mesh else "0"

    def sprite_key(pointer: Any, owner: str = owner_serialized_file) -> str:
        sprite = serialize_sprite(pointer, owner)
        return str(sprite.get("id")) if sprite else "0"

    for object_id, entry in objects.items():
        if entry.get("type") == "Mesh":
            serialize_mesh({"m_FileID": 0, "m_PathID": object_id})

    nodes = []
    for transform_id in transform_ids:
        transform = transforms[transform_id]
        raw = _record(transform.get("data"))
        game_object_id = _pointer_id(raw.get("m_GameObject"))
        game_object = objects.get(game_object_id, {})
        game_raw = _record(game_object.get("data"))
        name = str(game_raw.get("m_Name") or "")
        parent_transform_id = _pointer_id(raw.get("m_Father"))
        parent_raw = _record(transforms.get(parent_transform_id, {}).get("data"))
        parent_id = _pointer_id(parent_raw.get("m_GameObject")) if parent_raw else None
        nodes.append(
            {
                "id": game_object_id,
                "transformId": transform_id,
                "name": name,
                "nameHash": _crc32(name),
                "source": source_path,
                "active": bool(game_raw.get("m_IsActive", 1)),
                "parentId": parent_id,
                "position": _vector3(raw.get("m_LocalPosition")),
                "rotation": _quaternion(raw.get("m_LocalRotation")),
                "scale": _vector3(raw.get("m_LocalScale"), 1),
            }
        )

    particle_renderers = []
    sprite_renderers = []
    mesh_renderers = []
    for object_id, entry in included.items():
        raw = _record(entry.get("data"))
        materials_list = raw.get("m_Materials") if isinstance(raw.get("m_Materials"), list) else []
        material = serialize_material(materials_list[0]) if materials_list else None
        material_id = str(material.get("id")) if material else "0"
        if entry.get("type") == "ParticleSystemRenderer":
            particle_renderers.append(
                {
                    "id": object_id,
                    "nodeId": _pointer_id(raw.get("m_GameObject")),
                    "source": source_path,
                    "enabled": bool(raw.get("m_Enabled")),
                    "materialId": material_id,
                    "material": material,
                    "sortingLayerId": _finite(raw.get("m_SortingLayerID")),
                    "sortingOrder": _integer(raw.get("m_SortingOrder")),
                    "renderMode": _integer(raw.get("m_RenderMode")),
                    "sortMode": _integer(raw.get("m_SortMode")),
                    "renderAlignment": _integer(raw.get("m_RenderAlignment")),
                    "minParticleSize": _finite(raw.get("m_MinParticleSize")),
                    "maxParticleSize": _finite(raw.get("m_MaxParticleSize"), 0.5),
                    "cameraVelocityScale": _finite(raw.get("m_CameraVelocityScale")),
                    "velocityScale": _finite(raw.get("m_VelocityScale")),
                    "lengthScale": _finite(raw.get("m_LengthScale"), 2),
                    "sortingFudge": _finite(raw.get("m_SortingFudge")),
                    "normalDirection": _finite(raw.get("m_NormalDirection"), 1),
                    "pivot": _vector3(raw.get("m_Pivot")),
                    "flip": _vector3(raw.get("m_Flip")),
                    "allowRoll": bool(raw.get("m_AllowRoll")),
                    "meshId": mesh_key(raw.get("m_Mesh")),
                    "vertexStreams": [
                        _integer(value)
                        for value in raw.get("m_VertexStreams", [])
                    ],
                }
            )
        elif entry.get("type") == "SpriteRenderer":
            sprite = serialize_sprite(raw.get("m_Sprite"))
            sprite_id = str(sprite.get("id")) if sprite else "0"
            sprite_renderers.append(
                {
                    "id": object_id,
                    "nodeId": _pointer_id(raw.get("m_GameObject")),
                    "source": source_path,
                    "enabled": bool(raw.get("m_Enabled")),
                    "spriteId": sprite_id,
                    "sprite": sprite,
                    "materialId": material_id,
                    "color": _color(raw.get("m_Color")),
                    "flipX": bool(raw.get("m_FlipX")),
                    "flipY": bool(raw.get("m_FlipY")),
                    "sortingLayerId": _finite(raw.get("m_SortingLayerID")),
                    "sortingOrder": _integer(raw.get("m_SortingOrder")),
                    "drawMode": _integer(raw.get("m_DrawMode")),
                    "size": _vector2(raw.get("m_Size")),
                }
            )
        elif entry.get("type") == "MeshRenderer":
            node_id = _pointer_id(raw.get("m_GameObject"))
            mesh_filter = next(
                (
                    child
                    for child in included.values()
                    if child.get("type") == "MeshFilter"
                    and _pointer_id(_record(child.get("data")).get("m_GameObject")) == node_id
                ),
                None,
            )
            mesh_renderers.append(
                {
                    "id": object_id,
                    "nodeId": node_id,
                    "source": source_path,
                    "enabled": bool(raw.get("m_Enabled")),
                    "materialId": material_id,
                    "meshId": mesh_key(_record(mesh_filter.get("data")).get("m_Mesh")) if mesh_filter else "0",
                    "sortingLayerId": _finite(raw.get("m_SortingLayerID")),
                    "sortingOrder": _integer(raw.get("m_SortingOrder")),
                }
            )

    animations = []
    for object_id, entry in objects.items():
        if entry.get("type") != "AnimationClip":
            continue
        raw = _record(entry.get("data"))
        muscle = _record(raw.get("m_MuscleClip"))
        streamed = _record(_record(_record(muscle.get("m_Clip")).get("data")).get("m_StreamedClip"))
        binding_constant = _record(raw.get("m_ClipBindingConstant"))
        bindings = (
            binding_constant.get("genericBindings")
            if isinstance(binding_constant.get("genericBindings"), list)
            else []
        )
        pointers = (
            binding_constant.get("pptrCurveMapping")
            if isinstance(binding_constant.get("pptrCurveMapping"), list)
            else []
        )
        pptr_mapping = [sprite_key(pointer) for pointer in pointers]
        pptr_references = []
        pptr_textures = []
        for pointer, sprite_id in zip(pointers, pptr_mapping, strict=True):
            sprite = sprite_by_id.get(sprite_id)
            pptr_references.append(sprite.get("textureReference") if sprite else None)
            pptr_textures.append(sprite.get("textureUrl") if sprite else None)
        curves = []
        for index, segments in enumerate(_streamed_curves(streamed)):
            binding = _record(bindings[index]) if index < len(bindings) else {}
            curves.append(
                {
                    "binding": (
                        {
                            "pathHash": _integer(binding.get("path")) & 0xFFFFFFFF,
                            "attributeHash": _integer(binding.get("attribute")) & 0xFFFFFFFF,
                            "typeId": _integer(binding.get("typeID")),
                            "customType": _integer(binding.get("customType")),
                            "isPPtrCurve": bool(binding.get("isPPtrCurve")),
                        }
                        if binding
                        else None
                    ),
                    "segments": segments,
                }
            )
        animations.append(
            {
                "id": object_id,
                "name": str(raw.get("m_Name") or ""),
                "source": source_path,
                "sampleRate": _finite(raw.get("m_SampleRate"), 60),
                "startTime": _finite(muscle.get("m_StartTime")),
                "stopTime": _finite(muscle.get("m_StopTime")),
                "loop": bool(muscle.get("m_LoopTime")),
                "curves": curves,
                "pptrMapping": pptr_mapping,
                "pptrReferences": pptr_references,
                "pptrTextures": pptr_textures,
            }
        )

    runtime = {
        "version": 1,
        "source": source_path,
        "rootNodeId": root_id,
        "nodes": nodes,
        "particleSystems": [
            _particle_system(object_id, entry, source_path, mesh_key, sprite_key)
            for object_id, entry in included.items()
            if entry.get("type") == "ParticleSystem"
        ],
        "particleRenderers": particle_renderers,
        "spriteRenderers": sprite_renderers,
        "meshRenderers": mesh_renderers,
        "materials": materials,
        "sprites": sprites,
        "meshes": meshes,
        "animations": animations,
        "evidence": {
            "source": "canonical Unity object archive",
            "engineBuiltinMeshes": sorted(built_in_meshes),
            "missingMediaOutputs": sorted(resolver.missing_outputs),
            "serializedModules": [
                "InitialModule",
                "EmissionModule",
                "ShapeModule",
                "ColorModule",
                "SizeModule",
                "VelocityModule",
                "ClampVelocityModule",
                "NoiseModule",
                "RotationModule",
                "UVModule",
                "CustomDataModule",
            ],
        },
    }
    if not runtime["nodes"] or not (
        runtime["particleSystems"] or runtime["spriteRenderers"] or runtime["meshRenderers"]
    ):
        raise ValueError(f"ADV effect prefab has no renderable runtime graph: {source_path}")
    return runtime
