import { normalizeSearchText } from "./search-text";
export type SourceTree = { [name: string]: SourceNode };
export type SourceNode = number | SourceTree;
export interface SourceEntry {
  name: string;
  label: string;
  value: SourceNode;
}
export interface SourceSearchRow {
  /** Exact descriptor path; language variants retain their actual identity. */
  path: string;
  parts: readonly string[];
  /** One logical source path, independent of the chosen language variant. */
  label: string;
  searchable: string;
}
const VARIANT_MARKS = new Set(["en", "ko", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW"]);
export function sourceVariant(file: string) {
  const match = /\(([^)]+)\)(\.[^.]+)$/u.exec(file);
  const mark = match?.[1] ?? "";
  return match && VARIANT_MARKS.has(mark)
    ? { base: file.slice(0, match.index), mark, ext: match[2] ?? "" }
    : null;
}
export function plainSourceName(name: string): string {
  return name.replace(/\((?:en|ko|zh-Hans|zh-Hant|zh-CN|zh-TW)\)(?=\.|--|\/|$)/gu, "");
}
/** Directory browsing and recursive search share the same per-parent grouping. */
export function sourceEntries(node: SourceTree, languages: readonly string[]): SourceEntry[] {
  const names = Object.keys(node);
  const plain = new Set(names.filter((name) => !sourceVariant(name)));
  const orphans = new Map<string, string[]>();
  for (const name of names) {
    const variant = sourceVariant(name);
    if (!variant) continue;
    const base = `${variant.base}${variant.ext}`;
    if (plain.has(base)) continue;
    const group = orphans.get(base);
    if (group) group.push(name);
    else orphans.set(base, [name]);
  }
  const entries: SourceEntry[] = [...plain].map((name) => ({ name, label: name, value: node[name]! }));
  for (const [base, group] of orphans) {
    const selected = languages.map((language) => group.find((name) => sourceVariant(name)?.mark === language))
      .find((name) => name !== undefined) ?? group[0]!;
    entries.push({ name: selected, label: base, value: node[selected]! });
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
}
const normalized = normalizeSearchText;
/** Index source leaves only: no descriptor requests or decoded-output inference. */
export function indexSourceTree(tree: SourceTree, languages: readonly string[]): SourceSearchRow[] {
  const rows: SourceSearchRow[] = [];
  const pending: Array<{ parts: string[]; node: SourceTree }> = [{ parts: [], node: tree }];
  while (pending.length) {
    const { parts, node } = pending.pop()!;
    for (const entry of sourceEntries(node, languages)) {
      const next = [...parts, entry.name];
      if (typeof entry.value === "number") {
        const path = next.join("/"), label = [...parts, entry.label].join("/");
        rows.push({ path, parts: next, label, searchable: normalized(`${label}\n${path}`) });
      } else if (entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)) {
        pending.push({ parts: next, node: entry.value });
      }
    }
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }) || a.path.localeCompare(b.path));
}
export function searchSourceTree(
  rows: readonly SourceSearchRow[], query: string, folder: readonly string[] = [],
): SourceSearchRow[] {
  const terms = normalized(query).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  const prefix = folder.length ? `${folder.join("/")}/` : "";
  return rows.filter((row) => (!prefix || row.path.startsWith(prefix)) && terms.every((term) => row.searchable.includes(term)));
}
