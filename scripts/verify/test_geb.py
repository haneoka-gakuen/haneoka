"""Representative broken-navigation and annotation-preservation regressions."""
from pathlib import Path
import tempfile
import subprocess
import unittest

from geb import check, git, heading_ids, links, local_target, remove_l3

TEST_TMP = Path(__file__).resolve().parents[2] / 'tmp' / 'geb-tests'


def temporary_repository():
    TEST_TMP.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=TEST_TMP)


class NavigationTests(unittest.TestCase):
    def test_encoded_dynamic_route_and_chinese_anchor(self):
        root = Path.cwd().resolve()
        self.assertEqual(local_target(root, 'docs/L2.md', '../src/pages/%5Bserver%5D/index.astro'), ('src/pages/[server]/index.astro', ''))
        self.assertEqual(local_target(root, 'docs/L2.md', '<DEV GUIDE.md#输入与输出>'), ('docs/DEV GUIDE.md', '输入与输出'))
        self.assertIn('输入与输出', heading_ids('# 文件\n## 输入与输出'))
        self.assertIn('same-1', heading_ids('# Same\n# Same'))

    def test_fenced_example_is_not_a_real_link(self):
        text = '[Real](L1.md)\n```text\n[Map](placeholder.md)\n```\n[Other](<with space.md>)'
        self.assertEqual(links(text), ['L1.md', 'with space.md'])

    def test_machine_paths_and_repository_escape_are_rejected(self):
        for href in ('../../private.txt', 'E:/private.txt', 'file:///private.txt', '/absolute.txt', '..\\private.txt'):
            with self.subTest(href=href), self.assertRaises(ValueError):
                local_target(Path.cwd(), 'L1.md', href)
        self.assertIsNone(local_target(Path.cwd(), 'L1.md', 'https://example.com/'))

    def test_annotation_removal_preserves_bom_shebang_crlf_and_docstring(self):
        prefix = b'\xef\xbb\xbf#!/usr/bin/env python3\r\n'
        head = '# L3 — GEB\r\n# Input: x\r\n# Output: y\r\n# Pos: [Map](L2.md)\r\n# Effects/Dependencies: z\r\n'.encode()
        body = b'"""Original module documentation."""\r\nfrom __future__ import annotations\r\nx = 1\r\n'
        self.assertEqual(remove_l3(prefix + head + body), prefix + body)
        self.assertEqual(remove_l3(body + head), body + head)
        reference = b'/// <reference lib="webworker" />\r\n'
        ts_head = head.replace(b'#', b'//')
        self.assertEqual(remove_l3(reference + ts_head + b'export {};\r\n'), reference + b'export {};\r\n')

    def test_broken_link_backlink_and_coverage_fail(self):
        with temporary_repository() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'L1.md').write_text('[child](src/L2.md)\n[missing](missing.md)', encoding='utf-8')
            (root / 'src/L2.md').write_text('# Source\n', encoding='utf-8')
            (root / 'src/entry.ts').write_text('export {};\n', encoding='utf-8')
            scope = {
                'schema': 'haneoka-geb-scope-v1', 'maps': {'L1.md': None, 'src/L2.md': 'L1.md'},
                'entry_documents': [], 'source_roots': ['src'], 'source_suffixes': ['.ts'],
                'core_files': ['src/entry.ts'],
            }
            files = {'L1.md', 'src/L2.md', 'src/entry.ts'}
            errors, _ = check(root, files, scope)
            self.assertTrue(any('missing link' in e for e in errors))
            self.assertTrue(any('no parent backlink' in e for e in errors))
            self.assertTrue(any('missing, malformed or duplicate L3' in e for e in errors))
            (root / 'src/L2.md').write_text('[parent](../L1.md)\n[entry](entry.ts)', encoding='utf-8')
            (root / 'L1.md').write_text('[child](src/L2.md)', encoding='utf-8')
            (root / 'src/entry.ts').write_text('// L3 — GEB\n// Input: x\n// Output: y\n// Pos: [Map](L2.md)\n// Effects/Dependencies: z\nexport {};\n', encoding='utf-8')
            self.assertEqual(check(root, files, scope)[0], [])
            errors, _ = check(root, files - {'src/L2.md'}, scope)
            self.assertTrue(any('missing or ignored navigation' in e for e in errors))

    def test_parent_cycle_and_wrong_coordinate_fail(self):
        with temporary_repository() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'L1.md').write_text('[child](src/L2.md)', encoding='utf-8')
            (root / 'src/L2.md').write_text('[self](L2.md)', encoding='utf-8')
            (root / 'src/entry.ts').write_text('// L3 — GEB\n// Input: x\n// Output: y\n// Pos: [Map](../L1.md)\n// Effects/Dependencies: z\nexport {};\n', encoding='utf-8')
            scope = {'schema': 'haneoka-geb-scope-v1', 'maps': {'L1.md': None, 'src/L2.md': 'src/L2.md'}, 'source_roots': ['src'], 'source_suffixes': ['.ts'], 'core_files': ['src/entry.ts']}
            errors, _ = check(root, {'L1.md', 'src/L2.md', 'src/entry.ts'}, scope)
            self.assertTrue(any('parent cycle' in e for e in errors))
            self.assertTrue(any('Pos must link closest map' in e for e in errors))

    def test_base_guard_accepts_new_header_but_rejects_logic_change(self):
        with temporary_repository() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True, capture_output=True)
            git(root, 'config', 'core.autocrlf', 'false')
            (root / 'src').mkdir()
            (root / 'L1.md').write_text('[child](src/L2.md)', encoding='utf-8')
            (root / 'src/L2.md').write_text('[parent](../L1.md)\n[entry](entry.py)', encoding='utf-8')
            (root / 'src/entry.py').write_text('value = 1\n', encoding='utf-8')
            git(root, 'add', '--', 'L1.md', 'src/L2.md', 'src/entry.py')
            git(root, '-c', 'user.name=GEB test', '-c', 'user.email=geb-test@example.invalid', 'commit', '--quiet', '-m', 'Fixture baseline')
            header = '# L3 — GEB\n# Input: x\n# Output: y\n# Pos: [Map](L2.md)\n# Effects/Dependencies: z\n'
            (root / 'src/entry.py').write_text(header + 'value = 1\n', encoding='utf-8')
            files = {'L1.md', 'src/L2.md', 'src/entry.py'}
            scope = {'schema': 'haneoka-geb-scope-v1', 'maps': {'L1.md': None, 'src/L2.md': 'L1.md'}, 'source_roots': ['src'], 'source_suffixes': ['.py'], 'core_files': ['src/entry.py']}
            self.assertEqual(check(root, files, scope, 'HEAD')[0], [])
            (root / 'src/entry.py').write_text(header + 'value = 2\n', encoding='utf-8')
            errors, _ = check(root, files, scope, 'HEAD')
            self.assertTrue(any('executable source differs' in e for e in errors))
            self.assertTrue(any('Python AST differs' in e for e in errors))


if __name__ == '__main__':
    unittest.main()
