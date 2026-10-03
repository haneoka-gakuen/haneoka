#!/usr/bin/env python3
"""Bounded CPU screenshot recognition against an explicitly pinned release index.

The caller owns HTTP/auth/queue and supplies locally verified reference files.
This module never downloads images or writes an account inventory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import OrderedDict
from PIL import __version__ as pillow_version
from pathlib import Path, PurePosixPath

import cv2
import numpy as np
from PIL import Image, ImageOps

if __package__:
    from .grid import grid
    from .levels import read_level
else:
    from grid import grid
    from levels import read_level

cv2.setNumThreads(2)
cv2.setRNGSeed(0)
MAX_IMAGES = 16
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 8_000_000
MAX_JOB_PIXELS = 32_000_000
MAX_REFERENCES = 4096
MAX_OBSERVATIONS = 1024
ALGORITHM = "card-sift-glyph-v1"
SHA = re.compile(r"^[a-f0-9]{64}$")
KINDS = {"members", "snapshots"}
UNKNOWN_FIELDS = ("training", "awakening", "liveSkillLevel", "gekisoSkillLevel")
SIFT_PARAMETERS = {"nfeatures": 450, "contrastThreshold": .014, "edgeThreshold": 10}
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class RecognitionError(ValueError):
    """A bounded error code, safe to expose without server paths."""


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        result = hashlib.file_digest(stream, "sha256")
    return result.hexdigest()


def local_path(root: Path, relative: object) -> Path:
    if not isinstance(relative, str) or "\\" in relative:
        raise RecognitionError("invalid_relative_path")
    parts = PurePosixPath(relative)
    if parts.is_absolute() or not parts.parts or parts.as_posix() != relative or any(v in (".", "..") for v in parts.parts):
        raise RecognitionError("invalid_relative_path")
    file = (root / relative).resolve()
    if not file.is_relative_to(root.resolve()):
        raise RecognitionError("path_outside_root")
    return file


def identity(value: object) -> dict:
    if not isinstance(value, dict) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(value.get("server", ""))):
        raise RecognitionError("invalid_reference_identity")
    if not re.fullmatch(r"r-[a-f0-9]{20}", str(value.get("releaseId", ""))):
        raise RecognitionError("invalid_reference_identity")
    return value


def read_rgb(file: Path, max_pixels: int = MAX_IMAGE_PIXELS) -> np.ndarray:
    if not file.is_file() or not 0 < file.stat().st_size <= MAX_IMAGE_BYTES:
        raise RecognitionError("image_size_limit")
    try:
        with Image.open(file) as image:
            if image.format not in ("PNG", "JPEG", "WEBP"):
                raise RecognitionError("unsupported_image_format")
            if image.width * image.height > max_pixels:
                raise RecognitionError("image_pixel_limit")
            normalized = ImageOps.exif_transpose(image)
            return np.array(normalized.convert("RGB"))
    except (OSError, Image.DecompressionBombError) as error:
        raise RecognitionError("image_decode_failed") from error


def unknown(reason: str = "not_visible_or_not_supported") -> dict:
    return {"value": None, "status": "unknown", "reason": reason}


def merge_observations(observations: list[dict], reference_identity: dict) -> list[dict]:
    """Aggregate evidence only; unknowns never clear a known observation."""
    entities = {}
    for obs in observations:
        if obs["cardId"] is None:
            continue
        key = (reference_identity["server"], obs["kind"], obs["cardId"])
        entity = entities.setdefault(key, {"key": {"server": key[0], "kind": key[1], "cardId": key[2]},
                                           "observationIds": [], "fields": {key: unknown() for key in UNKNOWN_FIELDS},
                                           "levelCandidates": set()})
        entity["observationIds"].append(obs["id"])
        if obs["fields"]["level"]["value"] is not None:
            entity["levelCandidates"].add(obs["fields"]["level"]["value"])
    for entity in entities.values():
        values = sorted(entity.pop("levelCandidates"))
        entity["fields"]["level"] = {"value": values[0] if len(values) == 1 else None,
                                     "status": "recognized" if len(values) == 1 else "conflict" if values else "unknown",
                                     "candidates": values}
    return list(entities.values())


class Recognizer:
    def __init__(self, index: dict, reference_root: Path, cache_root: Path):
        if index.get("schema") != "haneoka-card-recognition-index-v1":
            raise RecognitionError("invalid_reference_schema")
        self.identity = identity(index.get("identity"))
        self.root = reference_root
        self.cache = cache_root
        self.cache.mkdir(parents=True, exist_ok=True)
        refs = index.get("references")
        if not isinstance(refs, list) or not 1 <= len(refs) <= MAX_REFERENCES:
            raise RecognitionError("invalid_reference_count")
        self.references = []
        self.feature_memory: OrderedDict[str, tuple] = OrderedDict()
        self.sift = cv2.SIFT_create(**SIFT_PARAMETERS)
        self.matcher = cv2.BFMatcher(cv2.NORM_L2)
        self.prepared = self.restored = 0
        seen = set()
        for ref in refs:
            if not isinstance(ref, dict):
                raise RecognitionError("invalid_reference_card")
            card_id = ref.get("cardId")
            if ref.get("kind") not in KINDS or type(card_id) is not int or not 0 < card_id <= 2_147_483_647:
                raise RecognitionError("invalid_reference_card")
            if not SHA.fullmatch(str(ref.get("sha256", ""))):
                raise RecognitionError("invalid_reference_hash")
            file = local_path(reference_root, ref.get("path"))
            if not file.is_file() or not 0 < file.stat().st_size <= MAX_IMAGE_BYTES or digest(file) != ref["sha256"]:
                raise RecognitionError("reference_file_missing_or_changed")
            key = (ref["kind"], card_id, ref["sha256"])
            if key in seen:
                continue
            seen.add(key)
            self.references.append({**ref, "file": file})
        self.glyphs = {}
        self.allowed = {}
        reader = index.get("levelReader")
        if reader is not None:
            if not isinstance(reader, dict) or not isinstance(reader.get("glyphs"), dict):
                raise RecognitionError("invalid_level_reader")
            for character, rows in reader.get("glyphs", {}).items():
                if character not in "0123456789Lv." or not isinstance(rows, list) or not 1 <= len(rows) <= 128:
                    raise RecognitionError("invalid_level_glyph")
                if not all(isinstance(r, str) and 1 <= len(r) <= 128 and set(r) <= {"0", "1"} for r in rows):
                    raise RecognitionError("invalid_level_glyph")
                if len({len(r) for r in rows}) != 1:
                    raise RecognitionError("invalid_level_glyph")
                mask = np.array([[int(c) for c in row] for row in rows], np.float32)
                if not mask.any():
                    raise RecognitionError("empty_level_glyph")
                self.glyphs[character] = mask
            if not set("0123456789Lv") <= self.glyphs.keys():
                raise RecognitionError("missing_level_glyphs")
            for kind in KINDS:
                values = reader.get("allowedLevels", {}).get(kind, [])
                if not values or len(values) > 1000 or any(type(v) is not int or not 1 <= v <= 999 for v in values):
                    raise RecognitionError("invalid_level_range")
                self.allowed[kind] = set(values)
        self.feature_recipe = hashlib.sha256(json.dumps({"opencv": cv2.__version__, "pillow": pillow_version,
                                                        "sift": SIFT_PARAMETERS}, sort_keys=True).encode()).hexdigest()
        source_hashes = {file: digest(Path(__file__).parent / file) for file in ("card_inventory.py", "grid.py", "levels.py")}
        self.recipe = hashlib.sha256(json.dumps({"algorithm": ALGORITHM, "opencv": cv2.__version__,
                                                "numpy": np.__version__, "pillow": pillow_version,
                                                "sourceHashes": source_hashes, "index": index},
                                               sort_keys=True).encode()).hexdigest()

    def features(self, ref: dict) -> tuple:
        key = hashlib.sha256((ref["sha256"] + self.feature_recipe).encode()).hexdigest()
        if key in self.feature_memory:
            self.feature_memory.move_to_end(key)
            return self.feature_memory[key]
        file = self.cache / f"{key}.npz"
        if file.is_file():
            with np.load(file, allow_pickle=False) as stored:
                data = (stored["rgb"], stored["points"], stored["descriptors"])
            self.restored += 1
        else:
            rgb = read_rgb(ref["file"])
            ratio = min(1, 320 / max(rgb.shape[:2]))
            small = cv2.resize(rgb, None, fx=ratio, fy=ratio, interpolation=cv2.INTER_AREA)
            points, descriptors = self.sift.detectAndCompute(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), None)
            xy = np.float32([p.pt for p in points]).reshape(-1, 2)
            if descriptors is None:
                descriptors = np.empty((0, 128), np.float32)
            temporary = self.cache / f".{key}-{time.time_ns()}.npz"
            np.savez_compressed(temporary, rgb=small, points=xy, descriptors=descriptors)
            temporary.replace(file)
            data = small, xy, descriptors
            self.prepared += 1
        self.feature_memory[key] = data
        while len(self.feature_memory) > 64:
            self.feature_memory.popitem(last=False)
        return data

    def match(self, crop: np.ndarray, kind: str) -> dict:
        h, w = crop.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        mask[round(h * .12):round(h * .89), round(w * .09):round(w * .9)] = 255
        points, descriptors = self.sift.detectAndCompute(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), mask)
        if descriptors is None:
            return {"cardId": None, "status": "unknown", "reason": "no_image_features", "candidates": []}
        grouped = {}
        for ref in self.references:
            if ref["kind"] != kind:
                continue
            rgb, xy, ds = self.features(ref)
            if not len(ds):
                continue
            pairs = self.matcher.knnMatch(descriptors, ds, k=2)
            good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < .74 * p[1].distance]
            count = 0
            coverage = 0.0
            correlation = -1.0
            error = None
            if len(good) >= 3:
                src = np.float32([xy[m.trainIdx] for m in good])
                dst = np.float32([points[m.queryIdx].pt for m in good])
                cv2.setRNGSeed(0)
                matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                                            ransacReprojThreshold=2.2, maxIters=1000, confidence=.99)
                if matrix is not None:
                    selected = inliers.ravel() > 0
                    count = int(selected.sum())
                    coverage = float(cv2.contourArea(cv2.convexHull(dst[selected])) / (w * h))
                    predicted = cv2.transform(src[selected].reshape(-1, 1, 2), matrix).reshape(-1, 2)
                    error = float(np.median(np.linalg.norm(predicted - dst[selected], axis=1)))
                    warped = cv2.warpAffine(rgb, matrix, (w, h))
                    region = (mask > 0) & (warped.max(axis=2) > 0)
                    a = crop[region].astype(np.float32).ravel()
                    b = warped[region].astype(np.float32).ravel()
                    if len(a):
                        a -= a.mean()
                        b -= b.mean()
                        correlation = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))
            score = count + max(0, min(1, correlation)) * 3 + coverage * 2
            candidate = {"cardId": ref["cardId"], "variant": ref.get("variant", "thumbnail"),
                         "score": round(score, 6), "inliers": count, "coverage": round(coverage, 6),
                         "alignedSimilarity": round(correlation, 6), "medianReprojectionError": error}
            if ref["cardId"] not in grouped or grouped[ref["cardId"]]["score"] < score:
                grouped[ref["cardId"]] = candidate
        ranked = sorted(grouped.values(), key=lambda r: r["score"], reverse=True)
        if not ranked:
            return {"cardId": None, "status": "unknown", "reason": "no_reference_candidates", "candidates": []}
        best = ranked[0]
        margin = best["score"] - ranked[1]["score"] if len(ranked) > 1 else None
        accepted = best["inliers"] >= 6 and best["alignedSimilarity"] >= .70 and margin is not None and margin >= 4
        return {"cardId": best["cardId"] if accepted else None,
                "status": "recognized" if accepted else "needs_confirmation",
                "reason": "geometry_supported" if accepted else "weak_or_ambiguous_card_match",
                "margin": margin, "candidates": ranked[:5]}

    def recognize(self, request: dict, job_root: Path) -> dict:
        if request.get("schema") != "haneoka-card-recognition-request-v1":
            raise RecognitionError("invalid_request_schema")
        expected = identity(request.get("identity"))
        if (any(expected.get(k) != self.identity.get(k) for k in ("server", "releaseId"))
                or expected.get("sourceId") is not None and expected["sourceId"] != self.identity.get("sourceId")):
            raise RecognitionError("reference_identity_mismatch")
        inputs = request.get("images")
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= MAX_IMAGES:
            raise RecognitionError("invalid_image_count")
        if any(not isinstance(i, dict) or not isinstance(i.get("id"), str) for i in inputs):
            raise RecognitionError("invalid_image_entry")
        if len({i["id"] for i in inputs}) != len(inputs):
            raise RecognitionError("duplicate_image_id")
        started = time.perf_counter()
        observations, images, warnings = [], [], []
        duplicate_cache = {}
        total_pixels = 0
        for entry in inputs:
            image_id = entry.get("id")
            if not isinstance(image_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", image_id):
                raise RecognitionError("invalid_image_id")
            file = local_path(job_root, entry.get("path"))
            if not file.is_file() or not 0 < file.stat().st_size <= MAX_IMAGE_BYTES:
                raise RecognitionError("image_size_limit")
            body_sha = digest(file)
            if entry.get("sha256") is not None and body_sha != entry["sha256"]:
                raise RecognitionError("input_image_hash_changed")
            rgb = read_rgb(file)
            height, width = rgb.shape[:2]
            total_pixels += height * width
            if total_pixels > MAX_JOB_PIXELS:
                raise RecognitionError("job_pixel_limit")
            if entry.get("kind") is not None and (not isinstance(entry["kind"], str) or entry["kind"] not in KINDS):
                raise RecognitionError("invalid_image_kind")
            crop = entry.get("crop")
            x0 = y0 = 0
            if crop is not None:
                if not isinstance(crop, dict) or any(type(crop.get(k)) is not int for k in ("x", "y", "width", "height")):
                    raise RecognitionError("invalid_crop")
                x0, y0, cw, ch = [crop[k] for k in ("x", "y", "width", "height")]
                if min(x0, y0) < 0 or min(cw, ch) < 16 or x0 + cw > width or y0 + ch > height:
                    raise RecognitionError("crop_outside_image")
                rgb = rgb[y0:y0 + ch, x0:x0 + cw]
            scale = min(1, 2048 / max(rgb.shape[:2]))
            working = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else rgb
            duplicate_key = (body_sha, json.dumps(crop, sort_keys=True), entry.get("kind"))
            if duplicate_key in duplicate_cache:
                found, prepared = duplicate_cache[duplicate_key]
                if len(observations) + len(prepared) > MAX_OBSERVATIONS:
                    raise RecognitionError("observation_limit")
            else:
                found = grid(working)
                boxes = found["boxes"]
                if entry.get("kind") in KINDS:
                    boxes = [b for b in boxes if b["kind"] == entry["kind"]]
                if not boxes and crop is not None and entry.get("kind") in KINDS:
                    boxes = [{"kind": entry["kind"], "bbox": [0, 0, working.shape[1], working.shape[0]]}]
                if len(observations) + len(boxes) > MAX_OBSERVATIONS:
                    raise RecognitionError("observation_limit")
                prepared = []
                for proposal in boxes:
                    x, y, w, h = proposal["bbox"]
                    kind = proposal["kind"]
                    matched = self.match(working[y:y + h, x:x + w], kind)
                    level = unknown("level_resources_unavailable")
                    if self.glyphs:
                        patch = working[y:min(working.shape[0], y + h + round(h * .08)), x:x + w]
                        read = read_level(patch, self.glyphs, self.allowed[kind])
                        level = {"value": read["value"], "status": "recognized" if read["value"] is not None else "unknown",
                                 "reason": read["reason"], "method": "native_glyph_consensus"}
                    bbox = [x0 + round(x / scale), y0 + round(y / scale), round(w / scale), round(h / scale)]
                    prepared.append({"kind": kind, "bbox": bbox, **matched,
                                     "fields": {"level": level, **{key: unknown() for key in UNKNOWN_FIELDS}}})
                duplicate_cache[duplicate_key] = (found, prepared)
            ids = []
            for result in prepared:
                obs_id = f"{image_id}:{len(ids) + 1}"
                ids.append(obs_id)
                observations.append({"id": obs_id, "imageId": image_id, **result})
            if len(observations) > MAX_OBSERVATIONS:
                raise RecognitionError("observation_limit")
            images.append({"id": image_id, "sha256": body_sha, "size": [width, height], "observationIds": ids,
                           "status": "processed" if ids else "needs_crop", "coordinateSpace": "exif_normalized_original"})
            if not ids:
                warnings.append({"imageId": image_id, "code": "no_reliable_grid"})
        entities = merge_observations(observations, self.identity)
        return {"schema": "haneoka-card-recognition-result-v1", "identity": self.identity,
                "images": images, "observations": observations, "entities": entities, "warnings": warnings,
                "engine": {"algorithm": ALGORITHM, "opencv": cv2.__version__, "recipeFingerprint": self.recipe,
                           "scoreMeaning": "geometric evidence/similarity, not probability"},
                "stats": {"images": len(images), "observations": len(observations), "recognizedObservations": sum(o["cardId"] is not None for o in observations),
                          "uniqueEntities": len(entities), "acceptedLevels": sum(o["fields"]["level"]["value"] is not None for o in observations),
                          "featuresPrepared": self.prepared, "featureCacheRestores": self.restored,
                          "seconds": round(time.perf_counter() - started, 3), "inventoryWrites": 0}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("request", "job-root", "reference-index", "reference-root", "cache-root", "output"):
        parser.add_argument("--" + flag, type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.reference_index.stat().st_size > 4 * 1024 * 1024 or args.request.stat().st_size > 64 * 1024:
            raise RecognitionError("json_size_limit")
        index = json.loads(args.reference_index.read_text())
        request = json.loads(args.request.read_text())
        result = Recognizer(index, args.reference_root, args.cache_root).recognize(request, args.job_root)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
        temporary.replace(args.output)
        print(json.dumps({"status": "succeeded", "observations": result["stats"]["observations"],
                          "uniqueEntities": result["stats"]["uniqueEntities"]}))
        return 0
    except (RecognitionError, OSError, json.JSONDecodeError) as error:
        code = str(error) if isinstance(error, RecognitionError) else "recognition_io_failed"
        print(json.dumps({"status": "failed", "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
