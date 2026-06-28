"""Build strict Home Spot background GLB derivatives.

The source mapping comes from ``MasterHomeSpot`` and the canonical Unity
source index.  Download filenames are provenance only: neither bundle names
nor case-folded paths are used to discover a scene.

The exported geometry is in background-root-local space.  The authored root
Transform is intentionally not baked because the game applies the selected
``SpotSituationSettings`` background position/rotation/scale at runtime.
"""

from __future__ import annotations

import io
import math
import re
import struct
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

from build.home_spot_preview import (
    PREVIEW_ASPECT,
    PREVIEW_FAR,
    PREVIEW_NEAR,
    render_home_spot_preview,
)
from core.config import ServerConfig
from core.contracts import UNITY_INDEX_SCHEMA
from core.hashes import sha256_file
from core.manifests import atomic_write, read_json, stable_json, write_json
from core.paths import (
    build_layout,
    normalize_release_path,
    source_layout,
    validate_unity_path,
)
from core.unity_objects import UnityObjectStore


SCHEMA = "haneoka-home-spot-background-build-v1"
OUTPUT_TYPE = "SpotBackgroundSceneGLB"
SITUATION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
REFLECTION_Z = np.diag((1.0, 1.0, -1.0, 1.0))
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def _pointer(component: Any) -> Any:
    return component.component if hasattr(component, "component") else component[1]


def _object_key(value: Any) -> tuple[str, int]:
    reader = value.object_reader
    return (str(reader.assets_file.name), int(reader.path_id))


def _components(game_object: Any) -> dict[str, list[Any]]:
    values: dict[str, list[Any]] = {}
    for component in game_object.m_Component:
        reader = _pointer(component).deref()
        if reader is None:
            raise ValueError(f"GameObject component is unresolved: {game_object.m_Name}")
        values.setdefault(reader.type.name, []).append(reader)
    return values


def _only_component(game_object: Any, component_type: str) -> Any:
    matches = _components(game_object).get(component_type, [])
    if len(matches) != 1:
        raise ValueError(
            f"GameObject {game_object.m_Name!r} must have one {component_type}; "
            f"found {len(matches)}"
        )
    return matches[0].read()


def _vector3(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _quaternion(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z), float(value.w)]


def _transform_document(transform: Any) -> dict[str, list[float]]:
    return {
        "position": _vector3(transform.m_LocalPosition),
        "rotationQuaternion": _quaternion(transform.m_LocalRotation),
        "scale": _vector3(transform.m_LocalScale),
    }


def _quaternion_multiply(left: list[float], right: list[float]) -> list[float]:
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return [
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ]


def _unity_euler_quaternion(euler_degrees: list[float]) -> list[float]:
    """Match Unity Quaternion.Euler: apply Z, then X, then Y."""

    def axis(index: int, degrees: float) -> list[float]:
        angle = math.radians(degrees) / 2
        result = [0.0, 0.0, 0.0, math.cos(angle)]
        result[index] = math.sin(angle)
        return result

    x, y, z = euler_degrees
    return _quaternion_multiply(
        _quaternion_multiply(axis(1, y), axis(0, x)),
        axis(2, z),
    )


def _unity_trs_matrix(
    position: list[float], rotation: list[float], scale_values: list[float]
) -> np.ndarray:
    x, y, z, w = rotation
    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("Unity Transform has an invalid rotation quaternion")
    x, y, z, w = (value / norm for value in (x, y, z, w))
    rotation = np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=np.float64,
    )
    scale = np.diag(np.asarray(scale_values, dtype=np.float64))
    matrix = np.identity(4, dtype=np.float64)
    matrix[:3, :3] = rotation @ scale
    matrix[:3, 3] = np.asarray(position, dtype=np.float64)
    if not np.isfinite(matrix).all():
        raise ValueError("Unity Transform contains a non-finite value")
    return matrix


def _gltf_matrix(transform: Any) -> list[float]:
    converted = REFLECTION_Z @ _unity_trs_matrix(
        _vector3(transform.m_LocalPosition),
        _quaternion(transform.m_LocalRotation),
        _vector3(transform.m_LocalScale),
    ) @ REFLECTION_Z
    # glTF serializes matrices in column-major order.
    return [float(value) for value in converted.T.reshape(-1)]


def _gltf_trs_matrix(
    position: list[float], rotation: list[float], scale: list[float]
) -> list[float]:
    converted = REFLECTION_Z @ _unity_trs_matrix(position, rotation, scale) @ REFLECTION_Z
    return [float(value) for value in converted.T.reshape(-1)]


def _named_properties(values: Any) -> dict[str, Any]:
    return {key if isinstance(key, str) else key.name: value for key, value in values}


def _color(value: Any, default: tuple[float, float, float, float]) -> list[float]:
    if value is None:
        return list(default)
    result = [float(value.r), float(value.g), float(value.b), float(value.a)]
    if not all(math.isfinite(number) for number in result):
        raise ValueError("Unity material color contains a non-finite value")
    return result


class _GlbBuilder:
    def __init__(self, source_path: str, situation_name: str, root_id: str):
        self.source_path = source_path
        self.situation_name = situation_name
        self.root_id = root_id
        self.binary = bytearray()
        self.document: dict[str, Any] = {
            "asset": {"version": "2.0", "generator": "haneoka-home-spot-background-v1"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [],
            "bufferViews": [],
            "accessors": [],
        }
        self.materials: dict[tuple[str, int], int] = {}
        self.textures: dict[tuple[str, int], int] = {}
        self.meshes: dict[tuple[Any, ...], int] = {}
        self.extensions: set[str] = set()
        self.mesh_count = 0
        self.primitive_count = 0
        self.vertex_count = 0
        self.triangle_count = 0
        self.empty_mesh_count = 0

    def _view(self, payload: bytes, target: int | None = None) -> int:
        while len(self.binary) % 4:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(payload)
        value: dict[str, Any] = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            value["target"] = target
        index = len(self.document["bufferViews"])
        self.document["bufferViews"].append(value)
        return index

    def _accessor(
        self,
        values: np.ndarray,
        accessor_type: str,
        component_type: int,
        target: int,
        bounds: bool = False,
    ) -> int:
        if values.size == 0:
            raise ValueError("glTF accessor cannot be empty")
        view = self._view(values.tobytes(order="C"), target)
        value: dict[str, Any] = {
            "bufferView": view,
            "componentType": component_type,
            "count": int(values.shape[0]),
            "type": accessor_type,
        }
        if bounds:
            value["min"] = [float(number) for number in np.min(values, axis=0)]
            value["max"] = [float(number) for number in np.max(values, axis=0)]
        index = len(self.document["accessors"])
        self.document["accessors"].append(value)
        return index

    def _texture(self, texture: Any) -> int:
        key = _object_key(texture)
        cached = self.textures.get(key)
        if cached is not None:
            return cached

        image = texture.image
        if image is None:
            raise ValueError(f"Texture2D has no image payload: {texture.m_Name}")
        output = io.BytesIO()
        image.save(output, format="PNG", compress_level=6, optimize=False)
        image_view = self._view(output.getvalue())
        image_index = len(self.document["images"])
        self.document["images"].append(
            {"name": str(texture.m_Name), "mimeType": "image/png", "bufferView": image_view}
        )

        settings = getattr(texture, "m_TextureSettings", None)
        filter_mode = int(getattr(settings, "m_FilterMode", 1))
        filters = {0: (9728, 9728), 1: (9729, 9985), 2: (9729, 9987)}
        if filter_mode not in filters:
            raise ValueError(f"unsupported Unity texture filter mode: {filter_mode}")
        wraps = {0: 10497, 1: 33071, 2: 33648}
        wrap_u = int(getattr(settings, "m_WrapU", 0))
        wrap_v = int(getattr(settings, "m_WrapV", 0))
        if wrap_u not in wraps or wrap_v not in wraps:
            raise ValueError(f"unsupported Unity texture wrapping: {wrap_u}/{wrap_v}")
        mag_filter, min_filter = filters[filter_mode]
        sampler_index = len(self.document["samplers"])
        self.document["samplers"].append(
            {
                "magFilter": mag_filter,
                "minFilter": min_filter,
                "wrapS": wraps[wrap_u],
                "wrapT": wraps[wrap_v],
            }
        )
        texture_index = len(self.document["textures"])
        self.document["textures"].append(
            {"name": str(texture.m_Name), "sampler": sampler_index, "source": image_index}
        )
        self.textures[key] = texture_index
        return texture_index

    def _base_color_texture(self, tex_env: Any, material_name: str) -> dict[str, int] | None:
        if not tex_env or not tex_env.m_Texture:
            return None
        scale = [float(tex_env.m_Scale.x), float(tex_env.m_Scale.y)]
        offset = [float(tex_env.m_Offset.x), float(tex_env.m_Offset.y)]
        if not np.allclose(scale, (1, 1), atol=1e-7) or not np.allclose(offset, (0, 0), atol=1e-7):
            raise ValueError(f"material texture transform is unsupported: {material_name}")
        texture = tex_env.m_Texture.deref_parse_as_object()
        if texture is None:
            raise ValueError(f"material texture is unresolved: {material_name}")
        return {"index": self._texture(texture)}

    def _material(self, pointer: Any) -> tuple[int, bool]:
        reader = pointer.deref()
        if reader is None or reader.type.name != "Material":
            raise ValueError("MeshRenderer material is unresolved or not a Material")
        key = (str(reader.assets_file.name), int(reader.path_id))
        cached = self.materials.get(key)
        if cached is not None:
            value = self.document["materials"][cached]
            return cached, "baseColorTexture" in value["pbrMetallicRoughness"]

        material = reader.read()
        shader = material.m_Shader.deref_parse_as_object() if material.m_Shader else None
        shader_name = str(getattr(getattr(shader, "m_ParsedForm", None), "m_Name", ""))
        if shader_name not in {
            "Unlit/Transparent Cutout",
            "Unlit/Transparent",
            "Universal Render Pipeline/Lit",
        }:
            raise ValueError(f"unsupported Home Spot shader {shader_name!r}: {material.m_Name}")

        colors = _named_properties(material.m_SavedProperties.m_Colors)
        floats = _named_properties(material.m_SavedProperties.m_Floats)
        tex_envs = _named_properties(material.m_SavedProperties.m_TexEnvs)
        nonempty_textures = {
            name: value for name, value in tex_envs.items() if value and value.m_Texture
        }
        allowed_textures = {"_MainTex"} if shader_name.startswith("Unlit/") else {"_BaseMap", "_MainTex"}
        unexpected = sorted(set(nonempty_textures) - allowed_textures)
        if unexpected:
            raise ValueError(
                f"Home Spot material has unsupported texture properties: "
                f"{material.m_Name}: {', '.join(unexpected)}"
            )

        if shader_name.startswith("Unlit/"):
            base_texture = self._base_color_texture(tex_envs.get("_MainTex"), material.m_Name)
            if base_texture is None:
                raise ValueError(f"unlit Home Spot material has no _MainTex: {material.m_Name}")
            base_color = _color(colors.get("_Color") or colors.get("_BaseColor"), (1, 1, 1, 1))
            metallic = 0.0
            roughness = 1.0
        else:
            base_candidates = [
                value
                for name in ("_BaseMap", "_MainTex")
                if (value := self._base_color_texture(tex_envs.get(name), material.m_Name)) is not None
            ]
            if len(base_candidates) > 1 and base_candidates[0] != base_candidates[1]:
                raise ValueError(f"URP material has two different base textures: {material.m_Name}")
            base_texture = base_candidates[0] if base_candidates else None
            base_color = _color(colors.get("_BaseColor") or colors.get("_Color"), (1, 1, 1, 1))
            metallic = float(floats.get("_Metallic", 0))
            roughness = 1 - float(floats.get("_Smoothness", floats.get("_Glossiness", 0.5)))
            if not 0 <= metallic <= 1 or not 0 <= roughness <= 1:
                raise ValueError(f"URP material PBR values are out of range: {material.m_Name}")

        pbr: dict[str, Any] = {
            "baseColorFactor": base_color,
            "metallicFactor": metallic,
            "roughnessFactor": roughness,
        }
        if base_texture is not None:
            pbr["baseColorTexture"] = base_texture
        value: dict[str, Any] = {
            "name": str(material.m_Name),
            "pbrMetallicRoughness": pbr,
            "extras": {"unityShader": shader_name, "unityObjectId": str(reader.path_id)},
        }
        cull = int(float(floats.get("_Cull", 2)))
        if cull == 0:
            value["doubleSided"] = True
        elif cull != 2:
            raise ValueError(f"front-face-only culling is unsupported: {material.m_Name}")
        if shader_name == "Unlit/Transparent Cutout":
            cutoff = float(floats.get("_Cutoff", 0.5))
            if not 0 <= cutoff <= 1:
                raise ValueError(f"material alpha cutoff is out of range: {material.m_Name}")
            value.update({"alphaMode": "MASK", "alphaCutoff": cutoff})
            value["extensions"] = {"KHR_materials_unlit": {}}
            self.extensions.add("KHR_materials_unlit")
        elif shader_name == "Unlit/Transparent":
            value["alphaMode"] = "BLEND"
            value["extensions"] = {"KHR_materials_unlit": {}}
            self.extensions.add("KHR_materials_unlit")

        index = len(self.document["materials"])
        self.document["materials"].append(value)
        self.materials[key] = index
        return index, base_texture is not None

    def _mesh(self, game_object: Any, renderer: Any, mesh_filter: Any) -> int | None:
        mesh_pointer = mesh_filter.m_Mesh
        mesh_reader = mesh_pointer.deref() if mesh_pointer else None
        if mesh_reader is None or mesh_reader.type.name != "Mesh":
            raise ValueError(f"MeshFilter is unresolved: {game_object.m_Name}")
        mesh = mesh_reader.read()
        material_pointers = list(renderer.m_Materials)
        material_keys = tuple(
            (int(pointer.m_FileID), int(pointer.m_PathID)) if pointer else (0, 0)
            for pointer in material_pointers
        )
        cache_key = (str(mesh_reader.assets_file.name), int(mesh_reader.path_id), material_keys)
        cached = self.meshes.get(cache_key)
        if cached is not None:
            return cached

        handler = MeshHandler(mesh)
        handler.process()
        vertex_count = int(handler.m_VertexCount or 0)
        if vertex_count == 0:
            submeshes = list(getattr(mesh, "m_SubMeshes", []) or [])
            if any(int(value.indexCount or 0) or int(value.vertexCount or 0) for value in submeshes):
                raise ValueError(f"Mesh has indices but no decoded vertices: {mesh.m_Name}")
            self.empty_mesh_count += 1
            return None
        triangles = handler.get_triangles()
        if len(triangles) != len(material_pointers):
            raise ValueError(
                f"Mesh submesh/material count diverges: {mesh.m_Name}: "
                f"{len(triangles)}/{len(material_pointers)}"
            )

        positions = np.asarray(handler.m_Vertices, dtype="<f4")
        if positions.shape != (vertex_count, 3) or not np.isfinite(positions).all():
            raise ValueError(f"Mesh positions are invalid: {mesh.m_Name}")
        positions = positions.copy()
        positions[:, 2] *= -1
        attributes: dict[str, int] = {
            "POSITION": self._accessor(positions, "VEC3", 5126, ARRAY_BUFFER, bounds=True)
        }

        normals = np.asarray(handler.m_Normals, dtype="<f4") if handler.m_Normals else np.empty((0, 3), dtype="<f4")
        if normals.size:
            if normals.shape != (vertex_count, 3) or not np.isfinite(normals).all():
                raise ValueError(f"Mesh normals are invalid: {mesh.m_Name}")
            normals = normals.copy()
            normals[:, 2] *= -1
            attributes["NORMAL"] = self._accessor(normals, "VEC3", 5126, ARRAY_BUFFER)

        uv = np.asarray(handler.m_UV0, dtype="<f4") if handler.m_UV0 else np.empty((0, 2), dtype="<f4")
        if uv.size:
            if uv.ndim != 2 or uv.shape[0] != vertex_count or uv.shape[1] < 2 or not np.isfinite(uv).all():
                raise ValueError(f"Mesh UV0 is invalid: {mesh.m_Name}")
            uv = np.asarray(uv[:, :2], dtype="<f4").copy()
            # Unity UV0 uses a bottom-left origin; glTF TEXCOORD_0 uses the
            # top-left image origin.  Convert the coordinate, not the PNG, so
            # the embedded source texture remains byte-stable and portable.
            uv[:, 1] = 1 - uv[:, 1]
            attributes["TEXCOORD_0"] = self._accessor(uv, "VEC2", 5126, ARRAY_BUFFER)

        primitives = []
        for submesh_index, raw_triangles in enumerate(triangles):
            values = np.asarray(raw_triangles, dtype=np.int64)
            if values.size == 0:
                continue
            if values.ndim != 2 or values.shape[1] != 3:
                raise ValueError(f"Mesh triangle data is invalid: {mesh.m_Name}")
            if int(values.min()) < 0 or int(values.max()) >= vertex_count:
                raise ValueError(f"Mesh triangle index is out of range: {mesh.m_Name}")
            # Z reflection changes handedness, so reverse the triangle winding.
            values = values[:, ::-1].reshape(-1)
            if int(values.max()) <= 65535:
                indices = np.asarray(values, dtype="<u2")
                component_type = 5123
            else:
                indices = np.asarray(values, dtype="<u4")
                component_type = 5125
            material_pointer = material_pointers[submesh_index]
            if not material_pointer:
                raise ValueError(f"Mesh submesh has no material: {mesh.m_Name}:{submesh_index}")
            material_index, textured = self._material(material_pointer)
            if textured and "TEXCOORD_0" not in attributes:
                raise ValueError(f"textured Mesh has no UV0: {mesh.m_Name}")
            primitives.append(
                {
                    "attributes": attributes,
                    "indices": self._accessor(indices, "SCALAR", component_type, ELEMENT_ARRAY_BUFFER),
                    "material": material_index,
                    "mode": 4,
                }
            )
            self.primitive_count += 1
            self.triangle_count += int(values.size // 3)
        if not primitives:
            raise ValueError(f"non-empty Mesh has no triangle primitives: {mesh.m_Name}")

        index = len(self.document["meshes"])
        self.document["meshes"].append(
            {
                "name": str(mesh.m_Name),
                "primitives": primitives,
                "extras": {"unityObjectId": str(mesh_reader.path_id)},
            }
        )
        self.meshes[cache_key] = index
        self.mesh_count += 1
        self.vertex_count += vertex_count
        return index

    def add_scene(self, root: Any, hidden_ids: set[int]) -> None:
        all_game_objects: dict[int, Any] = {}
        visiting: set[int] = set()

        def collect(game_object: Any) -> None:
            identity = int(game_object.object_reader.path_id)
            if identity in visiting or identity in all_game_objects:
                raise ValueError(f"Home Spot hierarchy repeats GameObject {identity}")
            visiting.add(identity)
            all_game_objects[identity] = game_object
            transform = _only_component(game_object, "Transform")
            for child_pointer in transform.m_Children:
                child_transform = child_pointer.deref_parse_as_object()
                if child_transform is None:
                    raise ValueError(f"Home Spot Transform child is unresolved: {game_object.m_Name}")
                child = child_transform.m_GameObject.deref_parse_as_object()
                if child is None:
                    raise ValueError(f"Home Spot child GameObject is unresolved: {game_object.m_Name}")
                collect(child)
            visiting.remove(identity)

        collect(root)
        unknown_hidden = hidden_ids - set(all_game_objects)
        if unknown_hidden:
            raise ValueError(
                f"Home Spot HideObjects leave the background hierarchy: {sorted(unknown_hidden)}"
            )

        def add(game_object: Any, is_root: bool = False) -> int | None:
            identity = int(game_object.object_reader.path_id)
            if not bool(game_object.m_IsActive) or identity in hidden_ids:
                return None
            components = _components(game_object)
            transforms = components.get("Transform", [])
            if len(transforms) != 1:
                raise ValueError(f"GameObject must have one Transform: {game_object.m_Name}")
            transform = transforms[0].read()
            node: dict[str, Any] = {
                "name": str(game_object.m_Name),
                "extras": {"unityObjectId": str(identity)},
            }
            if not is_root:
                matrix = _gltf_matrix(transform)
                if not np.allclose(np.asarray(matrix).reshape(4, 4).T, np.identity(4), atol=1e-8):
                    node["matrix"] = matrix

            renderers = components.get("MeshRenderer", [])
            unsupported_renderers = sorted(
                name for name in ("SkinnedMeshRenderer", "ParticleSystemRenderer") if components.get(name)
            )
            if unsupported_renderers:
                raise ValueError(
                    f"Home Spot background has unsupported renderers: "
                    f"{game_object.m_Name}: {', '.join(unsupported_renderers)}"
                )
            parsed_renderers = [value.read() for value in renderers]
            enabled_renderers = [value for value in parsed_renderers if bool(value.m_Enabled)]
            if len(enabled_renderers) > 1:
                raise ValueError(f"GameObject has multiple enabled MeshRenderers: {game_object.m_Name}")
            if enabled_renderers:
                filters = components.get("MeshFilter", [])
                if len(filters) != 1:
                    raise ValueError(
                        f"rendered GameObject must have one MeshFilter: {game_object.m_Name}"
                    )
                mesh_index = self._mesh(game_object, enabled_renderers[0], filters[0].read())
                if mesh_index is not None:
                    node["mesh"] = mesh_index

            node_index = len(self.document["nodes"])
            self.document["nodes"].append(node)
            children = []
            for child_pointer in transform.m_Children:
                child_transform = child_pointer.deref_parse_as_object()
                child = child_transform.m_GameObject.deref_parse_as_object()
                child_index = add(child)
                if child_index is not None:
                    children.append(child_index)
            if children:
                node["children"] = children
            return node_index

        root_index = add(root, is_root=True)
        if root_index is None:
            raise ValueError("Home Spot background root is inactive or hidden")
        self.document["nodes"][root_index]["extras"].update(
            {
                "coordinateSpace": "background-root-local",
                "sourcePath": self.source_path,
                "situationName": self.situation_name,
            }
        )
        self.document["scenes"][0]["nodes"] = [root_index]

    def finish(self) -> bytes:
        if not self.document["meshes"] or not self.document["scenes"][0]["nodes"]:
            raise ValueError("Home Spot GLB scene is empty")
        while len(self.binary) % 4:
            self.binary.append(0)
        self.document["buffers"] = [{"byteLength": len(self.binary)}]
        if self.extensions:
            self.document["extensionsUsed"] = sorted(self.extensions)
        for key in ("samplers", "textures", "images", "materials"):
            if not self.document[key]:
                self.document.pop(key)
        json_payload = stable_json(self.document).encode("utf-8")
        json_payload += b" " * (-len(json_payload) % 4)
        binary_payload = bytes(self.binary)
        total = 12 + 8 + len(json_payload) + 8 + len(binary_payload)
        return b"".join(
            (
                struct.pack("<4sII", b"glTF", 2, total),
                struct.pack("<I4s", len(json_payload), b"JSON"),
                json_payload,
                struct.pack("<I4s", len(binary_payload), b"BIN\0"),
                binary_payload,
            )
        )

    def statistics(self) -> dict[str, int]:
        return {
            "meshCount": self.mesh_count,
            "primitiveCount": self.primitive_count,
            "vertexCount": self.vertex_count,
            "triangleCount": self.triangle_count,
            "emptyMeshCount": self.empty_mesh_count,
        }


def _bundle_artifacts(manifest: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_sha: dict[str, dict[str, Any]] = {}
    by_path: dict[str, dict[str, Any]] = {}
    for value in manifest.get("files", []):
        if value.get("role") != "unity-bundle":
            continue
        digest = str(value.get("sha256") or "")
        path = str(value.get("path") or "")
        if not digest or not path or digest in by_sha or path in by_path:
            raise ValueError("Unity source manifest has missing or duplicate bundle identity")
        by_sha[digest] = value
        by_path[path] = value
    return by_sha, by_path


def _load_environment(
    source: Any,
    descriptor: dict[str, Any],
    artifacts_by_sha: dict[str, dict[str, Any]],
    artifacts_by_path: dict[str, dict[str, Any]],
) -> tuple[Any, dict[str, Any]]:
    digest = str(descriptor.get("selectedBundle") or "")
    artifact = artifacts_by_sha.get(digest)
    if artifact is None:
        raise ValueError(f"selected Unity bundle is absent from the source manifest: {digest}")
    root_path = str(artifact["path"])
    found = {root_path}
    pending = list((artifact.get("unity") or {}).get("dependencies", []))
    dependencies = []
    while pending:
        path = str(pending.pop())
        if path in found:
            continue
        dependency = artifacts_by_path.get(path)
        if dependency is None:
            raise ValueError(f"Unity dependency is absent from the source manifest: {path}")
        found.add(path)
        dependencies.append(path)
        pending.extend((dependency.get("unity") or {}).get("dependencies", []))

    environment = UnityPy.load(str(source.root / root_path))
    for path in sorted(dependencies):
        environment.load_file(str(source.root / path), is_dependency=True)
    if len(environment.assets) != 1:
        raise ValueError(
            f"selected Unity bundle must expose one primary assets file: {root_path}; "
            f"found {len(environment.assets)}"
        )
    return environment, artifact


def _source_path(row: dict[str, Any], field: str, identity: int) -> str:
    raw = row.get(field)
    if not isinstance(raw, str) or raw != raw.strip("/") or not raw.startswith("Spot/"):
        raise ValueError(f"Home Spot {identity} has an invalid {field}: {raw!r}")
    return validate_unity_path(f"Assets/AddressableResources/{raw}.prefab")


def home_spot_source_bundle_paths(
    config: ServerConfig,
    source_id: str,
    build_id: str,
) -> list[str]:
    """Return only the original Unity bundles needed to build Home Spot scenes."""

    source = source_layout(config.id, source_id)
    layout = build_layout(config.id, build_id)
    manifest = read_json(source.manifest)
    index = read_json(layout.metadata / "source-index.json")
    table = read_json(layout.master / "MasterHomeSpot.json")
    rows = table.get("_allData") if isinstance(table, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ValueError("MasterHomeSpot is empty or invalid")
    if (
        not isinstance(manifest, dict)
        or manifest.get("server") != config.id
        or manifest.get("sourceId") != source_id
    ):
        raise ValueError("source manifest identity does not match this Home Spot build")
    if (
        not isinstance(index, dict)
        or index.get("schema") != UNITY_INDEX_SCHEMA
        or index.get("server") != config.id
        or index.get("sourceId") != source_id
    ):
        raise ValueError("canonical Unity source index identity does not match this Home Spot build")

    store = UnityObjectStore(layout, index)
    artifacts_by_sha, _ = _bundle_artifacts(manifest)
    paths: set[str] = set()
    identities: set[int] = set()
    for row in sorted(rows, key=lambda value: int(value.get("_id") or 0)):
        identity = int(row.get("_id") or 0)
        if not identity or identity in identities:
            raise ValueError(f"MasterHomeSpot has an empty or repeated id: {identity}")
        identities.add(identity)
        source_path = _source_path(row, "_backgroundAssetPath", identity)
        descriptor = store.descriptor(source_path)
        digest = str(descriptor.get("selectedBundle") or "")
        artifact = artifacts_by_sha.get(digest)
        if artifact is None:
            raise ValueError(f"selected Unity bundle is absent from the source manifest: {digest}")
        paths.add(str(artifact["path"]))
    return sorted(paths)


def _object_records(store: UnityObjectStore, source_path: str) -> tuple[dict[str, Any], dict[str, Any]]:
    descriptor = store.descriptor(source_path)
    return descriptor, store.records(
        str(descriptor["selectedBundle"]), str(descriptor["serializedFile"])
    )


def _situation_document(
    store: UnityObjectStore, source_path: str
) -> tuple[str, dict[str, list[float]], dict[str, Any]]:
    descriptor, records = _object_records(store, source_path)
    roots = [
        records.get(str(int(value)), {})
        for value in descriptor.get("rootObjects", [])
        if records.get(str(int(value)), {}).get("type") == "GameObject"
    ]
    if len(roots) != 1:
        raise ValueError(f"Home Spot situation must have one GameObject root: {source_path}")
    root = roots[0].get("data", {})
    situation_name = str(root.get("m_Name") or "")
    if not SITUATION_NAME.fullmatch(situation_name):
        raise ValueError(f"Home Spot situation name is invalid: {source_path}: {situation_name!r}")
    candidates = [
        value.get("data", {})
        for value in records.values()
        if value.get("type") == "MonoBehaviour"
        and all(
            name in value.get("data", {})
            for name in ("backgroundPosition", "backgroundRotation", "backgroundScale")
        )
    ]
    if len(candidates) != 1:
        raise ValueError(
            f"Home Spot situation settings must resolve uniquely: {source_path}; found {len(candidates)}"
        )

    def vector(name: str) -> list[float]:
        value = candidates[0].get(name)
        if not isinstance(value, dict) or any(key not in value for key in ("x", "y", "z")):
            raise ValueError(f"Home Spot setting is not Vector3: {source_path}:{name}")
        result = [float(value[key]) for key in ("x", "y", "z")]
        if not all(math.isfinite(number) for number in result):
            raise ValueError(f"Home Spot setting contains a non-finite value: {source_path}:{name}")
        return result

    position = vector("backgroundPosition")
    rotation_euler = vector("backgroundRotation")
    scale = vector("backgroundScale")
    rotation = _unity_euler_quaternion(rotation_euler)
    field_of_view = float(candidates[0].get("fieldOfView") or 0)
    if not math.isfinite(field_of_view) or not 0 < field_of_view < 180:
        raise ValueError(f"Home Spot fieldOfView is invalid: {source_path}")
    orbit_ratio = float(candidates[0].get("orbitRatio") or 0)
    if not math.isfinite(orbit_ratio):
        raise ValueError(f"Home Spot orbitRatio is invalid: {source_path}")
    return (
        situation_name,
        {
            "position": position,
            "rotationEulerDegrees": rotation_euler,
            "rotationQuaternion": rotation,
            "scale": scale,
            "matrix": _gltf_trs_matrix(position, rotation, scale),
        },
        {
            "position": vector("defaultPositionOffset"),
            "target": vector("originalOffset"),
            "orbitRatio": orbit_ratio,
            "fieldOfView": field_of_view,
            "aspect": PREVIEW_ASPECT,
            "near": PREVIEW_NEAR,
            "far": PREVIEW_FAR,
        },
    )


def _background_root(environment: Any, descriptor: dict[str, Any], source_path: str) -> Any:
    asset = environment.assets[0]
    roots = []
    for value in descriptor.get("rootObjects", []):
        identity = int(value)
        reader = asset.objects.get(identity)
        if reader is not None and reader.type.name == "GameObject":
            roots.append(reader)
    if len(roots) != 1:
        raise ValueError(f"Home Spot background must have one GameObject root: {source_path}")
    return roots[0].read()


def _hidden_objects(root: Any, situation_name: str, source_path: str) -> set[int]:
    candidates = []
    for reader in _components(root).get("MonoBehaviour", []):
        value = reader.read_typetree()
        if "_situationObjects" in value:
            candidates.append(value["_situationObjects"])
    if len(candidates) != 1 or not isinstance(candidates[0], list):
        raise ValueError(
            f"Home Spot background situation table must resolve uniquely: {source_path}"
        )
    by_name: dict[str, list[Any]] = {}
    for value in candidates[0]:
        if not isinstance(value, dict):
            raise ValueError(f"Home Spot background situation entry is invalid: {source_path}")
        name = str(value.get("SituationName") or "")
        hidden = value.get("HideObjects")
        if not SITUATION_NAME.fullmatch(name) or not isinstance(hidden, list) or name in by_name:
            raise ValueError(f"Home Spot background situation entry is ambiguous: {source_path}")
        by_name[name] = hidden
    if situation_name not in by_name:
        raise ValueError(
            f"Home Spot background has no exact situation {situation_name!r}: {source_path}"
        )
    result: set[int] = set()
    for pointer in by_name[situation_name]:
        if not isinstance(pointer, dict) or int(pointer.get("m_FileID") or 0) != 0:
            raise ValueError(
                f"Home Spot HideObjects contains a non-local pointer: {source_path}:{situation_name}"
            )
        identity = int(pointer.get("m_PathID") or 0)
        if not identity or identity in result:
            raise ValueError(
                f"Home Spot HideObjects contains an empty or repeated pointer: "
                f"{source_path}:{situation_name}"
            )
        result.add(identity)
    return result


def _output_relative(
    source_path: str,
    situation_name: str,
    root_id: str,
    output_type: str,
    suffix: str,
) -> str:
    filename = f"{situation_name}--{output_type}-{root_id}.{suffix}"
    return PurePosixPath("runtime", "unity", source_path, filename).as_posix()


def _remove_stale_outputs(layout: Any, previous: Any, current: set[str]) -> None:
    if not isinstance(previous, dict) or previous.get("schema") != SCHEMA:
        return
    for scene in previous.get("scenes", []):
        if not isinstance(scene, dict):
            continue
        for key in ("output", "preview"):
            output = scene.get(key, {})
            relative = output.get("path") if isinstance(output, dict) else None
            if not isinstance(relative, str) or relative in current:
                continue
            normalized = normalize_release_path(relative)
            if (
                normalized != relative
                or not relative.startswith("runtime/unity/")
                or PurePosixPath(relative).suffix not in (".glb", ".png")
            ):
                raise ValueError(f"previous Home Spot output path is invalid: {relative!r}")
            (layout.root / Path(*PurePosixPath(relative).parts)).unlink(missing_ok=True)


def build_home_spots(config: ServerConfig, source_id: str, build_id: str) -> dict[str, Any]:
    source = source_layout(config.id, source_id)
    layout = build_layout(config.id, build_id)
    index = read_json(layout.metadata / "source-index.json")
    manifest = read_json(source.manifest)
    if (
        not isinstance(index, dict)
        or index.get("schema") != UNITY_INDEX_SCHEMA
        or index.get("server") != config.id
        or index.get("sourceId") != source_id
    ):
        raise ValueError("canonical Unity source index identity does not match this Home Spot build")
    if (
        not isinstance(manifest, dict)
        or manifest.get("server") != config.id
        or manifest.get("sourceId") != source_id
    ):
        raise ValueError("source manifest identity does not match this Home Spot build")
    table = read_json(layout.master / "MasterHomeSpot.json")
    rows = table.get("_allData") if isinstance(table, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ValueError("MasterHomeSpot is empty or invalid")
    store = UnityObjectStore(layout, index)
    artifacts_by_sha, artifacts_by_path = _bundle_artifacts(manifest)
    scenes = []
    identities: set[int] = set()
    mappings: set[tuple[str, str]] = set()
    outputs: set[str] = set()

    metadata_file = layout.metadata / "home-spots.json"
    previous = read_json(metadata_file) if metadata_file.is_file() else None
    for row in sorted(rows, key=lambda value: int(value.get("_id") or 0)):
        identity = int(row.get("_id") or 0)
        if not identity or identity in identities:
            raise ValueError(f"MasterHomeSpot has an empty or repeated id: {identity}")
        identities.add(identity)
        background_source = _source_path(row, "_backgroundAssetPath", identity)
        situation_source = _source_path(row, "_situationAssetPath", identity)
        if background_source not in index.get("sources", {}) or situation_source not in index.get("sources", {}):
            raise ValueError(
                f"Home Spot source is absent from the canonical Unity index: {identity}: "
                f"{background_source} / {situation_source}"
            )
        situation_name, background_transform, camera = _situation_document(
            store, situation_source
        )
        mapping = (background_source, situation_name)
        if mapping in mappings:
            raise ValueError(f"Home Spot background/situation mapping repeats: {mapping}")
        mappings.add(mapping)

        descriptor = store.descriptor(background_source)
        environment, artifact = _load_environment(
            source, descriptor, artifacts_by_sha, artifacts_by_path
        )
        root = _background_root(environment, descriptor, background_source)
        root_id = str(int(root.object_reader.path_id))
        hidden = _hidden_objects(root, situation_name, background_source)
        builder = _GlbBuilder(background_source, situation_name, root_id)
        builder.add_scene(root, hidden)
        payload = builder.finish()
        relative = _output_relative(
            background_source,
            situation_name,
            root_id,
            OUTPUT_TYPE,
            "glb",
        )
        if relative in outputs:
            raise ValueError(f"Home Spot GLB output path repeats: {relative}")
        outputs.add(relative)
        output_file = layout.root / Path(*PurePosixPath(relative).parts)
        atomic_write(output_file, payload)
        output = {
            "path": relative,
            "runtime": f"/runtime/{config.id}/{relative.removeprefix('runtime/')}",
            "role": "derivative",
            "type": OUTPUT_TYPE,
            "objectId": root_id,
            "situationName": situation_name,
            "coordinateSpace": "background-root-local",
            "bytes": output_file.stat().st_size,
            "sha256": sha256_file(output_file),
        }
        # The default camera placement first puts the camera at
        # defaultPositionOffset, looks at originalOffset, then moves it back
        # along that forward vector by orbitRatio. Reflect the authored Unity
        # vectors into the same Three/glTF coordinate space as the scene before
        # applying those operations.
        camera_base = np.asarray(
            [camera["position"][0], camera["position"][1], -camera["position"][2]],
            dtype=np.float64,
        )
        camera_target = np.asarray(
            [camera["target"][0], camera["target"][1], -camera["target"][2]],
            dtype=np.float64,
        )
        camera_forward = camera_target - camera_base
        camera_forward_length = float(np.linalg.norm(camera_forward))
        if not math.isfinite(camera_forward_length) or camera_forward_length <= 1e-9:
            raise ValueError(f"Home Spot preview camera direction is invalid: {identity}")
        camera_position = camera_base - (
            camera_forward / camera_forward_length * float(camera["orbitRatio"])
        )
        preview_payload, preview_statistics = render_home_spot_preview(
            payload,
            background_transform["matrix"],
            camera_position.tolist(),
            camera_target.tolist(),
            float(camera["fieldOfView"]),
            float(camera["aspect"]),
        )
        preview_relative = _output_relative(
            background_source,
            situation_name,
            root_id,
            "SpotBackgroundPreviewPNG",
            "png",
        )
        if preview_relative in outputs:
            raise ValueError(f"Home Spot PNG preview output path repeats: {preview_relative}")
        outputs.add(preview_relative)
        preview_file = layout.root / Path(*PurePosixPath(preview_relative).parts)
        atomic_write(preview_file, preview_payload)
        preview = {
            "path": preview_relative,
            "runtime": f"/runtime/{config.id}/{preview_relative.removeprefix('runtime/')}",
            "role": "derivative",
            "type": "SpotBackgroundPreviewPNG",
            "objectId": root_id,
            "situationName": situation_name,
            "coordinateSpace": "camera-render",
            "bytes": preview_file.stat().st_size,
            "sha256": sha256_file(preview_file),
            "width": preview_statistics["width"],
            "height": preview_statistics["height"],
            "renderTriangleCount": preview_statistics["triangleCount"],
            "visiblePixelCount": preview_statistics["visiblePixelCount"],
        }
        scenes.append(
            {
                "spotId": identity,
                "sourcePath": background_source,
                "situationSourcePath": situation_source,
                "situationName": situation_name,
                "selectedBundle": str(descriptor.get("selectedBundle") or ""),
                "bundleFilename": str(artifact.get("originalFilename") or ""),
                "sourceRootTransform": _transform_document(_only_component(root, "Transform")),
                "backgroundTransform": background_transform,
                "camera": camera,
                "hiddenObjectCount": len(hidden),
                "output": output,
                "preview": preview,
                **builder.statistics(),
            }
        )

    _remove_stale_outputs(layout, previous, outputs)
    result = {
        "schema": SCHEMA,
        "server": config.id,
        "sourceId": source_id,
        "sceneCount": len(scenes),
        "scenes": scenes,
    }
    write_json(metadata_file, result, pretty=True)
    return result
