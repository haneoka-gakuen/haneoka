#!/usr/bin/env python3
# L3 — GEB
# Input: Repository files, docs/geb-scope.json and optional source-only comparison base.
# Output: Navigation, coverage and coordinate diagnostics; nonzero exit on failure.
# Pos: [Map](L2-2.md); offline GEB structural verification.
# Effects/Dependencies: Python standard library and read-only Git subprocesses; no network or application startup.
"""Check the repository's GEB navigation without application dependencies."""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SOURCE_SUFFIXES = {'.ts', '.mjs', '.js', '.py', '.astro', '.css', '.sql'}
LINK = re.compile(r'!?\[[^\n]*?\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)')
L3 = re.compile(
    rb'(?m)^(?P<prefix>\#|//) L3 \xe2\x80\x94 GEB\r?\n'
    rb'(?P=prefix) Input: [^\r\n]+\r?\n'
    rb'(?P=prefix) Output: [^\r\n]+\r?\n'
    rb'(?P=prefix) Pos: [^\r\n]+\r?\n'
    rb'(?P=prefix) Effects/Dependencies: [^\r\n]+\r?\n'
)


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ['git', '-c', f'safe.directory={root.as_posix()}', '-C', str(root), *args],
        stderr=subprocess.PIPE,
    )


def repository_files(root: Path) -> set[str]:
    return {
        p.decode('utf-8') for p in git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0') if p
    }


def without_fences(text: str) -> str:
    result = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            chars = marker.group(1)
            if fence is None:
                fence = chars
            elif chars[0] == fence[0] and len(chars) >= len(fence):
                fence = None
            continue
        if fence is None:
            result.append(line)
    return '\n'.join(result)


def links(text: str) -> list[str]:
    return [m.group(1).strip('<>') for m in LINK.finditer(without_fences(text))]


def heading_ids(text: str) -> set[str]:
    found = set()
    counts: dict[str, int] = {}
    for line in without_fences(text).splitlines():
        match = re.match(r'^ {0,3}#{1,6}\s+(.+?)\s*#*$', line)
        if not match:
            continue
        heading = re.sub(r'<[^>]*>', '', match.group(1)).lower()
        heading = re.sub(r'!?\[([^]]*)\]\([^)]*\)', r'\1', heading)
        heading = ''.join(c for c in heading if c in ' -_' or unicodedata.category(c)[0] in 'LN')
        slug = heading.replace(' ', '-')
        n = counts.get(slug, 0)
        counts[slug] = n + 1
        found.add(f'{slug}-{n}' if n else slug)
    found.update(re.findall(r'<a\s+(?:id|name)=["\']([^"\']+)', text, flags=re.I))
    return found


def local_target(root: Path, source: str, href: str) -> tuple[str, str] | None:
    """Return a contained repository-relative target; reject machine-local links."""
    if href.startswith('<') and href.endswith('>'):
        href = href[1:-1]
    parsed = urlsplit(href)
    if parsed.scheme in {'https', 'http', 'mailto', 'tel', 'app', 'codex'} or href.startswith('//'):
        return None
    if parsed.scheme or parsed.netloc or parsed.path.startswith(('/', '\\')):
        raise ValueError(f'non-portable link: {href}')
    path = unquote(parsed.path)
    if '\\' in path:
        raise ValueError(f'use forward slashes: {href}')
    destination = ((root / source).parent / path).resolve() if path else (root / source).resolve()
    if not destination.is_relative_to(root.resolve()):
        raise ValueError(f'link leaves repository: {href}')
    return destination.relative_to(root.resolve()).as_posix(), unquote(parsed.fragment)


def closest_map(path: str, maps: dict[str, str | None]) -> str:
    source = Path(path)
    candidates = [m for m in maps if m != 'L1.md' and source.is_relative_to(Path(m).parent)]
    return max(candidates, key=lambda m: len(Path(m).parts)) if candidates else 'L1.md'


def remove_l3(raw: bytes) -> bytes:
    # Only a real file header is eligible, after BOM/shebang/reference directives.
    offset = 3 if raw.startswith(b'\xef\xbb\xbf') else 0
    for line in raw[offset:].splitlines(keepends=True):
        if line.startswith((b'#!', b'/// <reference')) or (line.lstrip().startswith(b'#') and b'coding' in line):
            offset += len(line)
        else:
            break
    match = L3.match(raw[offset:])
    return raw[:offset] + raw[offset + match.end():] if match else raw


def check(root: Path, files: set[str], scope: dict, base: str | None = None) -> tuple[list[str], dict]:
    errors: list[str] = []
    maps = scope.get('maps', {})
    if scope.get('schema') != 'haneoka-geb-scope-v1' or not isinstance(maps, dict) or maps.get('L1.md', 'missing') is not None:
        return ['invalid GEB scope schema/root'], {}
    docs = set(maps) | set(scope.get('entry_documents', []))
    discovered_maps = {name for name in files if re.fullmatch(r'L[12](?:-[\w-]+)?\.md', Path(name).name)}
    for name in discovered_maps - set(maps):
        errors.append(f'{name}: map absent from scope')
    graph: dict[str, set[str]] = {}
    linked_files: set[str] = set()
    texts = {}
    for name in sorted(docs):
        if name not in files or not (root / name).is_file():
            errors.append(f'{name}: missing or ignored navigation document')
            continue
        texts[name] = (root / name).read_text(encoding='utf-8-sig')
    for name, text in texts.items():
        graph[name] = set()
        for href in links(text):
            try:
                target = local_target(root, name, href)
            except ValueError as exc:
                errors.append(f'{name}: {exc}')
                continue
            if target is None:
                continue
            dest, fragment = target
            if not (root / dest).exists():
                errors.append(f'{name}: missing link {href}')
                continue
            if (root / dest).is_file() and dest not in files:
                errors.append(f'{name}: ignored or unlisted link target {href}')
                continue
            linked_files.add(dest)
            if dest in docs:
                graph[name].add(dest)
            if fragment and (root / dest).is_file() and Path(dest).suffix == '.md':
                target_text = texts.get(dest)
                if target_text is None:
                    target_text = (root / dest).read_text(encoding='utf-8-sig')
                if fragment not in heading_ids(target_text):
                    errors.append(f'{name}: missing anchor {href}')
    for name, parent in maps.items():
        if parent is None:
            continue
        if parent not in maps:
            errors.append(f'{name}: unknown parent {parent}')
        if parent not in graph.get(name, set()):
            errors.append(f'{name}: no parent backlink to {parent}')
        if name not in graph.get(parent, set()):
            errors.append(f'{parent}: no child route to {name}')
        seen = {name}
        ancestor = parent
        while ancestor is not None and ancestor in maps:
            if ancestor in seen:
                errors.append(f'{name}: parent cycle')
                break
            seen.add(ancestor)
            ancestor = maps[ancestor]
    reachable = set()
    pending = ['L1.md']
    while pending:
        node = pending.pop()
        if node not in reachable:
            reachable.add(node)
            pending.extend(graph.get(node, set()))
    for name in docs - reachable:
        errors.append(f'{name}: unreachable from L1')
    for entry in ('AGENTS.md', 'README.md', 'CONTRIBUTING.md'):
        if entry in docs and 'L1.md' not in graph.get(entry, set()):
            errors.append(f'{entry}: no L1 entry')

    excluded = scope.get('excluded_prefixes', [])
    excluded_files = set(scope.get('excluded_files', []))
    roots = set(scope.get('source_roots', []))
    suffixes = set(scope.get('source_suffixes', []))
    owned_sources = {
        name for name in files if name.split('/')[0] in roots and Path(name).suffix in suffixes
        and name not in excluded_files and not any(name.startswith(p) for p in excluded)
    }
    # Every first-party source in the declared areas must have a reachable owner.
    for name in sorted(owned_sources):
        owner = closest_map(name, maps)
        if owner == 'L1.md' or owner not in reachable:
            errors.append(f'{name}: no reachable source map')
    core = set(scope.get('core_files', []))
    if len(core) != len(scope.get('core_files', [])):
        errors.append('duplicate core file registration')
    for name in sorted(core):
        if name not in linked_files:
            errors.append(f'{name}: no downward source route from navigation')
        if name not in files or not (root / name).is_file():
            errors.append(f'{name}: missing or ignored core file')
            continue
        raw = (root / name).read_bytes()
        header_area = raw.removeprefix(b'\xef\xbb\xbf')
        stripped = remove_l3(raw)
        if stripped == raw or len(L3.findall(header_area[:5000])) != 1:
            errors.append(f'{name}: missing, malformed or duplicate L3 header')
            continue
        head = L3.search(header_area).group().decode('utf-8')
        coordinate = next((line for line in head.splitlines() if ' Pos: ' in line), '')
        hrefs = links(coordinate)
        if len(hrefs) != 1:
            errors.append(f'{name}: Pos needs one direct map link')
            continue
        try:
            dest = local_target(root, name, hrefs[0])
            if dest != (closest_map(name, maps), ''):
                errors.append(f'{name}: Pos must link closest map {closest_map(name, maps)}')
        except ValueError as exc:
            errors.append(f'{name}: {exc}')
    for name in owned_sources - core:
        header_area = (root / name).read_bytes().removeprefix(b'\xef\xbb\xbf')[:5000]
        if re.search(rb'(?m)^(?:#|//) L3 \xe2\x80\x94 GEB', header_area):
            errors.append(f'{name}: L3 header absent from core scope')

    protected = 0
    if base:
        commit = git(root, 'rev-parse', '--verify', f'{base}^{{commit}}').decode().strip()
        before = {
            name.decode('utf-8') for name in git(root, 'ls-tree', '-r', '--name-only', '-z', commit).split(b'\0') if name
        }
        changed = {
            name.decode('utf-8') for name in git(root, 'diff', '--name-only', '-z', commit, '--').split(b'\0') if name
        }
        for name in sorted(before & changed):
            if Path(name).suffix not in SOURCE_SUFFIXES:
                continue
            if not (root / name).is_file():
                errors.append(f'{name}: source removed since comparison base')
                continue
            old = git(root, 'cat-file', '--filters', f'{commit}:{name}')
            new = (root / name).read_bytes()
            if old != new:
                if remove_l3(new) != old:
                    errors.append(f'{name}: executable source differs beyond new L3')
                if name.endswith('.py'):
                    try:
                        if ast.dump(ast.parse(old.decode('utf-8-sig')), include_attributes=False) != ast.dump(ast.parse(new.decode('utf-8-sig')), include_attributes=False):
                            errors.append(f'{name}: Python AST differs')
                    except SyntaxError as exc:
                        errors.append(f'{name}: Python parse failed: {exc}')
                protected += 1
    return sorted(set(errors)), {'maps': len(maps), 'core_headers': len(core), 'owned_sources': len(owned_sources), 'compared_changed_sources': protected}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', help='For annotation-only work: prove existing source bodies match this Git commit')
    args = parser.parse_args()
    try:
        scope = json.loads((ROOT / 'docs/geb-scope.json').read_text(encoding='utf-8'))
        errors, summary = check(ROOT, repository_files(ROOT), scope, args.base)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f'GEB check failed: {exc}', file=sys.stderr)
        return 1
    for error in errors:
        print(error, file=sys.stderr)
    print(json.dumps({'ok': not errors, **summary, 'errors': len(errors)}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
