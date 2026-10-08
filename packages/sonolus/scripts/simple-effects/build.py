"""Build the compact effect001 particle pack: particle.data, particle.texture.png and the engine part table."""
import gzip, json, os, sys
import numpy as np
from PIL import Image
from compose import EmptyTile, Build, frame_parts, pillar_part, wall_part, emitter_part, EMITTER_BUCKETS
from parts import extract

OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/xuc/.claude/jobs/50d4d325/tmp/fxre/pack"
ONLY = os.environ.get("ONLY")

# (prefab, effect key, {judgement: clip}); judgement 5 Perfect, 4 Great, 3 Good, 2 Bad.
EFFECTS = [
    ("note_normal", "Normal", {5: "tap_perfect", 4: "tap_great", 3: "tap_good", 2: "tap_bad"}),
    ("note_just", "Just", {5: "tap_perfect"}),
    ("note_slide", "Slide", {5: "tap_slide_parfect", 4: "tap_slide_great", 3: "tap_slide_good", 2: "tap_slide_bad"}),
    ("note_slide_connect", "Connect", {5: "tap_slide_parfect", 4: "tap_slide_great", 3: "tap_slide_good", 2: "tap_slide_bad"}),
    ("note_flick", "Flick", {5: "tap_flick_perfect", 4: "tap_flick_great", 3: "tap_flick_good", 2: "tap_flick_bad"}),
    ("note_flick_left", "FlickLeft", {5: "tap_flick_perfect", 4: "tap_flick_great", 3: "tap_flick_good", 2: "tap_flick_bad"}),
    ("note_flick_right", "FlickRight", {5: "tap_flick_perfect", 4: "tap_flick_great", 3: "tap_flick_good", 2: "tap_flick_bad"}),
    ("note_slide_loop", "Loop", {0: "tap_slide_loop"}),
]


def build():
    b = Build()
    durations = {}
    for prefab, key, clips in EFFECTS:
        if ONLY and key != ONLY:
            continue
        for judgement, clip in clips.items():
            loop = key == "Loop"
            e = extract(prefab, clip, loop=loop)
            base = f"Our Notes FX {key} {judgement}"
            durations[f"{key} {judgement}"] = e["stop"]
            pillars = 0
            for part in e["parts"]:
              try:
                if part["kind"] == "frame":
                    frame_parts(b, base, part, e["stop"], judgement)
                elif part["kind"] == "pillar":
                    pillars += 1
                    pillar_part(b, base, part, e["stop"], judgement, pillars)
                elif part["kind"] == "wall":
                    wall_part(b, base, part, e["stop"], loop)
                elif part["kind"] == "emitter":
                    for bucket in EMITTER_BUCKETS:
                        emitter_part(b, base, part, e["stop"], loop, bucket)
              except EmptyTile:
                print(f"  {part['path']}: nothing visible, skipped")
            print(f"{base}: stop {e['stop']:.3f}", flush=True)
    return b, durations


def pack(tiles):
    """Shelf packer; returns atlas RGBA and rects."""
    order = sorted(range(len(tiles)), key=lambda i: -tiles[i].shape[0])
    W = 4096
    x = y = row = 0
    rects = [None] * len(tiles)
    for i in order:
        h, w = tiles[i].shape[:2]
        if x + w + 2 > W:
            x, y, row = 0, y + row + 2, 0
        rects[i] = (x + 1, y + 1, w, h)
        x += w + 2; row = max(row, h)
    H = 1
    while H < y + row + 2:
        H *= 2
    atlas = np.zeros((H, W, 4), dtype=np.uint8)
    for i, (rx, ry, w, h) in enumerate(rects):
        atlas[ry:ry + h, rx:rx + w] = tiles[i]
    return atlas, rects


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    b, durations = build()
    atlas, rects = pack(b.tiles)
    Image.fromarray(atlas).save(os.path.join(OUT, "fx.texture.png"))
    data = {"width": atlas.shape[1], "height": atlas.shape[0], "interpolation": True,
            "sprites": [{"x": r[0], "y": r[1], "w": r[2], "h": r[3]} for r in rects], "effects": b.effects}
    with open(os.path.join(OUT, "fx.data.json"), "w") as f:
        json.dump(data, f)
    with open(os.path.join(OUT, "fx.table.json"), "w") as f:
        json.dump({"durations": durations, "parts": b.table}, f, indent=1)
    n = sum(len(g["particles"]) * g["count"] for e in b.effects for g in e["groups"])
    print(f"effects {len(b.effects)} tiles {len(b.tiles)} atlas {atlas.shape[1]}x{atlas.shape[0]} particle defs {n}")
