"""Card-grid proposals from repeated contours, including overlaid card badges."""
import cv2
import numpy as np

cv2.setNumThreads(2)


def iou(a, b):
    x, y = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    overlap = max(0, right - x) * max(0, bottom - y)
    return overlap / (a[2] * a[3] + b[2] * b[3] - overlap + 1e-8)


def clustered_positions(values, tolerance):
    groups = []
    for value in sorted(values):
        if groups and value - np.median(groups[-1]) <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [int(round(np.median(group))) for group in groups]


def regular_positions(values, size):
    if len(values) < 2:
        return None
    steps = [b - a for a, b in zip(values, values[1:]) if size * .9 <= b - a <= size * 1.5]
    if not steps:
        return None
    pitch = float(np.median(steps))
    offsets = [round((value - values[0]) / pitch) for value in values]
    if any(abs(value - values[0] - offset * pitch) > size * .12 for value, offset in zip(values, offsets)):
        return None
    # Fit both endpoints so rounding does not accumulate across a long grid.
    pitch = (values[-1] - values[0]) / offsets[-1]
    return [round(values[0] + index * pitch) for index in range(offsets[-1] + 1)]


def grid(image):
    height, width = image.shape[:2]
    # Keep small screenshots on the same morphology scale, then restore their coordinates.
    scale = max(1.0, 1280 / max(width, height))
    working = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else image
    result = contour_grid(working)
    if scale > 1:
        for box in result["boxes"]:
            x, y, w, h = box["bbox"]
            left, top = round(x / scale), round(y / scale)
            right, bottom = min(width, round((x + w) / scale)), min(height, round((y + h) / scale))
            box["bbox"] = [left, top, right - left, bottom - top]
    return result


def contour_grid(image):
    height, width = image.shape[:2]
    edge = cv2.Canny(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), 50, 120)
    candidates = []
    # A larger close can join vertically adjacent cards through their badges.
    for kernel_size in (2, 3):
        closed = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, np.ones((kernel_size, kernel_size), np.uint8))
        contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if min(w, h) < 32 or w > width * .4 or h > height * .7:
                continue
            ratio = w / h
            kind = "members" if .68 < ratio < .85 else "snapshots" if 1.5 < ratio < 1.95 else None
            if kind and cv2.contourArea(contour) / (w * h) > .82:
                candidates.append({"kind": kind, "bbox": [x, y, w, h]})
    kept = []
    for box in sorted(candidates, key=lambda b: b["bbox"][2] * b["bbox"][3], reverse=True):
        if not any(iou(box["bbox"], other["bbox"]) > .7 for other in kept):
            kept.append(box)
    if not kept:
        return {"boxes": [], "status": "no-reliable-grid; user ROI adjustment required"}
    groups = []
    for box in kept:
        matching = next((group for group in groups if group[0]["kind"] == box["kind"]
                         and abs(group[0]["bbox"][2] - box["bbox"][2]) < box["bbox"][2] * .15
                         and abs(group[0]["bbox"][3] - box["bbox"][3]) < box["bbox"][3] * .15), None)
        if matching is None:
            groups.append([box])
        else:
            matching.append(box)
    dominant = max(groups, key=len)
    kind, boxes = dominant[0]["kind"], dominant
    if len(dominant) >= 3:
        w = int(np.median([box["bbox"][2] for box in dominant]))
        h = int(np.median([box["bbox"][3] for box in dominant]))
        if kind == "snapshots":
            # The 16:9 card body excludes bonus badges protruding above it.
            h = min(h, round(w * 9 / 16))
        xs = clustered_positions([box["bbox"][0] for box in dominant], w * .12)
        bottoms = clustered_positions([box["bbox"][1] + box["bbox"][3] for box in dominant], h * .18)
        columns, rows = regular_positions(xs, w), regular_positions(bottoms, h)
        if columns is not None and rows is not None:
            boxes = [{"kind": kind, "bbox": [x, bottom - h, w, h],
                      "proposal": "contour-supported regular grid"}
                     for bottom in rows for x in columns
                     if x >= 0 and bottom - h >= 0 and x + w <= width and bottom <= height]
    return {"boxes": sorted(boxes, key=lambda box: (round(box["bbox"][1] / max(1, box["bbox"][3] * .4)), box["bbox"][0])),
            "status": "proposals-only; verify card identity and reject unknowns", "kind": kind,
            "contourSeeds": len(dominant)}
