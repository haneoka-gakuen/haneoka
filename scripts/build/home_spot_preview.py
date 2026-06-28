"""Deterministic, dependency-free software previews for Home Spot GLBs.

Only NumPy and Pillow are used, both already pinned pipeline dependencies.
The rasterizer implements a perspective camera, near/far clipping, a depth
buffer, perspective-correct UV interpolation, the glTF sampler wrapping used
by the source textures, alpha masking, and sorted alpha blending.
"""

from __future__ import annotations

import io
import json
import math
import struct
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image


PREVIEW_WIDTH = 960
PREVIEW_HEIGHT = 540
PREVIEW_ASPECT = PREVIEW_WIDTH / PREVIEW_HEIGHT
PREVIEW_NEAR = 0.01
PREVIEW_FAR = 1000.0


_COMPONENT_TYPES: dict[int, np.dtype[Any]] = {
    5120: np.dtype("<i1"),
    5121: np.dtype("<u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
_TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


@dataclass(frozen=True)
class _Material:
    color: np.ndarray
    texture: np.ndarray | None
    mag_filter: int
    wrap_s: int
    wrap_t: int
    alpha_mode: str
    alpha_cutoff: float
    double_sided: bool


@dataclass(frozen=True)
class _Triangle:
    screen: np.ndarray
    ndc_depth: np.ndarray
    inverse_w: np.ndarray
    uv: np.ndarray | None
    material: _Material
    camera_distance: float
    determinant_sign: float


class _GlbDocument:
    def __init__(self, payload: bytes):
        if len(payload) < 28:
            raise ValueError("Home Spot GLB is truncated")
        magic, version, total = struct.unpack_from("<4sII", payload)
        if magic != b"glTF" or version != 2 or total != len(payload):
            raise ValueError("Home Spot GLB header is invalid")
        offset = 12
        chunks: dict[bytes, bytes] = {}
        while offset < len(payload):
            if offset + 8 > len(payload):
                raise ValueError("Home Spot GLB chunk header is truncated")
            length, kind = struct.unpack_from("<I4s", payload, offset)
            offset += 8
            end = offset + length
            if end > len(payload) or kind in chunks:
                raise ValueError("Home Spot GLB chunks are invalid or repeated")
            chunks[kind] = payload[offset:end]
            offset = end
        if offset != len(payload) or b"JSON" not in chunks or b"BIN\0" not in chunks:
            raise ValueError("Home Spot GLB must contain one JSON and one BIN chunk")
        try:
            self.document = json.loads(chunks[b"JSON"].rstrip(b" \0").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Home Spot GLB JSON is invalid") from error
        self.binary = chunks[b"BIN\0"]
        buffers = self.document.get("buffers")
        if (
            not isinstance(buffers, list)
            or len(buffers) != 1
            or int(buffers[0].get("byteLength") or -1) != len(self.binary)
            or buffers[0].get("uri")
        ):
            raise ValueError("Home Spot GLB must have one embedded binary buffer")
        self._accessors: dict[int, np.ndarray] = {}
        self._images: dict[int, np.ndarray] = {}
        self._materials: dict[int, _Material] = {}

    def view(self, index: int) -> bytes:
        views = self.document.get("bufferViews")
        if not isinstance(views, list) or not 0 <= index < len(views):
            raise ValueError(f"Home Spot GLB bufferView is invalid: {index}")
        view = views[index]
        if int(view.get("buffer") or 0) != 0 or "byteStride" in view:
            raise ValueError("Home Spot GLB preview does not support external or interleaved buffers")
        offset = int(view.get("byteOffset") or 0)
        length = int(view.get("byteLength") or 0)
        if offset < 0 or length <= 0 or offset + length > len(self.binary):
            raise ValueError(f"Home Spot GLB bufferView bounds are invalid: {index}")
        return self.binary[offset : offset + length]

    def accessor(self, index: int) -> np.ndarray:
        cached = self._accessors.get(index)
        if cached is not None:
            return cached
        accessors = self.document.get("accessors")
        if not isinstance(accessors, list) or not 0 <= index < len(accessors):
            raise ValueError(f"Home Spot GLB accessor is invalid: {index}")
        accessor = accessors[index]
        if accessor.get("sparse") or accessor.get("normalized"):
            raise ValueError("Home Spot GLB preview does not support sparse/normalized accessors")
        component_type = int(accessor.get("componentType") or 0)
        dtype = _COMPONENT_TYPES.get(component_type)
        components = _TYPE_COMPONENTS.get(str(accessor.get("type") or ""))
        count = int(accessor.get("count") or 0)
        if dtype is None or components is None or count <= 0:
            raise ValueError(f"Home Spot GLB accessor layout is invalid: {index}")
        raw = self.view(int(accessor.get("bufferView") or 0))
        byte_offset = int(accessor.get("byteOffset") or 0)
        byte_length = count * components * dtype.itemsize
        if byte_offset < 0 or byte_offset + byte_length > len(raw):
            raise ValueError(f"Home Spot GLB accessor bounds are invalid: {index}")
        values = np.frombuffer(raw, dtype=dtype, count=count * components, offset=byte_offset)
        values = values.reshape(count, components).copy()
        self._accessors[index] = values
        return values

    def image(self, index: int) -> np.ndarray:
        cached = self._images.get(index)
        if cached is not None:
            return cached
        images = self.document.get("images")
        if not isinstance(images, list) or not 0 <= index < len(images):
            raise ValueError(f"Home Spot GLB image is invalid: {index}")
        value = images[index]
        if value.get("mimeType") != "image/png" or "uri" in value:
            raise ValueError("Home Spot GLB preview requires embedded PNG textures")
        try:
            with Image.open(io.BytesIO(self.view(int(value.get("bufferView") or 0)))) as image:
                texture = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
        except Exception as error:
            raise ValueError(f"Home Spot GLB PNG texture is invalid: {index}") from error
        self._images[index] = texture
        return texture

    def material(self, index: int) -> _Material:
        cached = self._materials.get(index)
        if cached is not None:
            return cached
        materials = self.document.get("materials")
        if not isinstance(materials, list) or not 0 <= index < len(materials):
            raise ValueError(f"Home Spot GLB material is invalid: {index}")
        value = materials[index]
        pbr = value.get("pbrMetallicRoughness")
        if not isinstance(pbr, dict):
            raise ValueError(f"Home Spot GLB material has no PBR surface: {index}")
        color = np.asarray(pbr.get("baseColorFactor", [1, 1, 1, 1]), dtype=np.float64)
        if color.shape != (4,) or not np.isfinite(color).all() or np.any(color < 0):
            raise ValueError(f"Home Spot GLB base color is invalid: {index}")
        color = np.clip(color, 0, 1)

        texture = None
        mag_filter = 9729
        wrap_s = wrap_t = 10497
        texture_info = pbr.get("baseColorTexture")
        if texture_info is not None:
            textures = self.document.get("textures")
            texture_index = int(texture_info.get("index") or 0)
            if not isinstance(textures, list) or not 0 <= texture_index < len(textures):
                raise ValueError(f"Home Spot GLB base texture is invalid: {index}")
            texture_value = textures[texture_index]
            texture = self.image(int(texture_value.get("source") or 0))
            samplers = self.document.get("samplers")
            sampler_index = int(texture_value.get("sampler") or 0)
            if not isinstance(samplers, list) or not 0 <= sampler_index < len(samplers):
                raise ValueError(f"Home Spot GLB sampler is invalid: {index}")
            sampler = samplers[sampler_index]
            mag_filter = int(sampler.get("magFilter") or 9729)
            wrap_s = int(sampler.get("wrapS") or 10497)
            wrap_t = int(sampler.get("wrapT") or 10497)
            if mag_filter not in (9728, 9729) or wrap_s not in (10497, 33071, 33648) or wrap_t not in (
                10497,
                33071,
                33648,
            ):
                raise ValueError(f"Home Spot GLB sampler mode is unsupported: {index}")

        alpha_mode = str(value.get("alphaMode") or "OPAQUE")
        alpha_cutoff = float(value.get("alphaCutoff", 0.5))
        if alpha_mode not in ("OPAQUE", "MASK", "BLEND") or not 0 <= alpha_cutoff <= 1:
            raise ValueError(f"Home Spot GLB alpha mode is invalid: {index}")
        material = _Material(
            color=color,
            texture=texture,
            mag_filter=mag_filter,
            wrap_s=wrap_s,
            wrap_t=wrap_t,
            alpha_mode=alpha_mode,
            alpha_cutoff=alpha_cutoff,
            double_sided=bool(value.get("doubleSided")),
        )
        self._materials[index] = material
        return material


def _matrix(value: Any) -> np.ndarray:
    values = np.asarray(value, dtype=np.float64)
    if values.shape != (16,) or not np.isfinite(values).all():
        raise ValueError("Home Spot preview Transform matrix is invalid")
    return values.reshape(4, 4).T


def _node_matrix(node: dict[str, Any]) -> np.ndarray:
    if "matrix" in node:
        if any(key in node for key in ("translation", "rotation", "scale")):
            raise ValueError("Home Spot GLB node mixes matrix and TRS")
        return _matrix(node["matrix"])
    translation = np.asarray(node.get("translation", [0, 0, 0]), dtype=np.float64)
    rotation = np.asarray(node.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
    scale = np.asarray(node.get("scale", [1, 1, 1]), dtype=np.float64)
    if translation.shape != (3,) or rotation.shape != (4,) or scale.shape != (3,):
        raise ValueError("Home Spot GLB node TRS is invalid")
    norm = np.linalg.norm(rotation)
    if not np.isfinite(norm) or norm <= 0 or not np.isfinite(translation).all() or not np.isfinite(scale).all():
        raise ValueError("Home Spot GLB node TRS contains a non-finite value")
    x, y, z, w = rotation / norm
    result = np.identity(4, dtype=np.float64)
    result[:3, :3] = np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ]
    ) @ np.diag(scale)
    result[:3, 3] = translation
    return result


def _look_at(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    backward = eye - target
    length = np.linalg.norm(backward)
    if not np.isfinite(length) or length <= 1e-9:
        raise ValueError("Home Spot preview camera eye and target coincide")
    backward /= length
    right = np.cross(np.array([0.0, 1.0, 0.0]), backward)
    length = np.linalg.norm(right)
    if length <= 1e-9:
        raise ValueError("Home Spot preview camera is parallel to its up vector")
    right /= length
    up = np.cross(backward, right)
    view = np.identity(4, dtype=np.float64)
    view[0, :3] = right
    view[1, :3] = up
    view[2, :3] = backward
    view[:3, 3] = -view[:3, :3] @ eye
    return view


def _clip_plane(
    vertices: list[np.ndarray], uv: list[np.ndarray] | None, plane_z: float, keep_less: bool
) -> tuple[list[np.ndarray], list[np.ndarray] | None]:
    if not vertices:
        return [], [] if uv is not None else None
    output_vertices: list[np.ndarray] = []
    output_uv: list[np.ndarray] | None = [] if uv is not None else None

    def inside(value: np.ndarray) -> bool:
        return bool(value[2] <= plane_z) if keep_less else bool(value[2] >= plane_z)

    for index, current in enumerate(vertices):
        previous = vertices[index - 1]
        current_inside = inside(current)
        previous_inside = inside(previous)
        current_uv = uv[index] if uv is not None else None
        previous_uv = uv[index - 1] if uv is not None else None
        if current_inside != previous_inside:
            denominator = current[2] - previous[2]
            if abs(denominator) <= 1e-12:
                raise ValueError("Home Spot preview clipping edge is degenerate")
            amount = (plane_z - previous[2]) / denominator
            output_vertices.append(previous + (current - previous) * amount)
            if output_uv is not None and current_uv is not None and previous_uv is not None:
                output_uv.append(previous_uv + (current_uv - previous_uv) * amount)
        if current_inside:
            output_vertices.append(current)
            if output_uv is not None and current_uv is not None:
                output_uv.append(current_uv)
    return output_vertices, output_uv


def _wrap(values: np.ndarray, mode: int) -> np.ndarray:
    if mode == 10497:
        return values - np.floor(values)
    if mode == 33071:
        return np.clip(values, 0, 1)
    if mode == 33648:
        repeated = np.mod(values, 2)
        return np.where(repeated <= 1, repeated, 2 - repeated)
    raise ValueError(f"Home Spot preview texture wrap mode is unsupported: {mode}")


def _sample(material: _Material, uv: np.ndarray | None) -> np.ndarray:
    if material.texture is None:
        shape = uv.shape[:-1] if uv is not None else ()
        return np.broadcast_to(material.color, (*shape, 4)).copy()
    if uv is None:
        raise ValueError("Home Spot textured primitive has no UV coordinates")
    texture = material.texture
    u = _wrap(uv[..., 0], material.wrap_s)
    v = _wrap(uv[..., 1], material.wrap_t)
    x = u * (texture.shape[1] - 1)
    y = v * (texture.shape[0] - 1)
    if material.mag_filter == 9728:
        sampled = texture[np.rint(y).astype(np.int64), np.rint(x).astype(np.int64)]
    else:
        x0 = np.floor(x).astype(np.int64)
        y0 = np.floor(y).astype(np.int64)
        x1 = np.minimum(x0 + 1, texture.shape[1] - 1)
        y1 = np.minimum(y0 + 1, texture.shape[0] - 1)
        fx = (x - x0)[..., None]
        fy = (y - y0)[..., None]
        top = texture[y0, x0].astype(np.float64) * (1 - fx) + texture[y0, x1].astype(np.float64) * fx
        bottom = texture[y1, x0].astype(np.float64) * (1 - fx) + texture[y1, x1].astype(np.float64) * fx
        sampled = top * (1 - fy) + bottom * fy
    return np.clip(sampled.astype(np.float64) / 255 * material.color, 0, 1)


def _rasterize_triangle(
    triangle: _Triangle,
    frame: np.ndarray,
    depth_buffer: np.ndarray,
    write_depth: bool,
) -> None:
    screen = triangle.screen
    x_min = max(0, int(math.floor(float(np.min(screen[:, 0])))))
    x_max = min(frame.shape[1] - 1, int(math.ceil(float(np.max(screen[:, 0])))))
    y_min = max(0, int(math.floor(float(np.min(screen[:, 1])))))
    y_max = min(frame.shape[0] - 1, int(math.ceil(float(np.max(screen[:, 1])))))
    if x_min > x_max or y_min > y_max:
        return
    x0, y0 = screen[0]
    x1, y1 = screen[1]
    x2, y2 = screen[2]
    denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if abs(denominator) <= 1e-9:
        return
    signed_area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
    if not triangle.material.double_sided and signed_area * triangle.determinant_sign >= 0:
        return

    grid_y, grid_x = np.mgrid[y_min : y_max + 1, x_min : x_max + 1]
    sample_x = grid_x.astype(np.float64) + 0.5
    sample_y = grid_y.astype(np.float64) + 0.5
    first = ((y1 - y2) * (sample_x - x2) + (x2 - x1) * (sample_y - y2)) / denominator
    second = ((y2 - y0) * (sample_x - x2) + (x0 - x2) * (sample_y - y2)) / denominator
    third = 1 - first - second
    inside = (first >= -1e-8) & (second >= -1e-8) & (third >= -1e-8)
    if not np.any(inside):
        return
    depth = (first * triangle.ndc_depth[0] + second * triangle.ndc_depth[1] + third * triangle.ndc_depth[2] + 1) / 2
    depth_region = depth_buffer[y_min : y_max + 1, x_min : x_max + 1]
    visible = inside & (depth >= 0) & (depth <= 1) & (depth < depth_region)
    if not np.any(visible):
        return

    uv = None
    if triangle.uv is not None:
        reciprocal = (
            first * triangle.inverse_w[0]
            + second * triangle.inverse_w[1]
            + third * triangle.inverse_w[2]
        )
        valid_reciprocal = reciprocal > 1e-12
        visible &= valid_reciprocal
        if not np.any(visible):
            return
        uv = (
            first[..., None] * triangle.uv[0] * triangle.inverse_w[0]
            + second[..., None] * triangle.uv[1] * triangle.inverse_w[1]
            + third[..., None] * triangle.uv[2] * triangle.inverse_w[2]
        ) / reciprocal[..., None]
    source = _sample(triangle.material, uv)
    alpha = source[..., 3]
    if triangle.material.alpha_mode == "MASK":
        visible &= alpha >= triangle.material.alpha_cutoff
    elif triangle.material.alpha_mode == "BLEND":
        visible &= alpha > 1 / 255
    if not np.any(visible):
        return

    frame_region = frame[y_min : y_max + 1, x_min : x_max + 1]
    if triangle.material.alpha_mode == "BLEND":
        source_alpha = alpha[visible]
        destination = frame_region[visible]
        destination_alpha = destination[:, 3]
        output_alpha = source_alpha + destination_alpha * (1 - source_alpha)
        premultiplied = (
            source[visible, :3] * source_alpha[:, None]
            + destination[:, :3] * destination_alpha[:, None] * (1 - source_alpha[:, None])
        )
        destination[:, :3] = np.divide(
            premultiplied,
            output_alpha[:, None],
            out=np.zeros_like(premultiplied),
            where=output_alpha[:, None] > 1e-12,
        )
        destination[:, 3] = output_alpha
        frame_region[visible] = destination
    else:
        frame_region[visible, :3] = source[visible, :3]
        frame_region[visible, 3] = 1
    if write_depth:
        depth_region[visible] = depth[visible]


def _triangles(
    glb: _GlbDocument,
    background_matrix: list[float],
    camera_position: list[float],
    camera_target: list[float],
    field_of_view: float,
    aspect: float,
) -> list[_Triangle]:
    nodes = glb.document.get("nodes")
    meshes = glb.document.get("meshes")
    scenes = glb.document.get("scenes")
    scene_index = int(glb.document.get("scene") or 0)
    if (
        not isinstance(nodes, list)
        or not isinstance(meshes, list)
        or not isinstance(scenes, list)
        or not 0 <= scene_index < len(scenes)
    ):
        raise ValueError("Home Spot GLB scene graph is invalid")
    roots = scenes[scene_index].get("nodes")
    if not isinstance(roots, list) or not roots:
        raise ValueError("Home Spot GLB scene has no roots")
    eye = np.asarray(camera_position, dtype=np.float64)
    target = np.asarray(camera_target, dtype=np.float64)
    if eye.shape != (3,) or target.shape != (3,) or not np.isfinite(eye).all() or not np.isfinite(target).all():
        raise ValueError("Home Spot preview camera vectors are invalid")
    if not 0 < field_of_view < 180 or not math.isfinite(aspect) or aspect <= 0:
        raise ValueError("Home Spot preview camera projection is invalid")
    view = _look_at(eye, target)
    background = _matrix(background_matrix)
    focal = 1 / math.tan(math.radians(field_of_view) / 2)
    result: list[_Triangle] = []
    visited: set[int] = set()

    def visit(node_index: int, parent: np.ndarray) -> None:
        if not 0 <= node_index < len(nodes) or node_index in visited:
            raise ValueError(f"Home Spot GLB node is invalid or repeated: {node_index}")
        visited.add(node_index)
        node = nodes[node_index]
        world = parent @ _node_matrix(node)
        mesh_index = node.get("mesh")
        if mesh_index is not None:
            mesh_index = int(mesh_index)
            if not 0 <= mesh_index < len(meshes):
                raise ValueError(f"Home Spot GLB mesh reference is invalid: {mesh_index}")
            determinant = float(np.linalg.det(world[:3, :3]))
            if not math.isfinite(determinant) or abs(determinant) <= 1e-12:
                raise ValueError(f"Home Spot GLB mesh Transform is singular: {mesh_index}")
            determinant_sign = 1.0 if determinant > 0 else -1.0
            for primitive in meshes[mesh_index].get("primitives", []):
                if int(primitive.get("mode", 4)) != 4:
                    raise ValueError("Home Spot GLB preview only supports triangle primitives")
                attributes = primitive.get("attributes")
                if not isinstance(attributes, dict) or "POSITION" not in attributes or "indices" not in primitive:
                    raise ValueError("Home Spot GLB primitive is incomplete")
                positions = glb.accessor(int(attributes["POSITION"])).astype(np.float64)
                if positions.shape[1] != 3:
                    raise ValueError("Home Spot GLB POSITION accessor must be VEC3")
                indices = glb.accessor(int(primitive["indices"])).reshape(-1).astype(np.int64)
                if indices.size % 3 or int(indices.min()) < 0 or int(indices.max()) >= len(positions):
                    raise ValueError("Home Spot GLB primitive indices are invalid")
                uv = None
                if "TEXCOORD_0" in attributes:
                    uv = glb.accessor(int(attributes["TEXCOORD_0"])).astype(np.float64)
                    if uv.shape != (len(positions), 2):
                        raise ValueError("Home Spot GLB TEXCOORD_0 accessor must match POSITION")
                material = glb.material(int(primitive.get("material") or 0))
                homogeneous = np.concatenate(
                    (positions, np.ones((len(positions), 1), dtype=np.float64)), axis=1
                )
                camera_vertices = (view @ world @ homogeneous.T).T[:, :3]
                for raw_triangle in indices.reshape(-1, 3):
                    polygon = [camera_vertices[index].copy() for index in raw_triangle]
                    polygon_uv = [uv[index].copy() for index in raw_triangle] if uv is not None else None
                    polygon, polygon_uv = _clip_plane(
                        polygon, polygon_uv, -PREVIEW_NEAR, keep_less=True
                    )
                    polygon, polygon_uv = _clip_plane(
                        polygon, polygon_uv, -PREVIEW_FAR, keep_less=False
                    )
                    if len(polygon) < 3:
                        continue
                    for fan_index in range(1, len(polygon) - 1):
                        vertices = np.asarray(
                            (polygon[0], polygon[fan_index], polygon[fan_index + 1]),
                            dtype=np.float64,
                        )
                        reciprocal_w = -1 / vertices[:, 2]
                        ndc_x = vertices[:, 0] * focal / aspect * reciprocal_w
                        ndc_y = vertices[:, 1] * focal * reciprocal_w
                        ndc_z = (
                            (PREVIEW_FAR + PREVIEW_NEAR) / (PREVIEW_NEAR - PREVIEW_FAR)
                            * vertices[:, 2]
                            + 2 * PREVIEW_FAR * PREVIEW_NEAR / (PREVIEW_NEAR - PREVIEW_FAR)
                        ) * reciprocal_w
                        screen = np.column_stack(
                            (
                                (ndc_x + 1) * 0.5 * PREVIEW_WIDTH,
                                (1 - ndc_y) * 0.5 * PREVIEW_HEIGHT,
                            )
                        )
                        triangle_uv = None
                        if polygon_uv is not None:
                            triangle_uv = np.asarray(
                                (
                                    polygon_uv[0],
                                    polygon_uv[fan_index],
                                    polygon_uv[fan_index + 1],
                                ),
                                dtype=np.float64,
                            )
                        result.append(
                            _Triangle(
                                screen=screen,
                                ndc_depth=ndc_z,
                                inverse_w=reciprocal_w,
                                uv=triangle_uv,
                                material=material,
                                camera_distance=float(-np.mean(vertices[:, 2])),
                                determinant_sign=determinant_sign,
                            )
                        )
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ValueError(f"Home Spot GLB node children are invalid: {node_index}")
        for child in children:
            visit(int(child), world)

    for root in roots:
        visit(int(root), background)
    return result


def render_home_spot_preview(
    glb_payload: bytes,
    background_matrix: list[float],
    camera_position: list[float],
    camera_target: list[float],
    field_of_view: float,
    aspect: float = PREVIEW_ASPECT,
) -> tuple[bytes, dict[str, int]]:
    if not math.isclose(aspect, PREVIEW_ASPECT, rel_tol=0, abs_tol=1e-12):
        raise ValueError(
            f"Home Spot preview dimensions require aspect {PREVIEW_ASPECT}, got {aspect}"
        )
    glb = _GlbDocument(glb_payload)
    triangles = _triangles(
        glb,
        background_matrix,
        camera_position,
        camera_target,
        field_of_view,
        aspect,
    )
    opaque = [value for value in triangles if value.material.alpha_mode != "BLEND"]
    transparent = sorted(
        (value for value in triangles if value.material.alpha_mode == "BLEND"),
        key=lambda value: value.camera_distance,
        reverse=True,
    )
    frame = np.zeros((PREVIEW_HEIGHT, PREVIEW_WIDTH, 4), dtype=np.float64)
    depth = np.full((PREVIEW_HEIGHT, PREVIEW_WIDTH), np.inf, dtype=np.float64)
    for triangle in opaque:
        _rasterize_triangle(triangle, frame, depth, write_depth=True)
    for triangle in transparent:
        _rasterize_triangle(triangle, frame, depth, write_depth=False)
    pixels = np.clip(np.floor(frame * 255 + 0.5), 0, 255).astype(np.uint8)
    visible_pixels = int(np.count_nonzero(pixels[..., 3]))
    if visible_pixels == 0:
        raise ValueError("Home Spot software preview rendered no visible pixels")
    output = io.BytesIO()
    Image.fromarray(pixels, mode="RGBA").save(
        output,
        format="PNG",
        compress_level=9,
        optimize=False,
    )
    return output.getvalue(), {
        "width": PREVIEW_WIDTH,
        "height": PREVIEW_HEIGHT,
        "triangleCount": len(triangles),
        "visiblePixelCount": visible_pixels,
    }
