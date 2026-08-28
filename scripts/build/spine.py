"""Build a provenance-preserving manifest for every extracted Spine model.

The Unity extractor already materializes the real Spine JSON, atlas text, and
page textures.  This stage connects those outputs through the actual Unity
``SkeletonDataAsset -> SpineAtlasAsset -> Material -> Texture2D`` pointers.
It intentionally does *not* invent a portrait from one atlas page: a browser
renderer is required to produce a composited character preview.

Anon Tokyo is represented twice in the result:

* as ordinary, independently loadable Spine components; and
* as data-derived default-character layer recipes, whose parts come only from
  the MasterATCharacter/Reloading/Replacementparts relation.

That keeps the output reusable for a generic Spine catalogue while preserving
the information needed for a future Anon Tokyo renderer.
"""

from __future__ import annotations

import base64
import http.server
import json
import math
import mimetypes
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

from core.config import PROJECT_ROOT, ServerConfig
from core.contracts import UNITY_INDEX_SCHEMA
from core.hashes import sha256_file
from core.manifests import atomic_write, read_json, write_json
from core.paths import build_layout, normalize_release_path, validate_unity_path
from core.unity_objects import UnityObjectStore


# v3 changes the public model identifier from a source-path-derived label to
# the Unity SkeletonDataAsset's own resource key.  Do not silently project a
# v2 manifest through the v3 catalog contract: callers must rebuild it.
SCHEMA = "haneoka-spine-build-v3"
# This is deliberately separate from the build schema.  A build can still
# expose a usable Skeleton/atlas graph when its preview policy changes, but an
# older rendered PNG must never be mistaken for the current static setup pose.
# v3 keeps the WebGL renderer's original transparent viewport intact.  The
# earlier v2 post-processing alpha-cropped that canvas, which is both a visual
# transform and an opportunity for edge-alpha values to be re-encoded.  v5
# replaces default-depth slot batching with the source Spine draw order, so a
# rendered v4 PNG must not be reused after this transparency-policy change.
PREVIEW_SCHEMA = "haneoka-spine-preview-v5"
BROWSER_RUNTIME_PACKAGE = "@esotericsoftware/spine-threejs"
BROWSER_RUNTIME_VERSION = "4.2.119"
BROWSER_RUNTIME_SERIES = "4.2"
DEFAULT_ANON_TOKYO_ANIMATION = "f_idle"
PREVIEW_UNAVAILABLE_REASON = "headless-webgl-spine-renderer-not-provisioned"
BROWSER_LOADER = "TextureAtlas + AtlasAttachmentLoader + SkeletonJson (explicit page resolver)"
PREVIEW_RENDERER = "headless-chrome-webgl-spine-threejs"
PREVIEW_WIDTH = 512
PREVIEW_HEIGHT = 512
PREVIEW_POSE_KIND = "setup"
PREVIEW_OUTPUT_PREFIX = "runtime/spine-previews"


_SKELETON_DATA_RESOURCE_SUFFIX = re.compile(r"_SkeletonData$", re.IGNORECASE)
_ROUTE_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}")
_SPINE_HASH = re.compile(r"[A-Za-z0-9+/_-]+={0,2}")


def _int_string(value: Any) -> str:
    """Return a canonical Unity path id, or an empty value when invalid."""

    if isinstance(value, bool):
        return ""
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return ""


def _positive_number(value: Any, fallback: float = 1.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) and number > 0 else fallback


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _integer(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _rows(file: Path) -> list[dict[str, Any]]:
    if not file.is_file():
        return []
    value = read_json(file)
    rows = value.get("_allData") if isinstance(value, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _pointer_identity(value: Any, owner_serialized_file: str) -> tuple[str, str] | None:
    """Resolve a serialized Unity PPtr without guessing an external target."""

    if not isinstance(value, dict):
        return None
    path_id = _int_string(value.get("m_PathID"))
    if not path_id or path_id == "0":
        return None
    reference = value.get("reference")
    reference = reference if isinstance(reference, dict) else {}
    reference_file = str(reference.get("serializedFile") or "")
    if reference_file:
        return reference_file, path_id
    if _integer(value.get("m_FileID")) == 0:
        return owner_serialized_file, path_id
    return None


def _release_url(server: str, output_path: str) -> str | None:
    """Turn a verified build output into the matching public release URL."""

    if output_path.startswith("assets/"):
        relative = output_path.removeprefix("assets/")
        return f"/assets/{quote(server, safe='')}/{quote(relative, safe='/')}"
    if output_path.startswith("runtime/"):
        relative = output_path.removeprefix("runtime/")
        return f"/runtime/{quote(server, safe='')}/{quote(relative, safe='/')}"
    return None


def _reason(code: str, detail: str) -> dict[str, str]:
    return {"code": code, "detail": detail}


def _atlas_pages(text: str) -> list[str]:
    """Read only page names from an Atlas file, including Spine 4.2 headers."""

    pages: list[str] = []
    expecting_page = True
    for line in text.splitlines():
        value = line.strip()
        if not value:
            expecting_page = True
            continue
        if not expecting_page:
            continue
        # Atlas-wide 4.2 header fields such as ``pma: true`` are not pages.
        if ":" in value:
            continue
        pages.append(value)
        expecting_page = False
    return pages


def _skin_names(value: Any) -> list[str]:
    if isinstance(value, list):
        return sorted(
            {
                str(item.get("name") or "")
                for item in value
                if isinstance(item, dict) and str(item.get("name") or "")
            }
        )
    if isinstance(value, dict):
        return sorted(str(key) for key in value if str(key))
    return []


def _zero_time_null_attachment_slots(animation: Any) -> set[str]:
    """Read authored setup-time attachment clears without playing an animation."""

    slot_timelines = animation.get("slots") if isinstance(animation, dict) else None
    if not isinstance(slot_timelines, dict):
        return set()
    hidden: set[str] = set()
    for slot_name, timeline in slot_timelines.items():
        if not isinstance(slot_name, str) or not slot_name or not isinstance(timeline, dict):
            continue
        frames = timeline.get("attachment")
        if not isinstance(frames, list) or not frames or not isinstance(frames[0], dict):
            continue
        first = frames[0]
        time_value = first.get("time", 0)
        try:
            at_setup = math.isfinite(float(time_value)) and float(time_value) == 0
        except (TypeError, ValueError):
            at_setup = False
        # In Spine JSON an absent/null ``name`` is a null attachment frame.
        if at_setup and ("name" not in first or first.get("name") is None):
            hidden.add(slot_name)
    return hidden


def _initial_null_attachment_slots(skeleton_json: dict[str, Any]) -> set[str]:
    """Return slots which the authored front setup explicitly clears at t=0.

    Anon Tokyo's assets package both views into one Spine skeleton.  Their
    ``f_idle`` attachment timeline begins by clearing the back-facing slots,
    but applying that animation would also apply its motion timelines.  Read
    only that static, zero-time visibility declaration instead.
    """

    animations = skeleton_json.get("animations")
    animation = (
        animations.get(DEFAULT_ANON_TOKYO_ANIMATION)
        if isinstance(animations, dict)
        else None
    )
    return _zero_time_null_attachment_slots(animation)


def _anon_tokyo_variant_static_preview_policy(
    skeleton_json: dict[str, Any],
) -> dict[str, Any] | None:
    """Choose the authored right-side static visibility of a Fever variant.

    Fever stage skeletons package left and right performances in one Spine
    file.  They are not setup-pose duplicates by accident: the paired
    ``*_l``/``*_r`` timelines explicitly clear the opposite equipment slots
    at time zero.  A preview must not play either performance, but a setup
    snapshot also must not render both alternatives.  Use only the exact
    zero-time *null* slots of the deterministic ``*_r`` variant, and only
    when those slots are visibly populated in the authored setup pose.

    Do not infer this policy for skeletons with multiple paired variants or
    for unrelated null timeline slots.  Those cases have no unambiguous
    canonical static presentation.
    """

    animations = skeleton_json.get("animations")
    slots = skeleton_json.get("slots")
    if not isinstance(animations, dict) or not isinstance(slots, list):
        return None

    variants: list[tuple[str, str]] = []
    for animation_name, animation in animations.items():
        if not isinstance(animation_name, str) or not isinstance(animation, dict):
            continue
        stem, separator, side = animation_name.rpartition("_")
        if not stem or separator != "_" or side != "r":
            continue
        if isinstance(animations.get(f"{stem}_l"), dict):
            variants.append((animation_name, stem))
    if len(variants) != 1:
        return None

    variant, stem = variants[0]
    hidden = _zero_time_null_attachment_slots(animations[variant])
    left_slot_prefix = f"{stem}_l".casefold()
    setup_attachments = {
        str(slot.get("name") or "")
        for slot in slots
        if isinstance(slot, dict)
        and isinstance(slot.get("attachment"), str)
        and str(slot.get("attachment") or "")
    }
    hidden_setup_slots = sorted(
        slot_name
        for slot_name in hidden
        if slot_name.casefold().startswith(left_slot_prefix)
        and slot_name in setup_attachments
    )
    if not hidden_setup_slots:
        return None
    return {
        "visibility": "authored-variant-static",
        "variant": variant,
        "hiddenSetupSlots": hidden_setup_slots,
    }


def _anon_tokyo_front_preview_policy(skeleton_json: dict[str, Any] | None) -> dict[str, Any] | None:
    """Build a non-animated authored visibility policy when one is unambiguous.

    A ``B/`` setup attachment is independently strong evidence of a back
    component.  Include it as a fallback because some authored attachment
    aliases (for example ``dress5``) do not carry the prefix.  Prefer that
    explicit ``f_idle`` front declaration over a Fever left/right variant;
    both policies only clear setup slots and never advance an animation.
    """

    if not isinstance(skeleton_json, dict):
        return None
    animations = skeleton_json.get("animations")
    if not isinstance(animations, dict):
        return None
    if not isinstance(animations.get(DEFAULT_ANON_TOKYO_ANIMATION), dict):
        return _anon_tokyo_variant_static_preview_policy(skeleton_json)
    hidden = _initial_null_attachment_slots(skeleton_json)
    slots = skeleton_json.get("slots")
    if isinstance(slots, list):
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            slot_name = str(slot.get("name") or "")
            attachment = str(slot.get("attachment") or "")
            if slot_name and attachment.casefold().startswith("b/"):
                hidden.add(slot_name)
    return {
        "facing": "front",
        "visibility": "authored-front-static",
        "hiddenSetupSlots": sorted(hidden),
    }


def _spine_series(value: Any) -> str:
    text = str(value or "").strip()
    parts = text.split(".")
    if len(parts) >= 2 and all(part.isdigit() for part in parts[:2]):
        return f"{parts[0]}.{parts[1]}"
    return ""


class _PreviewError(RuntimeError):
    """A truthful, user-facing reason why a real preview was not emitted."""


def _preview_reason(code: str, detail: str) -> dict[str, str]:
    return _reason(code, detail[:500])


def _find_chrome() -> Path | None:
    configured = os.environ.get("HANEOKA_SPINE_CHROME", "").strip()
    candidates = [configured] if configured else []
    candidates.extend(
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            shutil.which("google-chrome") or "",
            shutil.which("chromium") or "",
            shutil.which("chromium-browser") or "",
        ]
    )
    for value in candidates:
        path = Path(value) if value else None
        if path is not None and path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def _spine_preview_enabled() -> bool:
    """Keep real rendering on by default, with an explicit CI escape hatch."""

    return os.environ.get("HANEOKA_SPINE_PREVIEW", "1").strip().casefold() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _spine_preview_runtime_reason() -> dict[str, str] | None:
    if not _spine_preview_enabled():
        return _preview_reason(
            "headless-preview-disabled",
            "HANEOKA_SPINE_PREVIEW disables the optional real-preview renderer.",
        )
    chrome = _find_chrome()
    if chrome is None:
        return _preview_reason(
            "headless-chrome-not-found",
            "No supported Chrome/Chromium executable is available for a real WebGL render.",
        )
    esbuild = PROJECT_ROOT / "node_modules" / ".bin" / "esbuild"
    if not esbuild.is_file() or not os.access(esbuild, os.X_OK):
        return _preview_reason(
            "esbuild-not-found",
            "The local esbuild executable required to bundle the exact Spine browser runtime is unavailable.",
        )
    package = PROJECT_ROOT / "node_modules" / "@esotericsoftware" / "spine-threejs" / "package.json"
    try:
        version = str(read_json(package).get("version") or "")
    except Exception as error:
        return _preview_reason(
            "spine-runtime-package-unreadable",
            f"Cannot inspect the local Spine browser runtime: {type(error).__name__}",
        )
    if version != BROWSER_RUNTIME_VERSION:
        return _preview_reason(
            "spine-runtime-package-version-mismatch",
            f"Expected @esotericsoftware/spine-threejs {BROWSER_RUNTIME_VERSION}, found {version or 'unknown'}.",
        )
    return None


class _CdpSocket:
    """Tiny dependency-free CDP WebSocket client for one local Chrome page."""

    def __init__(self, endpoint: str, timeout: float = 90) -> None:
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != "ws" or not parsed.hostname or not parsed.port:
            raise _PreviewError(f"invalid Chrome DevTools endpoint: {endpoint}")
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
        self.socket.settimeout(timeout)
        self._buffer = b""
        self._next_id = 1
        request_path = parsed.path or "/"
        if parsed.query:
            request_path += f"?{parsed.query}"
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.socket.sendall(
            (
                f"GET {request_path} HTTP/1.1\r\n"
                f"Host: {parsed.hostname}:{parsed.port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
        )
        response = self._read_until(b"\r\n\r\n")
        if not response.startswith(b"HTTP/1.1 101"):
            raise _PreviewError("Chrome DevTools WebSocket handshake failed")

    def close(self) -> None:
        try:
            self.socket.close()
        except OSError:
            pass

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self.socket.recv(max(4096, size - len(self._buffer)))
            if not chunk:
                raise _PreviewError("Chrome DevTools WebSocket closed unexpectedly")
            self._buffer += chunk
        result, self._buffer = self._buffer[:size], self._buffer[size:]
        return result

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buffer:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise _PreviewError("Chrome DevTools WebSocket closed during handshake")
            self._buffer += chunk
        end = self._buffer.index(marker) + len(marker)
        result, self._buffer = self._buffer[:end], self._buffer[end:]
        return result

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(bytes(header) + masked)

    def _read_message(self) -> str:
        fragments: list[bytes] = []
        message_opcode = 0
        while True:
            first, second = self._read_exact(2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 0x8:
                raise _PreviewError("Chrome DevTools WebSocket was closed")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in {0x1, 0x2}:
                message_opcode = opcode
            elif opcode != 0x0:
                raise _PreviewError(f"unexpected Chrome DevTools WebSocket opcode: {opcode}")
            fragments.append(payload)
            if fin:
                if message_opcode != 0x1:
                    raise _PreviewError("Chrome DevTools returned a non-text message")
                try:
                    return b"".join(fragments).decode("utf-8")
                except UnicodeDecodeError as error:
                    raise _PreviewError("Chrome DevTools returned invalid UTF-8") from error

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        call_id = self._next_id
        self._next_id += 1
        payload = {"id": call_id, "method": method, **({"params": params} if params else {})}
        self._send_frame(0x1, json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        while True:
            try:
                response = json.loads(self._read_message())
            except json.JSONDecodeError as error:
                raise _PreviewError("Chrome DevTools returned invalid JSON") from error
            if response.get("id") != call_id:
                continue
            if isinstance(response.get("error"), dict):
                raise _PreviewError(str(response["error"].get("message") or "Chrome DevTools command failed"))
            result = response.get("result")
            if not isinstance(result, dict):
                raise _PreviewError("Chrome DevTools returned an invalid command result")
            return result


class _PreviewHttpHandler(http.server.BaseHTTPRequestHandler):
    """Serve only local build media plus the transient bundled renderer."""

    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, build_root: Path, bundle: Path, **kwargs: Any) -> None:
        self.build_root = build_root.resolve()
        self.bundle = bundle
        super().__init__(*args, **kwargs)

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802 - HTTP handler API
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path == "/__haneoka_spine_preview__/index.html":
            payload = (
                "<!doctype html><meta charset=\"utf-8\">"
                "<script src=\"/__haneoka_spine_preview__/bundle.js\"></script>"
            ).encode("utf-8")
            self._send(payload, "text/html; charset=utf-8")
            return
        if path == "/__haneoka_spine_preview__/bundle.js":
            self._send(self.bundle.read_bytes(), "text/javascript; charset=utf-8")
            return
        raw = path.removeprefix("/")
        if not raw.startswith(("assets/", "runtime/")):
            self.send_error(404)
            return
        try:
            relative = normalize_release_path(raw)
            target = (self.build_root / Path(*PurePosixPath(relative).parts)).resolve()
            target.relative_to(self.build_root)
        except (ValueError, OSError):
            self.send_error(400)
            return
        if not target.is_file():
            self.send_error(404)
            return
        self._send(target.read_bytes(), mimetypes.guess_type(target.name)[0] or "application/octet-stream")

    def _send(self, payload: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


_SPINE_PREVIEW_BROWSER_SOURCE = r'''
import * as THREE from "three";
import * as spine from "@esotericsoftware/spine-threejs";

const fail = (code, detail) => ({ ok: false, code, detail: String(detail || "").slice(0, 500) });

async function imageFromUrl(url, sourcePma) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`image request failed (${response.status}): ${url}`);
  // Spine's Three.js renderer blends premultiplied texture pixels.  Decode
  // straight-alpha pages as premultiplied pixels here rather than asking
  // WebGL to do it during upload: ImageBitmap uploads do not consistently
  // honour UNPACK_PREMULTIPLY_ALPHA_WEBGL across Chrome paths, which leaves
  // bright RGB in zero/low-alpha texels and produces white fringes.
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: sourcePma ? "none" : "premultiply",
    colorSpaceConversion: "none",
  });
}

// Unity's verified Spine materials turn ZWrite off.  The Three integration
// normally coalesces adjacent same-texture slots into one material group,
// which makes painter-order transparency impossible without depending on
// depth writes.  Give every renderable authored slot its own reusable group
// instead. Geometry groups are then emitted in Skeleton.drawOrder and, with
// Three's transparent-object sort disabled below, are submitted in exactly
// that order.
function installSpinePainterOrder(mesh) {
  const nextBatch = mesh.nextBatch.bind(mesh);
  const configured = new WeakSet();
  mesh.nextBatch = () => {
    const batch = nextBatch();
    if (configured.has(batch)) return batch;
    configured.add(batch);

    let materialCursor = 0;
    const clear = batch.clear.bind(batch);
    batch.clear = () => {
      materialCursor = 0;
      return clear();
    };
    batch.findMaterialGroup = (slotTexture, slotBlendMode) => {
      const materials = batch.material;
      const materialIndex = materialCursor;
      const material = materials[materialIndex] ?? batch.newMaterial();
      if (!materials[materialIndex]) materials.push(material);
      materialCursor += 1;
      material.map = slotTexture;
      Object.assign(material, spine.ThreeJsTexture.toThreeJsBlending(slotBlendMode));
      material.needsUpdate = true;
      return materialIndex;
    };
    return batch;
  };
}

async function loadComponent(component) {
  const atlasResponse = await fetch(`/${component.atlas.path}`, { cache: "no-store" });
  if (!atlasResponse.ok) throw new Error(`atlas request failed (${atlasResponse.status}): ${component.atlas.path}`);
  const atlas = new spine.TextureAtlas(await atlasResponse.text());
  const pages = new Map(component.pages.map((value) => [value.name, value]));
  for (const page of atlas.pages) {
    const record = pages.get(page.name);
    if (!record) throw new Error(`atlas page has no exact material texture: ${page.name}`);
    // Both paths now hand ThreeJsTexture premultiplied pixels. Passing true
    // prevents a second premultiplication at texture upload.
    page.setTexture(new spine.ThreeJsTexture(await imageFromUrl(`/${record.path}`, page.pma), true));
  }
  const jsonResponse = await fetch(`/${component.json.path}`, { cache: "no-store" });
  if (!jsonResponse.ok) throw new Error(`skeleton request failed (${jsonResponse.status}): ${component.json.path}`);
  const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
  parser.scale = component.scale;
  const skeletonData = parser.readSkeletonData(JSON.parse(await jsonResponse.text()));
  // Match Unity's source material: all slot fragments use ordinary
  // premultiplied-alpha blending, but neither read nor write the depth buffer.
  // `installSpinePainterOrder` below makes the authored slot order, rather
  // than depth, authoritative. Single-pass double-sided materials avoid a
  // second back-face blend changing that order.
  const mesh = new spine.SkeletonMesh({
    skeletonData,
    twoColorTint: true,
    materialFactory: (parameters) => new THREE.MeshBasicMaterial({
      ...parameters,
      depthTest: false,
      depthWrite: false,
      forceSinglePass: true,
    }),
  });
  installSpinePainterOrder(mesh);
  // A catalogue preview is intentionally not a frame of an animation.  Do
  // not call SkeletonMesh.update(): it advances AnimationState, applies any
  // queued animation and advances skeleton time.  The setup pose includes the
  // authored default slots, bones and constraints without an expression or
  // action.  Physics.none is equally important: even a zero-duration update
  // may otherwise apply a physics pose.
  if (component.pose !== "setup") throw new Error(`unsupported preview pose: ${component.pose}`);
  // Many extracted game skeletons put their authored, non-animated
  // attachments in a skin literally named `skin`, instead of Spine's special
  // `default` skin. A newly-created Skeleton has no current skin, so its
  // setup slots would otherwise resolve to nothing. Selecting this verified
  // static skin is configuration, not animation: it neither applies a
  // timeline nor advances AnimationState.
  if (component.skin) mesh.skeleton.setSkinByName(component.skin);
  mesh.skeleton.setToSetupPose();
  // Some Anon Tokyo skeletons author both front and back attachments into
  // their setup pose.  The builder derives this exact list from the authored
  // front visibility at t=0, then clears it directly instead of playing
  // f_idle (which would also introduce pose/motion timelines).
  const hiddenSlots = Array.isArray(component.hiddenSlots)
    ? component.hiddenSlots.filter((value) => typeof value === "string" && value)
    : [];
  for (const slotName of hiddenSlots) {
    const slot = mesh.skeleton.findSlot(slotName);
    if (slot) slot.setAttachment(null);
  }
  mesh.skeleton.updateWorldTransform(spine.Physics.none);
  mesh.updateGeometry();
  mesh.renderOrder = component.order || 0;
  mesh.traverse((child) => { child.renderOrder = component.order || 0; });
  const order = Number(component.order);
  return { mesh, atlas, order: Number.isFinite(order) ? order : 0 };
}

function disposeComponent(component) {
  component.mesh.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
  });
  component.mesh.dispose();
  component.atlas.dispose();
}

function cameraFor(group, width, height) {
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  if (bounds.isEmpty()) throw new Error("rendered Spine geometry has no bounds");
  const size = bounds.getSize(new THREE.Vector3());
  if (!(size.x > 0) || !(size.y > 0)) throw new Error("rendered Spine geometry has zero bounds");
  const center = bounds.getCenter(new THREE.Vector3());
  const aspect = width / height;
  const padding = 1.12;
  let viewWidth = size.x * padding;
  let viewHeight = size.y * padding;
  if (viewWidth / viewHeight < aspect) viewWidth = viewHeight * aspect;
  else viewHeight = viewWidth / aspect;
  const camera = new THREE.OrthographicCamera(
    -viewWidth / 2, viewWidth / 2, viewHeight / 2, -viewHeight / 2, 0.1, 100,
  );
  camera.position.set(center.x, center.y, 10);
  camera.lookAt(center.x, center.y, 0);
  return camera;
}

window.__haneokaRenderSpinePreview = async (job) => {
  const width = Number(job.width || 512);
  const height = Number(job.height || 512);
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
  });
  const components = [];
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    // Individual geometry groups now correspond to authored Spine slots.
    // Three must not reorder their transparent material submissions.
    renderer.sortObjects = false;
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.scale.set(job.scale || 1, job.scale || 1, 1);
    scene.add(group);
    for (const component of job.components) {
      const loaded = await loadComponent(component);
      components.push(loaded);
      group.add(loaded.mesh);
    }
    const camera = cameraFor(group, width, height);
    // A recipe contains independently-authored SkeletonMesh instances. Render
    // one verified component at a time in MasterATReplacementparts order:
    // slot painter order remains native within a component, and the source
    // relation remains authoritative across components. Depth is deliberately
    // unused by the materials, but clear it too so a future opaque component
    // cannot leak state into the next source layer.
    const renderLayers = [...components].sort((left, right) => left.order - right.order);
    for (const component of components) component.mesh.visible = false;
    renderer.autoClear = false;
    renderer.clear(true, true, true);
    for (const component of renderLayers) {
      component.mesh.visible = true;
      renderer.render(scene, camera);
      component.mesh.visible = false;
      renderer.clearDepth();
    }
    const pixels = renderer.getContext().readPixels
      ? renderer.domElement.getContext("2d")?.getImageData(0, 0, width, height)?.data
      : null;
    let visiblePixelCount = 0;
    if (pixels) {
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visiblePixelCount++;
    } else {
      const pixels2d = document.createElement("canvas");
      pixels2d.width = width; pixels2d.height = height;
      const context = pixels2d.getContext("2d");
      context.drawImage(renderer.domElement, 0, 0);
      const values = context.getImageData(0, 0, width, height).data;
      for (let index = 3; index < values.length; index += 4) if (values[index] > 0) visiblePixelCount++;
    }
    if (!visiblePixelCount) return fail("rendered-image-empty", "The genuine WebGL render contains no visible pixels.");
    return { ok: true, png: canvas.toDataURL("image/png"), visiblePixelCount, width, height };
  } catch (error) {
    return fail("headless-webgl-render-failed", error && error.message ? error.message : error);
  } finally {
    for (const component of components) disposeComponent(component);
    renderer.dispose();
    renderer.forceContextLoss();
  }
};
window.__haneokaSpinePreviewReady = true;
'''


class _SpinePreviewRenderer:
    """Render many verified Spine graphs through one exact browser runtime."""

    def __init__(self, layout: Any) -> None:
        reason = _spine_preview_runtime_reason()
        if reason is not None:
            raise _PreviewError(f"{reason['code']}: {reason['detail']}")
        chrome = _find_chrome()
        if chrome is None:  # narrowed above; keeps static type checkers honest.
            raise _PreviewError("headless-chrome-not-found")
        self.layout = layout
        self.chrome = chrome
        self.esbuild = PROJECT_ROOT / "node_modules" / ".bin" / "esbuild"
        self._temporary = tempfile.TemporaryDirectory(prefix="haneoka-spine-preview-")
        self.temp_root = Path(self._temporary.name)
        self.server: http.server.ThreadingHTTPServer | None = None
        self.server_thread: threading.Thread | None = None
        self.chrome_process: subprocess.Popen[bytes] | None = None
        self.cdp: _CdpSocket | None = None

    def __enter__(self) -> _SpinePreviewRenderer:
        bundle = self.temp_root / "spine-preview-runtime.js"
        bundled = subprocess.run(
            [
                str(self.esbuild),
                "--bundle",
                "--format=iife",
                "--target=es2020",
                "--log-level=error",
                f"--outfile={bundle}",
            ],
            input=_SPINE_PREVIEW_BROWSER_SOURCE.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=PROJECT_ROOT,
            check=False,
        )
        if bundled.returncode != 0 or not bundle.is_file():
            detail = bundled.stderr.decode("utf-8", "replace").strip() or "esbuild failed"
            raise _PreviewError(f"esbuild-bundle-failed: {detail}")
        handler = lambda *args, **kwargs: _PreviewHttpHandler(
            *args, build_root=self.layout.root, bundle=bundle, **kwargs
        )
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        host, port = self.server.server_address[:2]
        page_url = f"http://{host}:{port}/__haneoka_spine_preview__/index.html"
        debug_port = self._unused_tcp_port()
        user_data = self.temp_root / "chrome-profile"
        self.chrome_process = subprocess.Popen(
            [
                str(self.chrome),
                "--headless=new",
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--use-angle=swiftshader",
                "--remote-debugging-address=127.0.0.1",
                f"--remote-debugging-port={debug_port}",
                f"--user-data-dir={user_data}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=512,512",
                page_url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        endpoint = self._page_endpoint(debug_port, page_url)
        self.cdp = _CdpSocket(endpoint)
        for _ in range(100):
            ready = self.cdp.call(
                "Runtime.evaluate",
                {
                    "expression": "Boolean(window.__haneokaSpinePreviewReady)",
                    "returnByValue": True,
                },
            )
            result = ready.get("result")
            if isinstance(result, dict) and result.get("value") is True:
                return self
            time.sleep(0.05)
        raise _PreviewError("headless-preview-page-did-not-initialize")

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        if self.cdp is not None:
            self.cdp.close()
        if self.chrome_process is not None:
            self.chrome_process.terminate()
            try:
                self.chrome_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.chrome_process.kill()
                self.chrome_process.wait(timeout=5)
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.server_thread is not None:
            self.server_thread.join(timeout=5)
        self._temporary.cleanup()

    @staticmethod
    def _unused_tcp_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as value:
            value.bind(("127.0.0.1", 0))
            return int(value.getsockname()[1])

    def _page_endpoint(self, debug_port: int, page_url: str) -> str:
        endpoint = f"http://127.0.0.1:{debug_port}/json/list"
        last_error = "Chrome DevTools did not start"
        for _ in range(160):
            if self.chrome_process is not None and self.chrome_process.poll() is not None:
                raise _PreviewError("headless-chrome-exited-before-devtools-ready")
            try:
                with urllib.request.urlopen(endpoint, timeout=1) as response:
                    pages = json.loads(response.read().decode("utf-8"))
                if isinstance(pages, list):
                    for page in pages:
                        if (
                            isinstance(page, dict)
                            and page.get("type") == "page"
                            and str(page.get("url") or "").startswith(page_url)
                            and isinstance(page.get("webSocketDebuggerUrl"), str)
                        ):
                            return page["webSocketDebuggerUrl"]
            except Exception as error:
                last_error = type(error).__name__
            time.sleep(0.05)
        raise _PreviewError(f"headless-chrome-devtools-unavailable: {last_error}")

    def render(self, job: dict[str, Any]) -> dict[str, Any]:
        if self.cdp is None:
            raise _PreviewError("headless-preview-renderer-is-not-started")
        expression = f"window.__haneokaRenderSpinePreview({json.dumps(job, separators=(',', ':'))})"
        response = self.cdp.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": True,
            },
        )
        result = response.get("result")
        if not isinstance(result, dict):
            raise _PreviewError("headless-preview-returned-no-result")
        exception = response.get("exceptionDetails")
        if isinstance(exception, dict):
            raise _PreviewError(str(exception.get("text") or "headless preview evaluation failed"))
        value = result.get("value")
        if not isinstance(value, dict):
            raise _PreviewError("headless-preview-returned-invalid-value")
        return value


class _UnityResolver:
    """Resolve only the Unity records needed by the Spine graph.

    The canonical object archives can be large.  Keep a small deterministic LRU
    over serialized files instead of materializing the complete Unity database
    in memory.
    """

    def __init__(self, layout: Any, index: dict[str, Any]):
        self.layout = layout
        self.index = index
        self.store = UnityObjectStore(layout, index)
        self.serialized_files = index.get("serializedFiles", {})
        self.records_cache: OrderedDict[str, dict[str, dict[str, Any]]] = OrderedDict()
        self.outputs_by_object: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self.outputs_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.source_paths_by_serialized_file: dict[str, list[str]] = defaultdict(list)
        self.external_pointer_candidates: dict[tuple[str, str], set[str]] = defaultdict(set)
        self.external_pointer_owners_indexed: set[str] = set()
        sources = index.get("sources", {})
        if not isinstance(sources, dict):
            raise ValueError("canonical Unity source index has no sources object")
        for source_path, source in sources.items():
            if not isinstance(source_path, str) or not isinstance(source, dict):
                continue
            serialized_file = str(source.get("serializedFile") or "")
            if serialized_file:
                self.source_paths_by_serialized_file[serialized_file].append(source_path)
            for output in source.get("outputs", []):
                if not isinstance(output, dict):
                    continue
                serialized_file = str(output.get("serializedFile") or "")
                object_id = _int_string(output.get("objectId"))
                output_path = str(output.get("path") or "")
                if not serialized_file or not object_id or not output_path:
                    continue
                value = {"sourcePath": source_path, **output}
                self.outputs_by_object[(serialized_file, object_id)].append(value)
                self.outputs_by_source[source_path].append(value)

    def _index_external_pointers(self, owner_serialized_file: str) -> None:
        """Recover PPtrs whose Unity archive record omits ``reference``.

        A Material frequently stores an external Texture2D as only
        ``m_FileID/m_PathID``.  The canonical source descriptor retains the
        resolved target in ``preloadObjectReferences``; use that evidence rather
        than inferring a texture from a neighboring filename.
        """

        if owner_serialized_file in self.external_pointer_owners_indexed:
            return
        self.external_pointer_owners_indexed.add(owner_serialized_file)
        sources = self.index.get("sources", {})
        for source_path in self.source_paths_by_serialized_file.get(owner_serialized_file, []):
            source = sources.get(source_path) if isinstance(sources, dict) else None
            descriptor_path = str(source.get("descriptor") or "") if isinstance(source, dict) else ""
            if not descriptor_path:
                continue
            descriptor_file = self.layout.metadata / descriptor_path
            if not descriptor_file.is_file():
                continue
            descriptor = read_json(descriptor_file)
            references = descriptor.get("preloadObjectReferences", []) if isinstance(descriptor, dict) else []
            if not isinstance(references, list):
                continue
            for reference in references:
                if not isinstance(reference, dict):
                    continue
                target_serialized_file = str(reference.get("serializedFile") or "")
                path_id = _int_string(reference.get("pathId"))
                if target_serialized_file and target_serialized_file != owner_serialized_file and path_id:
                    self.external_pointer_candidates[(owner_serialized_file, path_id)].add(target_serialized_file)

    def resolve_pointer(self, value: Any, owner_serialized_file: str) -> tuple[str, str] | None:
        direct = _pointer_identity(value, owner_serialized_file)
        if direct is not None:
            return direct
        if not isinstance(value, dict) or _integer(value.get("m_FileID")) == 0:
            return None
        path_id = _int_string(value.get("m_PathID"))
        if not path_id:
            return None
        self._index_external_pointers(owner_serialized_file)
        targets = self.external_pointer_candidates.get((owner_serialized_file, path_id), set())
        if len(targets) != 1:
            return None
        return next(iter(targets)), path_id

    def record(self, identity: tuple[str, str]) -> dict[str, Any] | None:
        serialized_file, object_id = identity
        records = self.records_cache.get(serialized_file)
        if records is None:
            owner = self.serialized_files.get(serialized_file)
            if not isinstance(owner, dict):
                return None
            digest = str(owner.get("bundleSha256") or "")
            if not digest:
                return None
            records = self.store.records(digest, serialized_file)
            self.records_cache[serialized_file] = records
            while len(self.records_cache) > 12:
                self.records_cache.popitem(last=False)
        else:
            self.records_cache.move_to_end(serialized_file)
        return records.get(object_id)

    def output(self, identity: tuple[str, str]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
        candidates = self.outputs_by_object.get(identity, [])
        if not candidates:
            return None, [_reason("media-output-missing", f"no media output for {identity[0]}:{identity[1]}")]
        paths = {str(candidate.get("path") or "") for candidate in candidates}
        if len(paths) != 1:
            return None, [
                _reason(
                    "media-output-ambiguous",
                    f"multiple media output paths for {identity[0]}:{identity[1]}",
                )
            ]
        output = sorted(candidates, key=lambda candidate: (str(candidate.get("role") or ""), str(candidate.get("type") or "")))[0]
        output_path = str(output.get("path") or "")
        if not (self.layout.root / Path(*PurePosixPath(output_path).parts)).is_file():
            return None, [_reason("media-output-absent", f"materialized output is absent: {output_path}")]
        return output, []

    def source_output(self, source_path: str) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
        candidates = self.outputs_by_source.get(source_path, [])
        if not candidates:
            return None, [_reason("media-output-missing", f"no media output for source {source_path}")]
        paths = {str(candidate.get("path") or "") for candidate in candidates}
        if len(paths) != 1:
            return None, [
                _reason("media-output-ambiguous", f"multiple media output paths for source {source_path}")
            ]
        return self.output((str(candidates[0]["serializedFile"]), _int_string(candidates[0]["objectId"])))


def _output_document(server: str, output: dict[str, Any]) -> dict[str, Any]:
    path = str(output["path"])
    value = {
        "path": path,
        "bytes": int(output.get("bytes") or 0),
        "sha256": str(output.get("sha256") or ""),
        "type": str(output.get("type") or ""),
    }
    source_path = str(output.get("sourcePath") or "")
    if source_path:
        value["sourcePath"] = source_path
    dependency = output.get("spineDependency")
    if isinstance(dependency, dict):
        value["spineDependency"] = dependency
    url = _release_url(server, path)
    if url:
        value["url"] = url
    return value


def _material_texture_pointer(
    resolver: _UnityResolver, record: dict[str, Any], serialized_file: str
) -> tuple[str, str] | None:
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict):
        return None
    properties = data.get("m_SavedProperties")
    if not isinstance(properties, dict):
        return None
    environments = properties.get("m_TexEnvs")
    if not isinstance(environments, list):
        return None
    pointers: list[tuple[str, str]] = []
    for item in environments:
        if not isinstance(item, list) or len(item) != 2 or not isinstance(item[1], dict):
            continue
        pointer = resolver.resolve_pointer(item[1].get("m_Texture"), serialized_file)
        if pointer and pointer not in pointers:
            pointers.append(pointer)
    return pointers[0] if len(pointers) == 1 else None


def _atlas_document(
    server: str,
    resolver: _UnityResolver,
    identity: tuple[str, str],
) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Resolve one SpineAtlasAsset through its original Material reference."""

    record = resolver.record(identity)
    if not isinstance(record, dict):
        return None, [_reason("atlas-asset-unresolved", f"cannot resolve atlas asset {identity[0]}:{identity[1]}")]
    data = record.get("data")
    if not isinstance(data, dict):
        return None, [_reason("atlas-asset-invalid", f"atlas asset has no serialized data: {identity[0]}:{identity[1]}")]
    atlas_pointer = resolver.resolve_pointer(data.get("atlasFile"), identity[0])
    if not atlas_pointer:
        return None, [_reason("atlas-file-pointer-unresolved", f"atlas asset has no resolvable atlas file: {identity[0]}:{identity[1]}")]
    atlas_output, reasons = resolver.output(atlas_pointer)
    if atlas_output is None:
        return None, reasons
    atlas_path = str(atlas_output["path"])
    try:
        text = (resolver.layout.root / Path(*PurePosixPath(atlas_path).parts)).read_text("utf-8")
    except UnicodeDecodeError:
        return None, [_reason("atlas-file-not-text", f"atlas is not UTF-8 text: {atlas_path}")]
    pages = _atlas_pages(text)
    if not pages:
        return None, [_reason("atlas-page-missing", f"atlas has no page declarations: {atlas_path}")]

    material_pointers = [
        pointer
        for value in data.get("materials", [])
        if (pointer := resolver.resolve_pointer(value, identity[0])) is not None
    ]
    if len(material_pointers) != len(pages):
        return None, [
            _reason(
                "atlas-material-count-mismatch",
                f"atlas pages/materials diverge: {atlas_path}: {len(pages)}/{len(material_pointers)}",
            )
        ]

    page_documents: list[dict[str, Any]] = []
    for page_name, material_pointer in zip(pages, material_pointers):
        material = resolver.record(material_pointer)
        texture_pointer = _material_texture_pointer(resolver, material or {}, material_pointer[0])
        if not texture_pointer:
            return None, [
                _reason(
                    "atlas-texture-pointer-unresolved",
                    f"atlas material has no single texture: {material_pointer[0]}:{material_pointer[1]}",
                )
            ]
        texture_output, texture_reasons = resolver.output(texture_pointer)
        if texture_output is None:
            return None, texture_reasons
        try:
            normalized_page_name = normalize_release_path(page_name)
        except ValueError:
            return None, [_reason("atlas-page-path-invalid", f"atlas page path is invalid: {page_name}")]
        atlas_source = str(atlas_output.get("sourcePath") or "")
        texture_source = str(texture_output.get("sourcePath") or "")
        if atlas_source and texture_source:
            try:
                expected_source = validate_unity_path(
                    (PurePosixPath(atlas_source).parent / PurePosixPath(normalized_page_name)).as_posix()
                )
            except ValueError:
                return None, [_reason("atlas-page-path-invalid", f"atlas page path is invalid: {page_name}")]
        else:
            expected_source = ""
        if expected_source and texture_source != expected_source:
            return None, [
                _reason(
                    "atlas-page-texture-mismatch",
                    f"atlas page {page_name!r} resolves to {expected_source}, not {texture_output.get('sourcePath')}",
                )
            ]
        if not texture_source and not isinstance(texture_output.get("spineDependency"), dict):
            return None, [
                _reason(
                    "atlas-page-provenance-missing",
                    f"atlas page {page_name!r} has neither a Unity source path nor a Spine dependency record",
                )
            ]
        page_documents.append(
            {"name": normalized_page_name, **_output_document(server, texture_output)}
        )

    return {
        "asset": {
            "serializedFile": identity[0],
            "objectId": identity[1],
            "name": str(data.get("m_Name") or ""),
        },
        "atlas": _output_document(server, atlas_output),
        "pages": page_documents,
    }, []


def _candidate_paths(index: dict[str, Any]) -> list[str]:
    sources = index.get("sources", {})
    if not isinstance(sources, dict):
        return []
    candidates = []
    for source_path, source in sources.items():
        if not isinstance(source_path, str) or not isinstance(source, dict):
            continue
        root_types = source.get("rootTypes")
        if not isinstance(root_types, list) or "MonoBehaviour" not in root_types:
            continue
        lowered = source_path.casefold()
        if "skeletondata" in lowered or "/spine/" in lowered:
            candidates.append(source_path)
    return sorted(candidates)


def _is_skeleton_data(record: dict[str, Any]) -> bool:
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict):
        return False
    script = data.get("m_Script")
    reference = script.get("reference") if isinstance(script, dict) else None
    script_name = str(reference.get("name") or "") if isinstance(reference, dict) else ""
    return script_name == "SkeletonDataAsset" or (
        isinstance(data.get("skeletonJSON"), dict) and isinstance(data.get("atlasAssets"), list)
    )


def _preview_document(
    model: dict[str, Any], reason: dict[str, str] | None = None
) -> dict[str, Any]:
    """Describe an honest unavailable preview without inventing a portrait."""

    fallback = None
    atlases = model.get("atlases")
    if isinstance(atlases, list) and atlases and isinstance(atlases[0], dict):
        pages = atlases[0].get("pages")
        if isinstance(pages, list) and pages and isinstance(pages[0], dict):
            page = pages[0]
            fallback = {
                "kind": "source-atlas-page",
                "sourcePath": page.get("sourcePath"),
                "path": page.get("path"),
                "url": page.get("url"),
                "note": "Raw atlas page only; it is not a rendered character or avatar portrait.",
            }
    value: dict[str, Any] = {
        "status": "unavailable",
        "reason": reason
        or _reason(
            PREVIEW_UNAVAILABLE_REASON,
            "The pipeline has no provisioned headless WebGL Spine renderer. No synthetic portrait is emitted.",
        ),
    }
    if fallback:
        value["fallback"] = fallback
    return value


def _setup_pose_metadata(facing: str | None = None) -> dict[str, Any]:
    """Describe the one non-animated pose used by every generated preview.

    Keep this in the emitted manifest rather than relying on renderer naming:
    a consumer must be able to distinguish a genuine initial setup pose from a
    screenshot taken from an idle animation.
    """

    metadata: dict[str, Any] = {
        "kind": PREVIEW_POSE_KIND,
        "animationApplied": False,
        "animationStateAdvanced": False,
        "physics": "none",
    }
    if facing == "front":
        metadata["facing"] = "front"
    return metadata


def _setup_skin_name(model: dict[str, Any]) -> str | None:
    """Choose an authored static skin without falling back to an animation.

    Spine only automatically consults a skin named ``default``.  The game
    assets commonly use a single skin named ``skin`` instead, so a bare
    ``Skeleton`` resolves every setup slot to ``None`` and renders no bounds.
    Prefer that conventional concrete skin, then ``default`` or an unambiguous
    lone skin.  Leave multi-skin assets without either conventional name to
    Spine's native default rather than guessing a cosmetic/expression variant.
    """

    raw_skins = model.get("skins")
    if not isinstance(raw_skins, list):
        return None
    skins = sorted({str(value) for value in raw_skins if isinstance(value, str) and value})
    if "skin" in skins:
        return "skin"
    if "default" in skins:
        return "default"
    return skins[0] if len(skins) == 1 else None


def _preview_component(
    model: dict[str, Any], order: int = 0
) -> dict[str, Any] | None:
    runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
    atlases = model.get("atlases") if isinstance(model.get("atlases"), list) else []
    if runtime.get("status") != "ready" or len(atlases) != 1:
        return None
    skeleton = runtime.get("json")
    atlas = atlases[0].get("atlas") if isinstance(atlases[0], dict) else None
    pages = atlases[0].get("pages") if isinstance(atlases[0], dict) else None
    if (
        not isinstance(skeleton, dict)
        or not isinstance(skeleton.get("path"), str)
        or not isinstance(atlas, dict)
        or not isinstance(atlas.get("path"), str)
        or not isinstance(pages, list)
        or not pages
        or any(not isinstance(page, dict) or not isinstance(page.get("path"), str) for page in pages)
    ):
        return None
    component = {
        "json": {"path": str(skeleton["path"])},
        "atlas": {"path": str(atlas["path"])},
        "pages": [
            {"name": str(page.get("name") or ""), "path": str(page["path"])}
            for page in pages
        ],
        "scale": _positive_number(runtime.get("scale"), 0.01),
        "pose": PREVIEW_POSE_KIND,
        "order": order,
    }
    setup_skin = _setup_skin_name(model)
    if setup_skin:
        component["skin"] = setup_skin
    preview_policy = model.get("previewPolicy")
    if isinstance(preview_policy, dict):
        if preview_policy.get("facing") == "front":
            component["facing"] = "front"
        hidden_slots = preview_policy.get("hiddenSetupSlots")
        if isinstance(hidden_slots, list):
            component["hiddenSlots"] = sorted(
                {str(slot) for slot in hidden_slots if isinstance(slot, str) and slot}
            )
    return component


def _model_preview_job(model: dict[str, Any]) -> dict[str, Any] | None:
    component = _preview_component(model)
    if component is None:
        return None
    job: dict[str, Any] = {
        "id": str(model["id"]),
        "kind": "model",
        "components": [component],
        "scale": 1,
        "width": PREVIEW_WIDTH,
        "height": PREVIEW_HEIGHT,
    }
    if component.get("facing") == "front":
        job["facing"] = "front"
    return job


def _recipe_preview_job(
    recipe: dict[str, Any], models_by_id: dict[str, dict[str, Any]]
) -> dict[str, Any] | None:
    parts = recipe.get("parts") if isinstance(recipe.get("parts"), list) else []
    components: list[dict[str, Any]] = []
    for part in parts:
        if not isinstance(part, dict):
            return None
        model = models_by_id.get(str(part.get("modelId") or ""))
        if not isinstance(model, dict):
            return None
        component = _preview_component(model, _integer(part.get("order")))
        if component is None:
            return None
        components.append(component)
    if not components:
        return None
    job: dict[str, Any] = {
        "id": str(recipe["id"]),
        "kind": "recipe",
        "components": components,
        "scale": _positive_number(recipe.get("scale"), 1),
        "width": PREVIEW_WIDTH,
        "height": PREVIEW_HEIGHT,
    }
    if all(component.get("facing") == "front" for component in components):
        job["facing"] = "front"
    return job


def _clear_spine_preview_outputs(layout: Any) -> None:
    """Remove only this builder's stale outputs before deriving a new manifest."""

    root = layout.runtime / "spine-previews"
    if not root.exists():
        return
    if not root.is_dir() or root.resolve().parent != layout.runtime.resolve():
        raise ValueError(f"invalid Spine preview output root: {root}")
    for file in sorted((value for value in root.rglob("*") if value.is_file()), reverse=True):
        file.unlink()
    for directory in sorted((value for value in root.rglob("*") if value.is_dir()), reverse=True):
        directory.rmdir()
    root.rmdir()


def _png_dimensions(payload: bytes) -> tuple[int, int]:
    """Read the authoritative dimensions from an unmodified renderer PNG.

    The preview output must remain byte-for-byte identical to the browser
    canvas.  Reading the PNG's IHDR header gives us manifest dimensions
    without putting it through an image decoder/re-encoder (which can change
    transparent edge pixels).
    """

    signature = b"\x89PNG\r\n\x1a\n"
    if (
        not payload.startswith(signature)
        or len(payload) < 24
        or payload[8:12] != b"\x00\x00\x00\r"
        or payload[12:16] != b"IHDR"
    ):
        raise _PreviewError("headless-preview-returned-invalid-png")
    width, height = struct.unpack("!II", payload[16:24])
    if width <= 0 or height <= 0:
        raise _PreviewError("headless-preview-returned-invalid-png")
    return width, height


def _preview_output(
    config: ServerConfig,
    layout: Any,
    job: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    value = str(result.get("png") or "")
    prefix = "data:image/png;base64,"
    if not value.startswith(prefix):
        raise _PreviewError("headless-preview-returned-non-png-data")
    try:
        payload = base64.b64decode(value.removeprefix(prefix), validate=True)
    except ValueError as error:
        raise _PreviewError("headless-preview-returned-invalid-base64") from error
    width, height = _png_dimensions(payload)
    kind = str(job.get("kind") or "")
    identifier = str(job.get("id") or "")
    if kind not in {"model", "recipe"} or not identifier:
        raise _PreviewError("headless-preview-job-identity-invalid")
    relative = f"{PREVIEW_OUTPUT_PREFIX}/{kind}s/{identifier}.png"
    if normalize_release_path(relative) != relative:
        raise _PreviewError("headless-preview-output-path-invalid")
    output = layout.root / Path(*PurePosixPath(relative).parts)
    visible_pixel_count = _integer(result.get("visiblePixelCount"))
    if visible_pixel_count <= 0:
        raise _PreviewError("headless-preview-returned-empty-image")
    # Do not decode, alpha-crop, resize, or re-encode the browser's PNG. The
    # fixed transparent canvas is part of the renderer result: it preserves
    # all authored geometry and lets consumers compose its antialiased edge
    # alpha exactly as WebGL emitted it.
    atomic_write(output, payload)
    return {
        "status": "rendered",
        "schema": PREVIEW_SCHEMA,
        "renderer": PREVIEW_RENDERER,
        "runtime": {
            "package": BROWSER_RUNTIME_PACKAGE,
            "packageVersion": BROWSER_RUNTIME_VERSION,
            "runtimeSeries": BROWSER_RUNTIME_SERIES,
        },
        "pose": _setup_pose_metadata(str(job.get("facing") or "")),
        "path": relative,
        "url": _release_url(config.id, relative),
        "bytes": output.stat().st_size,
        "sha256": sha256_file(output),
        "width": width,
        "height": height,
        "visiblePixelCount": visible_pixel_count,
        "composition": "layered-spine" if kind == "recipe" else "single-spine",
    }


def _renderer_failure_reason(error: Exception) -> dict[str, str]:
    detail = str(error).strip() or type(error).__name__
    if ": " in detail:
        code, message = detail.split(": ", 1)
        if code and all(char.islower() or char.isdigit() or char == "-" for char in code):
            return _preview_reason(code, message)
    return _preview_reason("headless-webgl-renderer-error", detail)


def _model_runtime_preview_reason(model: dict[str, Any]) -> dict[str, str]:
    runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
    reasons = runtime.get("reasons") if isinstance(runtime.get("reasons"), list) else []
    detail = str(reasons[0].get("detail") or "") if reasons and isinstance(reasons[0], dict) else "model runtime is unavailable"
    return _preview_reason("model-runtime-unavailable", detail)


def _resource_route_key(value: Any, field: str) -> str:
    """Validate a directly published game-resource key for catalog routing.

    This intentionally does not slugify.  A lossy path/name conversion makes
    a route look meaningful while no longer being a key that exists in the
    game data.  If a future Unity resource key is not URL-safe, fail at build
    time so the transport representation can be designed explicitly.
    """

    key = str(value or "").strip()
    if _ROUTE_KEY.fullmatch(key) is None:
        raise ValueError(f"Spine {field} is not a URL-safe game resource key: {value!r}")
    return key


def _spine_resource_model_id(resource_key: Any) -> str:
    """Return the public ID from the raw Unity ``SkeletonDataAsset.m_Name``.

    ``m_Name`` is a real Unity resource-object key, not the asset path or a
    localized display name.  The only transformation removes the structural
    ``_SkeletonData`` type suffix, e.g. the real key
    ``fashion0002_body_1_SkeletonData`` becomes ``fashion0002_body_1``.
    """

    raw = _resource_route_key(resource_key, "SkeletonDataAsset.m_Name")
    identifier = _SKELETON_DATA_RESOURCE_SUFFIX.sub("", raw)
    if not identifier:
        raise ValueError(f"Spine SkeletonDataAsset.m_Name has no resource key: {resource_key!r}")
    return _resource_route_key(identifier, "SkeletonDataAsset resource key")


def _model_resource_key(model: dict[str, Any]) -> str:
    """Read the exact raw Unity object key retained on a model document."""

    raw = model.get("resourceKey")
    if isinstance(raw, str) and raw:
        return _resource_route_key(raw, "model resourceKey")
    asset = model.get("asset")
    if isinstance(asset, dict):
        return _resource_route_key(asset.get("name"), "SkeletonDataAsset.m_Name")
    raise ValueError("Spine model has no Unity SkeletonDataAsset resource key")


def _model_serialized_file_key(model: dict[str, Any]) -> str:
    """Read the native Unity CAB identifier used only for a name collision."""

    asset = model.get("asset")
    return _resource_route_key(
        asset.get("serializedFile") if isinstance(asset, dict) else None,
        "SkeletonDataAsset serializedFile",
    )


def _model_spine_hash_key(model: dict[str, Any]) -> str:
    """Encode the raw Spine skeleton hash in its standard URL-safe spelling."""

    skeleton = model.get("skeleton")
    raw = str(skeleton.get("hash") or "") if isinstance(skeleton, dict) else ""
    if _SPINE_HASH.fullmatch(raw) is None:
        raise ValueError(f"Spine Skeleton JSON hash is not a usable resource key: {raw!r}")
    # Spine serializes this value as unpadded standard Base64.  Base64url
    # changes only its transport spelling (``+``/``/`` -> ``-``/``_``), while
    # the unmodified raw value remains in ``skeleton.hash`` for provenance.
    return _resource_route_key(
        raw.rstrip("=").replace("+", "-").replace("/", "_"),
        "Spine skeleton hash",
    )


def _assign_resource_model_ids(models: list[dict[str, Any]]) -> None:
    """Assign IDs from real resource keys, resolving only native collisions.

    The ordinary identifier is the exact Unity ``m_Name`` minus its
    ``_SkeletonData`` type suffix.  Two objects can occasionally carry that
    same name in separate Unity CABs.  In that exceptional case, append the
    real ``serializedFile`` CAB identifier.  If they are in the same CAB,
    append the raw Spine JSON ``skeleton.hash`` (in Base64url transport
    spelling).  A remaining collision has no distinct resource-native key, so
    the build fails rather than inventing a source-path, counter, object ID,
    or generated digest.
    """

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for model in models:
        identity = _spine_resource_model_id(_model_resource_key(model))
        model["id"] = identity
        groups[identity].append(model)

    for identity, entries in groups.items():
        if len(entries) < 2:
            continue
        cab_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for model in entries:
            candidate = f"{identity}~{_model_serialized_file_key(model)}"
            _resource_route_key(candidate, "Spine model ID")
            cab_groups[candidate].append(model)
        for candidate, cab_entries in cab_groups.items():
            if len(cab_entries) == 1:
                cab_entries[0]["id"] = candidate
                continue
            hash_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for model in cab_entries:
                hash_candidate = f"{candidate}~{_model_spine_hash_key(model)}"
                _resource_route_key(hash_candidate, "Spine model ID")
                hash_groups[hash_candidate].append(model)
            collisions = {
                key: values for key, values in hash_groups.items() if len(values) > 1
            }
            if collisions:
                raise ValueError(
                    "Spine resource model IDs collide without distinct native "
                    f"keys: {identity}: {sorted(collisions)}"
                )
            for hash_candidate, hash_entries in hash_groups.items():
                hash_entries[0]["id"] = hash_candidate


def _recipe_runtime_preview_reason(recipe: dict[str, Any]) -> dict[str, str]:
    runtime = recipe.get("runtime") if isinstance(recipe.get("runtime"), dict) else {}
    reasons = runtime.get("reasons") if isinstance(runtime.get("reasons"), list) else []
    detail = str(reasons[0].get("detail") or "") if reasons and isinstance(reasons[0], dict) else "render recipe is unavailable"
    return _preview_reason("render-recipe-unavailable", detail)


def _render_previews(
    config: ServerConfig,
    layout: Any,
    models: list[dict[str, Any]],
    recipes: list[dict[str, Any]],
) -> tuple[int, int]:
    """Attempt real WebGL output, retaining an explicit failure for every miss."""

    _clear_spine_preview_outputs(layout)
    models_by_id = {str(model["id"]): model for model in models}
    model_jobs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    recipe_jobs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for model in models:
        if isinstance(model.get("runtime"), dict) and model["runtime"].get("status") == "ready":
            job = _model_preview_job(model)
            if job is not None:
                model_jobs.append((model, job))
                continue
        model["preview"] = _preview_document(model, _model_runtime_preview_reason(model))
    for recipe in recipes:
        if isinstance(recipe.get("runtime"), dict) and recipe["runtime"].get("status") == "ready":
            job = _recipe_preview_job(recipe, models_by_id)
            if job is not None:
                recipe_jobs.append((recipe, job))
                continue
        recipe["preview"] = {
            "status": "unavailable",
            "reason": _recipe_runtime_preview_reason(recipe),
        }
    environment_reason = _spine_preview_runtime_reason()
    if environment_reason is not None:
        for model, _ in model_jobs:
            model["preview"] = _preview_document(model, environment_reason)
        for recipe, _ in recipe_jobs:
            recipe["preview"] = {"status": "unavailable", "reason": environment_reason}
        return 0, 0

    rendered_models = 0
    rendered_recipes = 0
    pending: list[tuple[dict[str, Any], dict[str, Any], str]] = [
        *( (model, job, "model") for model, job in model_jobs ),
        *( (recipe, job, "recipe") for recipe, job in recipe_jobs ),
    ]
    try:
        with _SpinePreviewRenderer(layout) as renderer:
            for document, job, kind in pending:
                try:
                    outcome = renderer.render(job)
                    if outcome.get("ok") is not True:
                        code = str(outcome.get("code") or "headless-webgl-render-failed")
                        detail = str(outcome.get("detail") or "renderer returned an unsuccessful result")
                        raise _PreviewError(f"{code}: {detail}")
                    preview = _preview_output(config, layout, job, outcome)
                except Exception as error:
                    preview = {
                        "status": "unavailable",
                        "reason": _renderer_failure_reason(error),
                    }
                    if kind == "model":
                        preview = _preview_document(document, preview["reason"])
                document["preview"] = preview
                if preview.get("status") == "rendered":
                    if kind == "model":
                        rendered_models += 1
                    else:
                        rendered_recipes += 1
    except Exception as error:
        reason = _renderer_failure_reason(error)
        for document, _job, kind in pending:
            if document.get("preview", {}).get("status") == "rendered":
                continue
            document["preview"] = (
                _preview_document(document, reason)
                if kind == "model"
                else {"status": "unavailable", "reason": reason}
            )
    return rendered_models, rendered_recipes


def _model_document(
    config: ServerConfig,
    layout: Any,
    resolver: _UnityResolver,
    source_path: str,
    descriptor: dict[str, Any],
    record: dict[str, Any],
) -> dict[str, Any]:
    data = record["data"]
    object_id = _int_string(record.get("pathId"))
    serialized_file = str(record.get("serializedFile") or descriptor.get("serializedFile") or "")
    resource_key = _resource_route_key(data.get("m_Name"), "SkeletonDataAsset.m_Name")
    reasons: list[dict[str, str]] = []
    skeleton_pointer = resolver.resolve_pointer(data.get("skeletonJSON"), serialized_file)
    skeleton_output = None
    skeleton_json: dict[str, Any] | None = None
    skeleton_format = "unknown"
    if not skeleton_pointer:
        reasons.append(_reason("skeleton-json-pointer-unresolved", f"no skeleton JSON pointer: {source_path}"))
    else:
        skeleton_output, output_reasons = resolver.output(skeleton_pointer)
        reasons.extend(output_reasons)
    if skeleton_output is not None:
        skeleton_path = str(skeleton_output["path"])
        try:
            payload = (layout.root / Path(*PurePosixPath(skeleton_path).parts)).read_bytes()
            skeleton_json = json.loads(payload.decode("utf-8"))
            if not isinstance(skeleton_json, dict) or not isinstance(skeleton_json.get("skeleton"), dict):
                raise ValueError("missing skeleton object")
            skeleton_format = "json"
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            # The native pipeline may contain binary skeletons.  Preserve their
            # runtime path, but never claim that an unparsed binary is browser-ready.
            skeleton_format = "binary"
            reasons.append(_reason("skeleton-json-invalid", f"cannot parse Spine JSON {skeleton_path}: {error}"))

    atlases: list[dict[str, Any]] = []
    atlas_pointers = [
        pointer
        for value in data.get("atlasAssets", [])
        if (pointer := resolver.resolve_pointer(value, serialized_file)) is not None
    ]
    if not atlas_pointers:
        reasons.append(_reason("atlas-assets-missing", f"no AtlasAsset pointer: {source_path}"))
    for atlas_pointer in atlas_pointers:
        atlas, atlas_reasons = _atlas_document(config.id, resolver, atlas_pointer)
        reasons.extend(atlas_reasons)
        if atlas is not None:
            atlases.append(atlas)

    skeleton_meta = skeleton_json.get("skeleton", {}) if isinstance(skeleton_json, dict) else {}
    spine_version = str(skeleton_meta.get("spine") or "") if isinstance(skeleton_meta, dict) else ""
    series = _spine_series(spine_version)
    if skeleton_format == "json" and series != BROWSER_RUNTIME_SERIES:
        reasons.append(
            _reason(
                "spine-runtime-series-mismatch",
                f"asset uses Spine {spine_version or 'unknown'}; browser runtime series is {BROWSER_RUNTIME_SERIES}",
            )
        )
    if len(atlas_pointers) != 1:
        reasons.append(
            _reason(
                "multiple-atlases-require-composition",
                f"model has {len(atlas_pointers)} atlas assets; generic single-atlas loader cannot claim playback",
            )
        )
    if len(atlases) != len(atlas_pointers):
        reasons.append(
            _reason(
                "atlas-resolution-incomplete",
                f"resolved {len(atlases)} of {len(atlas_pointers)} atlas assets",
            )
        )

    animations = (
        sorted(str(key) for key in skeleton_json.get("animations", {}) if str(key))
        if isinstance(skeleton_json, dict) and isinstance(skeleton_json.get("animations"), dict)
        else []
    )
    skins = _skin_names(skeleton_json.get("skins")) if isinstance(skeleton_json, dict) else []
    family = (
        "anon-tokyo"
        if source_path.startswith("Assets/AddressableResources/AnonTokyo/")
        else "home-spot"
        if "/Spot/" in source_path and "/Spine/" in source_path
        else "other"
    )
    preview_policy = (
        _anon_tokyo_front_preview_policy(skeleton_json) if family == "anon-tokyo" else None
    )
    ready = not reasons and skeleton_output is not None and len(atlases) == 1 and skeleton_format == "json"
    runtime: dict[str, Any] = {
        "status": "ready" if ready else "unavailable",
        "verification": "source-graph-and-JSON-structure",
        "package": BROWSER_RUNTIME_PACKAGE,
        "packageVersion": BROWSER_RUNTIME_VERSION,
        "runtimeSeries": BROWSER_RUNTIME_SERIES,
        "loader": BROWSER_LOADER,
        "format": skeleton_format,
        "scale": _positive_number(data.get("scale"), 0.01),
    }
    if skeleton_output is not None:
        runtime["json"] = _output_document(config.id, skeleton_output)
    if len(atlases) == 1:
        runtime["atlas"] = atlases[0]["atlas"]
    if reasons:
        runtime["reasons"] = reasons

    model = {
        "id": _spine_resource_model_id(resource_key),
        # This is the literal Unity ``SkeletonDataAsset.m_Name`` read above.
        # Keep it alongside the shortened route ID so consumers can verify the
        # ID originates in the game resource graph rather than in a display
        # label or source path.
        "resourceKey": resource_key,
        # Retain the previous opaque route key only for one-way deep-link
        # migration.  It is not used to order, label, or identify new models.
        "sourcePath": source_path,
        "asset": {
            "serializedFile": serialized_file,
            "objectId": object_id,
            "name": resource_key,
            "selectedBundle": str(descriptor.get("selectedBundle") or ""),
        },
        "family": family,
        "skeleton": {
            "sourcePath": source_path,
            "format": skeleton_format,
            "spineVersion": spine_version or None,
            "hash": str(skeleton_meta.get("hash") or "") if isinstance(skeleton_meta, dict) else "",
            "bounds": {
                "x": _number(skeleton_meta.get("x")) if isinstance(skeleton_meta, dict) else 0,
                "y": _number(skeleton_meta.get("y")) if isinstance(skeleton_meta, dict) else 0,
                "width": _number(skeleton_meta.get("width")) if isinstance(skeleton_meta, dict) else 0,
                "height": _number(skeleton_meta.get("height")) if isinstance(skeleton_meta, dict) else 0,
            },
            **({"runtime": _output_document(config.id, skeleton_output)} if skeleton_output is not None else {}),
        },
        "atlases": atlases,
        "animations": animations,
        "skins": skins,
        "defaultMix": _number(data.get("defaultMix")),
        "runtime": runtime,
        **({"previewPolicy": preview_policy} if preview_policy is not None else {}),
    }
    model["preview"] = _preview_document(model)
    return model


def _anon_tokyo_source_key(path_name: Any) -> str | None:
    path = str(path_name or "").strip()
    if not path:
        return None
    try:
        return validate_unity_path(f"Assets/AddressableResources/{path}.asset")
    except ValueError:
        return None


def _anon_tokyo_recipes(layout: Any, models: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Build only the documented default Avatar -> Reloading -> parts recipes."""

    characters = _rows(layout.master / "MasterATCharacter.json")
    reloading = _rows(layout.master / "MasterATReloading.json")
    replacement_parts = _rows(layout.master / "MasterATReplacementparts.json")
    if not characters or not reloading or not replacement_parts:
        return [], {
            "status": "absent",
            "reason": "Anon Tokyo Master tables are not present in this build.",
        }
    reloading_by_id = {_integer(row.get("_id")): row for row in reloading if _integer(row.get("_id"))}
    parts_by_id = {_integer(row.get("_id")): row for row in replacement_parts if _integer(row.get("_id"))}
    models_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for model in models:
        source_path = str(model.get("sourcePath") or "")
        if source_path:
            models_by_source[source_path].append(model)

    def resolve_default_part(replacement_id: int, reloading_id: int) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        part = parts_by_id.get(replacement_id)
        if part is None:
            return None, _reason("replacement-part-missing", f"MasterATReplacementparts id {replacement_id} is absent")
        source_path = _anon_tokyo_source_key(part.get("_pathName"))
        candidates = models_by_source.get(source_path or "", [])
        if len(candidates) != 1:
            return None, _reason(
                "replacement-model-unresolved",
                f"replacement part {replacement_id} maps to {source_path or 'an invalid source path'} ({len(candidates)} models)",
            )
        model = candidates[0]
        model_runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
        if model_runtime.get("status") != "ready":
            return None, _reason(
                "replacement-model-unavailable",
                f"replacement part {replacement_id} model is not browser-ready",
            )
        if DEFAULT_ANON_TOKYO_ANIMATION not in model.get("animations", []):
            return None, _reason(
                "default-animation-missing",
                f"replacement part {replacement_id} does not provide {DEFAULT_ANON_TOKYO_ANIMATION}",
            )
        runtime = model_runtime.get("json") if isinstance(model_runtime.get("json"), dict) else None
        return (
            {
                "replacementPartId": replacement_id,
                "reloadingId": reloading_id,
                "order": _integer(part.get("_order")),
                "pathName": str(part.get("_pathName") or ""),
                "sourcePath": source_path,
                "modelId": model.get("id"),
                **({"runtime": runtime} if runtime else {}),
            },
            None,
        )

    recipes: list[dict[str, Any]] = []
    for character in sorted(characters, key=lambda row: _integer(row.get("_id"))):
        character_id = _integer(character.get("_id"))
        if not character_id:
            continue
        avatar_ids = [
            _integer(value)
            for value in character.get("_defaultAvatar", [])
            if _integer(value)
        ]
        reasons: list[dict[str, str]] = []
        parts: list[dict[str, Any]] = []
        # An avatar bundle does not always carry the whole head (Uika's points
        # at her hat only), so the per-slot character defaults fill whatever
        # the bundles leave uncovered.
        default_slot_parts: dict[str, int] = {}
        for field in ("_defaultBrow", "_defaultFace", "_defaultHair1", "_defaultHair2", "_defaultHair3"):
            for value in character.get(field, []):
                replacement_id = _integer(value)
                if replacement_id and replacement_id in parts_by_id:
                    part = parts_by_id[replacement_id]
                    slot = _anon_tokyo_part_slot(str(part.get("_pathName") or ""))
                    if slot:
                        default_slot_parts.setdefault(slot, replacement_id)
        for reloading_id in avatar_ids:
            value = reloading_by_id.get(reloading_id)
            if value is None:
                reasons.append(_reason("reloading-missing", f"MasterATReloading id {reloading_id} is absent"))
                continue
            for replacement_id_value in value.get("_spineparent", []):
                replacement_id = _integer(replacement_id_value)
                part = parts_by_id.get(replacement_id)
                if part is None:
                    reasons.append(
                        _reason(
                            "replacement-part-missing",
                            f"MasterATReplacementparts id {replacement_id} is absent",
                        )
                    )
                    continue
                source_path = _anon_tokyo_source_key(part.get("_pathName"))
                candidates = models_by_source.get(source_path or "", [])
                if len(candidates) != 1:
                    reasons.append(
                        _reason(
                            "replacement-model-unresolved",
                            f"replacement part {replacement_id} maps to {source_path or 'an invalid source path'} ({len(candidates)} models)",
                        )
                    )
                    continue
                model = candidates[0]
                model_runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
                if model_runtime.get("status") != "ready":
                    reasons.append(
                        _reason(
                            "replacement-model-unavailable",
                            f"replacement part {replacement_id} model is not browser-ready",
                        )
                    )
                if DEFAULT_ANON_TOKYO_ANIMATION not in model.get("animations", []):
                    reasons.append(
                        _reason(
                            "default-animation-missing",
                            f"replacement part {replacement_id} does not provide {DEFAULT_ANON_TOKYO_ANIMATION}",
                        )
                    )
                runtime = model_runtime.get("json") if isinstance(model_runtime.get("json"), dict) else None
                parts.append(
                    {
                        "replacementPartId": replacement_id,
                        "reloadingId": reloading_id,
                        "order": _integer(part.get("_order")),
                        "pathName": str(part.get("_pathName") or ""),
                        "sourcePath": source_path,
                        "modelId": model.get("id"),
                        **({"runtime": runtime} if runtime else {}),
                    }
                )
        covered = set()
        for part in parts:
            slot = _anon_tokyo_part_slot(str(part.get("pathName") or ""))
            if slot:
                covered.add(slot)
        for slot, replacement_id in sorted(default_slot_parts.items()):
            if slot in covered:
                continue
            part, part_reason = resolve_default_part(replacement_id, next(iter(avatar_ids), 0))
            if part is None:
                reasons.append(part_reason)
                continue
            parts.append(part)
            covered.add(slot)
        parts.sort(key=lambda value: (int(value["order"]), int(value["replacementPartId"])))
        ready = bool(parts) and not reasons
        recipe = {
            "id": f"anon-tokyo-character-{character_id}-default",
            "feature": "anon-tokyo",
            "characterId": character_id,
            "avatarId": _integer(character.get("_avatarID")),
            "nameKey": str(character.get("_name") or ""),
            "defaultAvatarReloadingIds": avatar_ids,
            "scale": _positive_number(character.get("_scale"), 1.0),
            "animation": {"name": DEFAULT_ANON_TOKYO_ANIMATION, "loop": True},
            "parts": parts,
            "runtime": {
                "status": "ready" if ready else "unavailable",
                "renderer": "layered-spine-4.2",
                "sort": "ascending MasterATReplacementparts._order",
                "verification": "MasterATCharacter._defaultAvatar -> MasterATReloading._spineparent -> MasterATReplacementparts",
                "package": BROWSER_RUNTIME_PACKAGE,
                "runtimeSeries": BROWSER_RUNTIME_SERIES,
                **({"reasons": reasons} if reasons else {}),
            },
        }
        # A component atlas page can aid debugging but never represents the
        # complete avatar.  Keep the same non-deceptive preview contract as a
        # generic model.
        recipe["preview"] = {
            "status": "unavailable",
            "reason": _reason(
                PREVIEW_UNAVAILABLE_REASON,
                "No headless renderer assembled the layered Anon Tokyo character; no portrait is emitted.",
            ),
        }
        recipes.append(recipe)
    return recipes, {
        "status": "available",
        "relation": "MasterATCharacter._defaultAvatar -> MasterATReloading._spineparent -> MasterATReplacementparts",
        "defaultAnimation": DEFAULT_ANON_TOKYO_ANIMATION,
        "sort": "ascending MasterATReplacementparts._order",
    }


_ANON_TOKYO_OUTFIT_SLOTS = (
    "brow",
    "face",
    "hair_1",
    "hair_2",
    "hair_3",
    "body_1",
    "body_2",
    "waist_1",
    "waist_2",
    "waist_3",
    "foot_1",
    "foot_2",
    "hat_1",
)


def _anon_tokyo_part_slot(path_name: str) -> str | None:
    """MasterATReplacementparts paths end ``<family>_<slot>_SkeletonData``."""

    stem = PurePosixPath(str(path_name or "").strip()).name
    if stem.casefold().endswith("_skeletondata"):
        stem = stem[: -len("_skeletondata")]
    _family, separator, slot = stem.partition("_")
    if not separator or slot not in _ANON_TOKYO_OUTFIT_SLOTS:
        return None
    return slot


def _anon_tokyo_outfit_recipes(
    layout: Any,
    models: list[dict[str, Any]],
    default_recipes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Compose one render recipe per (character, wearable Reloading outfit).

    The default Avatar recipes remain authoritative for the resting look.  Any
    other MasterATReloading row that lists the character replaces the slots its
    MasterATReplacementparts cover and keeps the remaining default parts — the
    same layering the game performs with independently authored part skeletons.
    """

    reloading_rows = _rows(layout.master / "MasterATReloading.json")
    if not reloading_rows or not default_recipes:
        return []
    defaults_by_character = {
        _integer(recipe.get("characterId")): recipe
        for recipe in default_recipes
        if isinstance(recipe.get("runtime"), dict) and recipe["runtime"].get("status") == "ready"
    }
    if not defaults_by_character:
        return []
    parts_by_id = {
        _integer(row.get("_id")): row
        for row in _rows(layout.master / "MasterATReplacementparts.json")
        if _integer(row.get("_id"))
    }
    models_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for model in models:
        source_path = str(model.get("sourcePath") or "")
        if source_path:
            models_by_source[source_path].append(model)

    def resolve_part(replacement_id: int, reloading_id: int) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        part = parts_by_id.get(replacement_id)
        if part is None:
            return None, _reason(
                "replacement-part-missing",
                f"MasterATReplacementparts id {replacement_id} is absent",
            )
        source_path = _anon_tokyo_source_key(part.get("_pathName"))
        candidates = models_by_source.get(source_path or "", [])
        if len(candidates) != 1:
            return None, _reason(
                "replacement-model-unresolved",
                f"replacement part {replacement_id} maps to {source_path or 'an invalid source path'} ({len(candidates)} models)",
            )
        model = candidates[0]
        model_runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
        if model_runtime.get("status") != "ready":
            return None, _reason(
                "replacement-model-unavailable",
                f"replacement part {replacement_id} model is not browser-ready",
            )
        if DEFAULT_ANON_TOKYO_ANIMATION not in model.get("animations", []):
            return None, _reason(
                "default-animation-missing",
                f"replacement part {replacement_id} does not provide {DEFAULT_ANON_TOKYO_ANIMATION}",
            )
        runtime = model_runtime.get("json") if isinstance(model_runtime.get("json"), dict) else None
        return (
            {
                "replacementPartId": replacement_id,
                "reloadingId": reloading_id,
                "order": _integer(part.get("_order")),
                "pathName": str(part.get("_pathName") or ""),
                "sourcePath": source_path,
                "modelId": model.get("id"),
                **({"runtime": runtime} if runtime else {}),
            },
            None,
        )

    recipes: list[dict[str, Any]] = []
    all_character_ids = sorted(defaults_by_character)
    for row in sorted(reloading_rows, key=lambda value: _integer(value.get("_id"))):
        reloading_id = _integer(row.get("_id"))
        if not reloading_id or not row.get("_isShow"):
            # Hidden master rows are internal placeholder bundles, not outfits.
            continue
        wearers = sorted({_integer(value) for value in (row.get("_canUseChar") or []) if _integer(value)})
        if not wearers:
            # An empty wearer list is the master's "every character" encoding.
            wearers = all_character_ids
        for character_id in wearers:
            default = defaults_by_character.get(character_id)
            if default is None:
                continue
            if reloading_id in {_integer(value) for value in (default.get("defaultAvatarReloadingIds") or [])}:
                continue
            reasons: list[dict[str, str]] = []
            slots: dict[str, dict[str, Any]] = {}
            for replacement_id_value in (row.get("_spineparent") or []) + (row.get("_spineparentSpecial") or []):
                replacement_id = _integer(replacement_id_value)
                if not replacement_id:
                    continue
                part, part_reason = resolve_part(replacement_id, reloading_id)
                if part is None:
                    reasons.append(part_reason)
                    continue
                slot = _anon_tokyo_part_slot(str(part.get("pathName") or ""))
                if slot is None:
                    reasons.append(
                        _reason(
                            "outfit-slot-unknown",
                            f"replacement part {replacement_id} has no known outfit slot",
                        )
                    )
                    continue
                slots[slot] = part
            if not slots or reasons:
                continue
            merged: dict[str, dict[str, Any]] = {}
            for part in default.get("parts") or []:
                slot = _anon_tokyo_part_slot(str(part.get("pathName") or "")) or f"part-{part.get('replacementPartId')}"
                merged[slot] = part
            merged.update(slots)
            parts = sorted(
                merged.values(),
                key=lambda value: (int(value["order"]), int(value["replacementPartId"])),
            )
            recipes.append(
                {
                    "id": f"anon-tokyo-character-{character_id}-outfit-{reloading_id}",
                    "feature": "anon-tokyo",
                    "characterId": character_id,
                    "avatarId": default.get("avatarId"),
                    "nameKey": default.get("nameKey"),
                    "defaultAvatarReloadingIds": default.get("defaultAvatarReloadingIds"),
                    "outfitReloadingIds": [reloading_id],
                    "scale": default.get("scale"),
                    "animation": {"name": DEFAULT_ANON_TOKYO_ANIMATION, "loop": True},
                    "parts": parts,
                    "runtime": {
                        "status": "ready",
                        "renderer": "layered-spine-4.2",
                        "sort": "ascending MasterATReplacementparts._order",
                        "verification": "MasterATReloading._canUseChar -> MasterATReloading._spineparent -> MasterATReplacementparts over the default Avatar recipe",
                        "package": BROWSER_RUNTIME_PACKAGE,
                        "runtimeSeries": BROWSER_RUNTIME_SERIES,
                    },
                    # A component atlas page can aid debugging but never represents
                    # the complete avatar.  Keep the same non-deceptive preview
                    # contract as a generic model.
                    "preview": {
                        "status": "unavailable",
                        "reason": _reason(
                            PREVIEW_UNAVAILABLE_REASON,
                            "No headless renderer assembled the layered Anon Tokyo outfit; no portrait is emitted.",
                        ),
                    },
                }
            )
    return recipes


def _anon_tokyo_appearance_recipes(layout: Any, models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compose appearance recipes for customers, band customers and delivery staff.

    Each ``MasterAT*._defaultAvatar`` row already references complete Reloading
    bundles (an NPC head+clothes set, the character's own look, or a helper
    model), so one recipe per row renders the exact in-game appearance.
    """

    tables = (
        ("customer", "MasterATCustomer.json"),
        ("bd-customer", "MasterATBDCustomer.json"),
        ("delivery", "MasterATDelivery.json"),
    )
    parts_by_id = {
        _integer(row.get("_id")): row
        for row in _rows(layout.master / "MasterATReplacementparts.json")
        if _integer(row.get("_id"))
    }
    reloading_by_id = {
        _integer(row.get("_id")): row
        for row in _rows(layout.master / "MasterATReloading.json")
        if _integer(row.get("_id"))
    }
    models_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for model in models:
        source_path = str(model.get("sourcePath") or "")
        if source_path:
            models_by_source[source_path].append(model)

    def resolve_part(replacement_id: int, reloading_id: int) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
        part = parts_by_id.get(replacement_id)
        if part is None:
            return None, _reason("replacement-part-missing", f"MasterATReplacementparts id {replacement_id} is absent")
        source_path = _anon_tokyo_source_key(part.get("_pathName"))
        candidates = models_by_source.get(source_path or "", [])
        if len(candidates) != 1:
            return None, _reason(
                "replacement-model-unresolved",
                f"replacement part {replacement_id} maps to {source_path or 'an invalid source path'} ({len(candidates)} models)",
            )
        model = candidates[0]
        model_runtime = model.get("runtime") if isinstance(model.get("runtime"), dict) else {}
        if model_runtime.get("status") != "ready":
            return None, _reason(
                "replacement-model-unavailable",
                f"replacement part {replacement_id} model is not browser-ready",
            )
        runtime = model_runtime.get("json") if isinstance(model_runtime.get("json"), dict) else None
        return (
            {
                "replacementPartId": replacement_id,
                "reloadingId": reloading_id,
                "order": _integer(part.get("_order")),
                "pathName": str(part.get("_pathName") or ""),
                "sourcePath": source_path,
                "modelId": model.get("id"),
                "animations": model.get("animations"),
                **({"runtime": runtime} if runtime else {}),
            },
            None,
        )

    recipes: list[dict[str, Any]] = []
    for kind, table in tables:
        for row in _rows(layout.master / table):
            appearance_id = _integer(row.get("_id"))
            reloading_ids = [_integer(value) for value in (row.get("_defaultAvatar") or []) if _integer(value)]
            if not appearance_id or not reloading_ids:
                continue
            reasons: list[dict[str, str]] = []
            parts: list[dict[str, Any]] = []
            for reloading_id in reloading_ids:
                reloading_row = reloading_by_id.get(reloading_id)
                if reloading_row is None:
                    reasons.append(_reason("reloading-missing", f"MasterATReloading id {reloading_id} is absent"))
                    continue
                for replacement_id_value in reloading_row.get("_spineparent") or []:
                    replacement_id = _integer(replacement_id_value)
                    if not replacement_id:
                        continue
                    part, part_reason = resolve_part(replacement_id, reloading_id)
                    if part is None:
                        reasons.append(part_reason)
                        continue
                    parts.append(part)
            parts.sort(key=lambda value: (int(value["order"]), int(value["replacementPartId"])))
            if not parts:
                continue
            common = set(parts[0].get("animations") or [])
            for part in parts[1:]:
                common &= set(part.get("animations") or [])
            animation = next((name for name in ("f_idle", "b_idle") if name in common), "")
            if reasons or not animation:
                if not animation and not reasons:
                    reasons.append(
                        _reason("appearance-animation-missing", "appearance parts share no idle animation")
                    )
                continue
            recipes.append(
                {
                    "id": f"anon-tokyo-{kind}-{appearance_id}",
                    "feature": "anon-tokyo",
                    "appearance": {"kind": kind, "rawId": appearance_id},
                    "defaultAvatarReloadingIds": reloading_ids,
                    "scale": _positive_number(0.7, 1),
                    "animation": {"name": animation, "loop": True},
                    "parts": [
                        {key: value for key, value in part.items() if key != "animations"} for part in parts
                    ],
                    "runtime": {
                        "status": "ready",
                        "renderer": "layered-spine-4.2",
                        "sort": "ascending MasterATReplacementparts._order",
                        "verification": "MasterAT*._defaultAvatar -> MasterATReloading._spineparent -> MasterATReplacementparts",
                        "package": BROWSER_RUNTIME_PACKAGE,
                        "runtimeSeries": BROWSER_RUNTIME_SERIES,
                    },
                    "preview": {
                        "status": "unavailable",
                        "reason": _reason(
                            PREVIEW_UNAVAILABLE_REASON,
                            "No headless renderer assembled the layered Anon Tokyo appearance; no portrait is emitted.",
                        ),
                    },
                }
            )
    return recipes


def build_spine(config: ServerConfig, source_id: str, build_id: str) -> dict[str, Any]:
    """Build ``metadata/spine.json`` from one merged Unity build.

    This stage deliberately succeeds when a build contains no Spine assets;
    the empty manifest is still useful to a generic catalogue and keeps server
    behavior deterministic.
    """

    layout = build_layout(config.id, build_id)
    index_file = layout.metadata / "source-index.json"
    index = read_json(index_file)
    if (
        not isinstance(index, dict)
        or index.get("schema") != UNITY_INDEX_SCHEMA
        or index.get("server") != config.id
        or index.get("sourceId") != source_id
    ):
        raise ValueError("canonical Unity source index identity does not match this Spine build")
    resolver = _UnityResolver(layout, index)
    models: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for source_path in _candidate_paths(index):
        source = index["sources"].get(source_path)
        if not isinstance(source, dict):
            continue
        descriptor_file = layout.metadata / str(source.get("descriptor") or "")
        if not descriptor_file.is_file():
            skipped.append(
                {
                    "sourcePath": source_path,
                    "reason": _reason("source-descriptor-missing", f"missing descriptor: {descriptor_file}"),
                }
            )
            continue
        descriptor = read_json(descriptor_file)
        if not isinstance(descriptor, dict):
            skipped.append(
                {
                    "sourcePath": source_path,
                    "reason": _reason("source-descriptor-invalid", f"invalid descriptor: {descriptor_file}"),
                }
            )
            continue
        serialized_file = str(descriptor.get("serializedFile") or "")
        roots = [_int_string(value) for value in descriptor.get("rootObjects", [])]
        skeleton_records = []
        for root in roots:
            if not root or not serialized_file:
                continue
            record = resolver.record((serialized_file, root))
            if isinstance(record, dict) and _is_skeleton_data(record):
                skeleton_records.append(record)
        if not skeleton_records:
            # ``/Spine/`` contains AtlasAsset and Material sources too.  Only
            # report a failure for an explicit SkeletonData-named input.
            if "skeletondata" in source_path.casefold():
                skipped.append(
                    {
                        "sourcePath": source_path,
                        "reason": _reason("skeleton-data-root-missing", "no SkeletonDataAsset root object"),
                    }
                )
            continue
        for record in skeleton_records:
            models.append(_model_document(config, layout, resolver, source_path, descriptor, record))

    _assign_resource_model_ids(models)
    models.sort(key=lambda value: (str(value["sourcePath"]), str(value["id"])))
    recipes, anon_tokyo = _anon_tokyo_recipes(layout, models)
    recipes.extend(_anon_tokyo_outfit_recipes(layout, models, recipes))
    recipes.extend(_anon_tokyo_appearance_recipes(layout, models))
    recipes.sort(key=lambda value: str(value["id"]))
    rendered_model_previews, rendered_recipe_previews = _render_previews(
        config, layout, models, recipes
    )
    models_by_id = {str(model["id"]): model for model in models}
    recipes_by_id = {str(recipe["id"]): recipe for recipe in recipes}
    if len(models_by_id) != len(models):
        raise ValueError("Spine model IDs are not unique")
    if len(recipes_by_id) != len(recipes):
        raise ValueError("Spine render-recipe IDs are not unique")
    unavailable_models = {
        model_id: model
        for model_id, model in models_by_id.items()
        if isinstance(model.get("runtime"), dict)
        and model["runtime"].get("status") != "ready"
    }
    unavailable_recipes = {
        recipe_id: recipe
        for recipe_id, recipe in recipes_by_id.items()
        if isinstance(recipe.get("runtime"), dict)
        and recipe["runtime"].get("status") != "ready"
    }
    playable_count = sum(
        1
        for model in models_by_id.values()
        if isinstance(model.get("runtime"), dict) and model["runtime"].get("status") == "ready"
    )
    result = {
        "schema": SCHEMA,
        "previewSchema": PREVIEW_SCHEMA,
        "server": config.id,
        "sourceId": source_id,
        "candidateSourceCount": len(_candidate_paths(index)),
        "modelCount": len(models),
        "playableModelCount": playable_count,
        "unavailableModelCount": len(unavailable_models),
        "previewRenderedCount": rendered_model_previews,
        "previewUnavailableCount": len(models) - rendered_model_previews,
        "skippedSourceCount": len(skipped),
        "renderRecipeCount": len(recipes),
        "renderRecipePreviewRenderedCount": rendered_recipe_previews,
        "renderRecipePreviewUnavailableCount": len(recipes) - rendered_recipe_previews,
        "unavailableRenderRecipeCount": sum(
            1
            for recipe in unavailable_recipes.values()
        ),
        "browserRuntime": {
            "package": BROWSER_RUNTIME_PACKAGE,
            "packageVersion": BROWSER_RUNTIME_VERSION,
            "runtimeSeries": BROWSER_RUNTIME_SERIES,
            "loader": BROWSER_LOADER,
            "preview": {
                "status": "rendered" if rendered_model_previews or rendered_recipe_previews else "unavailable",
                "schema": PREVIEW_SCHEMA,
                "renderer": PREVIEW_RENDERER,
                "width": PREVIEW_WIDTH,
                "height": PREVIEW_HEIGHT,
                "pose": _setup_pose_metadata(),
                **(
                    {}
                    if rendered_model_previews or rendered_recipe_previews
                    else {"reason": _spine_preview_runtime_reason() or _reason(
                        "headless-webgl-renderer-error",
                        "The real preview renderer did not produce a successful preview.",
                    )}
                ),
                "fallbackPolicy": "Expose a real atlas page only; never synthesize a character portrait.",
            },
        },
        "anonTokyo": anon_tokyo,
        # ID-keyed records make the manifest directly usable by a route-based
        # catalogue without introducing a second normalization layer.  The
        # separate order arrays retain deterministic source ordering for UIs
        # that want a plain collection.
        "models": models_by_id,
        "modelOrder": list(models_by_id),
        "unavailableModels": unavailable_models,
        "renderRecipes": recipes_by_id,
        "renderRecipeOrder": list(recipes_by_id),
        "unavailableRenderRecipes": unavailable_recipes,
        "skippedSources": skipped,
    }
    write_json(layout.metadata / "spine.json", result, pretty=True)
    return result
