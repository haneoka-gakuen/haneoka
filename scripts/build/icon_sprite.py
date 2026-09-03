#!/usr/bin/env python3
"""Build the committed SVG icon sprite from @iconify-json/material-symbols.

Icons are referenced by name across the app (props, ternaries, data-driven
lookups), so there is no import graph to tree-shake against. This script
closes that gap: it scans the sources for icon names and collects the matching
ready-made Material Symbols SVG path data (rounded style, weight 400 — the
exact style the app renders) into one sprite of <symbol> elements.

MaterialIcon renders `<svg><use href="/icons.svg#name"></use></svg>`, so
icons paint with the document, inherit currentColor, and never depend on a
font download. The sprite is committed; re-run after adding icon references:

    python3 scripts/build/icon_sprite.py
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import json

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIRS = [ROOT / "src", ROOT / "packages"]
SCAN_SUFFIXES = {".astro", ".ts"}
ICON_COLLECTION = ROOT / "node_modules" / "@iconify-json" / "material-symbols" / "icons.json"
OUTPUT_SPRITE = ROOT / "public" / "icons.svg"
# Iconify normalises every icon body to a 24x24 viewBox, y-down.
SYMBOL_VIEWBOX = "0 0 24 24"

# Every syntactic position an icon name can appear in. Over-collection is
# harmless: names are validated against the package contents below.
PATTERNS = [
    re.compile(r"""(?:^|[^\w-])icon:\s*["']([a-z0-9_]+)["']""", re.MULTILINE),
    re.compile(r'\bicon="([a-z0-9_]+)"'),
    re.compile(r':icon="([^"]*)"'),
    re.compile(r'<MaterialIcon\b[^>]*?\bname="([^"]*)"', re.DOTALL),
    re.compile(r'<Icon\b[^>]*?\bname="([^"]*)"', re.DOTALL),
    re.compile(r'/icons\.svg#([a-z0-9_]+)'),
    # Lit render helpers use icon("name") instead of a component attribute.
    re.compile(r'''\bicon\(\s*["']([a-z0-9_]+)["']'''),
    re.compile(r':name="([^"]*)"'),
    re.compile(r"""h\(MaterialIcon,\s*\{[^}]*?name:\s*["']([a-z0-9_]+)["']""", re.DOTALL),
    # Icon registries map ids to names (`songs: "library_music"`), including
    # the shell/capability navigation maps in src/config.
    re.compile(r"""^\s*[a-z0-9_"-]+:\s*["']([a-z0-9_]+)["'],""", re.MULTILINE),
]
QUOTED_TOKEN = re.compile(r"""["']([a-z0-9_]+)["']""")
ICON_CALL_EXPRESSION = re.compile(r"\bicon\(([^)]*)\)", re.DOTALL)
ALWAYS_INCLUDED = {
    "light_mode",
    "brightness_auto",
    "dark_mode",
    # Passed through the generic detailSectionTitle(label, icon) helper.
    "monitoring",
    "group",
    "info",
    "description",
    "bolt",
    "trending_up",
    # Character detail tabs/section headings pass these through data arrays.
    "contact_page",
    "photo_library",
    "sticky_note_2",
    "mic",
    "chat",
    "handshake",
    "checklist",
    "accessibility_new",
    "music_note",
}

# A few call sites retain names from the older Material Icons vocabulary.
# Resolve them to their current Material Symbols equivalents while preserving
# the public symbol ids consumed by the interface.
LEGACY_NAME_ALIASES = {
    "bookmark_border": "bookmark",
    "collections": "photo_library",
    "emoji_emotions": "mood",
    "favorite_border": "favorite",
    "phonelink": "devices",
}


def scan_source_names() -> set[str]:
    names: set[str] = set(ALWAYS_INCLUDED)
    files = [
        path
        for directory in SOURCE_DIRS
        for path in directory.rglob("*")
        if path.suffix in SCAN_SUFFIXES and "node_modules" not in path.parts and "dist" not in path.parts
    ]
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for pattern in PATTERNS:
            for match in pattern.finditer(text):
                captured = match.group(1)
                # Bare captures are icon names directly; attribute positions may
                # carry ternaries and arrays, so keep their quoted tokens too.
                names.add(captured)
                names.update(QUOTED_TOKEN.findall(captured))
        for match in ICON_CALL_EXPRESSION.finditer(text):
            names.update(QUOTED_TOKEN.findall(match.group(1)))
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    args = parser.parse_args()

    if not ICON_COLLECTION.exists():
        raise SystemExit(f"Icon collection not found: {ICON_COLLECTION.relative_to(ROOT)} (install dependencies first)")

    collection = json.loads(ICON_COLLECTION.read_text(encoding="utf-8"))
    defined = collection["icons"]
    aliased = collection.get("aliases", {})

    def resolve(key: str) -> dict | None:
        """Look up an icon entry, following alias parent references."""
        entry = defined.get(key) or aliased.get(key)
        depth = 0
        while entry is not None and "body" not in entry and "parent" in entry and depth < 5:
            entry = defined.get(entry["parent"]) or aliased.get(entry["parent"])
            depth += 1
        return entry

    def body_for(name: str, filled: bool) -> tuple[str | None, str]:
        """Resolve an icon name to its rounded outline or filled body."""
        key = LEGACY_NAME_ALIASES.get(name, name).replace("_", "-")
        variant = f"{key}-rounded" if filled else f"{key}-outline-rounded"
        rounded = resolve(variant)
        if rounded is not None:
            return rounded.get("body"), "rounded"
        base = resolve(key if filled else f"{key}-outline")
        if base is None and not filled:
            base = resolve(f"{key}-rounded") or resolve(key)
        if base is not None:
            return base.get("body"), "base fallback"
        return None, ""

    referenced = scan_source_names()
    symbols = []
    missing = []
    fallbacks = []
    for name in sorted(referenced):
        outline, outline_source = body_for(name, False)
        filled, filled_source = body_for(name, True)
        if outline is None and filled is None:
            missing.append(name)
            continue
        outline = outline or filled
        filled = filled or outline
        if outline_source == "base fallback" or filled_source == "base fallback":
            fallbacks.append(name)
        symbols.append(f'<symbol id="{name}" viewBox="{SYMBOL_VIEWBOX}">{outline}</symbol>')
        symbols.append(f'<symbol id="{name}-filled" viewBox="{SYMBOL_VIEWBOX}">{filled}</symbol>')

    if not symbols:
        raise SystemExit("No icon references found; refusing to emit an empty sprite")
    if missing:
        print(f"{len(missing)} referenced names are not icons (skipped): {' '.join(sorted(missing))}")
    if fallbacks:
        print(f"{len(fallbacks)} icons use the base body (rounded variant unpublished): {' '.join(sorted(fallbacks))}")

    OUTPUT_SPRITE.parent.mkdir(parents=True, exist_ok=True)
    sprite = (
        '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">'
        + "".join(symbols)
        + "</svg>\n"
    )
    OUTPUT_SPRITE.write_text(sprite, encoding="utf-8")
    size_kb = OUTPUT_SPRITE.stat().st_size / 1024
    print(f"Wrote {OUTPUT_SPRITE.relative_to(ROOT)} ({size_kb:.1f} KB, {len(symbols)} icons)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
