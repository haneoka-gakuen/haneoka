#!/usr/bin/env python3
"""Prepare Alpha8 URP film-grain reference textures from a Unity data file.

This is a reproducible research/build helper, not a runtime dependency. Unity's
source PNGs are grayscale RGB, while the reference runtime represents them as
Alpha8; the corresponding UberPost program samples the alpha channel.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import UnityPy
from PIL import Image


FILM_GRAIN_NAMES = {
    "Thin01",
    "Thin02",
    "Medium01",
    "Medium02",
    "Medium03",
    "Medium04",
    "Medium05",
    "Medium06",
    "Large01",
    "Large02",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("unity_data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    environment = UnityPy.load(str(args.unity_data))
    args.output.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()
    for obj in environment.objects:
        if obj.assets_file.name != "globalgamemanagers.assets" or obj.type.name != "Texture2D":
            continue
        texture = obj.read()
        if texture.m_Name not in FILM_GRAIN_NAMES:
            continue
        alpha = texture.image.convert("RGBA").getchannel("A")
        rgba = Image.new("RGBA", alpha.size, (0, 0, 0, 0))
        rgba.putalpha(alpha)
        rgba.save(args.output / f"{texture.m_Name}.png", optimize=True)
        written.add(texture.m_Name)

    missing = FILM_GRAIN_NAMES - written
    if missing:
        raise RuntimeError(f"missing reference film-grain textures: {sorted(missing)}")


if __name__ == "__main__":
    main()
