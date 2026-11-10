import { contentPublished } from "./content-publication";
import { resolveLocalizedText } from "./localized-text";
export function collectionDescription(rows: unknown[], locale: string, title: string): string {
  rows = rows.filter((row) => contentPublished(row));
  const names = [...new Set(rows.map(value => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    for (const field of ["musicTitle", "characterName", "prefix", "cardName", "chapterName", "title", "name"]) {
      const value = resolveLocalizedText(row[field], locale).text.trim();
      if (value) return value.replace(/<[^>]+>/gu, "");
    }
    return "";
  }).filter(Boolean))].slice(0, 8);
  return `${title} (${rows.length.toLocaleString(locale)})${names.length ? `: ${new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(names)}` : ""}`;
}
