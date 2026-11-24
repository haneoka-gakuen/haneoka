// L3 — GEB
// Input: Human-readable search terms and indexed text.
// Output: One search form for simplified, traditional and Japanese glyphs, and equivalent SQLite patterns.
// Pos: [Map](L2-2.md); shared by browser filters, static search and Worker queries.
// Effects/Dependencies: Pure text conversion using the existing catalogue search dictionary.
import HAN_FOLD from "./search-han-fold.json" with { type: "json" };

const han = new Map<string, string>();
const variants = new Map<string, Set<string>>();
const pairs = [...(HAN_FOLD as string)];
for (let i = 0; i + 1 < pairs.length; i += 2) {
  const form = pairs[i]!, canonical = pairs[i + 1]!;
  han.set(form, canonical);
  let group = variants.get(canonical);
  if (!group) variants.set(canonical, group = new Set([canonical]));
  group.add(form);
}

export function foldSearchCharacter(character: string): string {
  const code = character.codePointAt(0);
  if (code !== undefined && code >= 0x3041 && code <= 0x3096) return String.fromCodePoint(code + 0x60);
  return han.get(character) ?? character;
}

export function foldSearchGlyphs(value: string): string {
  return value.normalize("NFKC").replace(/[\p{Script=Han}\u3041-\u3096]/gu, foldSearchCharacter);
}

export function normalizeSearchText(value: string, locale?: string): string {
  return foldSearchGlyphs(value).toLocaleLowerCase(locale);
}

export function searchIncludes(value: string, query: string, locale?: string): boolean {
  return normalizeSearchText(value, locale).includes(normalizeSearchText(query, locale));
}

/** A bound SQLite GLOB pattern with one class per equivalent character. */
export function searchGlob(value: string, exact = false): string {
  const pattern = [...normalizeSearchText(value)].map((character) => {
    const group = variants.get(character);
    if (group && group.size > 1) return `[${[...group].join("")}]`;
    const code = character.codePointAt(0)!;
    if (code >= 0x30a1 && code <= 0x30f6) return `[${character}${String.fromCodePoint(code - 0x60)}]`;
    return "*?[".includes(character) ? `[${character}]` : character;
  }).join("");
  return exact ? pattern : `*${pattern}*`;
}
