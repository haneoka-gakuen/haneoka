/** Facet identities shared by catalogue tables and team-building pickers. */
export type CatalogRecord = Record<string, unknown>;
export const CARD_SKILL_FACETS = [
  { key: "leaderSkill", role: "leader", kinds: ["member"] },
  { key: "liveSkill", role: "live", kinds: ["member"] },
  { key: "gekisouSkill", role: "gekisou", kinds: ["member"] },
  { key: "supportSkill", role: "support", kinds: ["support"] },
  { key: "gekisouSupportSkill", role: "gekisouSupport", kinds: ["support"] },
] as const;
export function cardSkills(item: CatalogRecord, role: string): CatalogRecord[] {
  const skills = item.resolvedSkills as CatalogRecord | undefined;
  const value = skills?.[role];
  return (Array.isArray(value) ? value : value ? [value] : []).filter((row): row is CatalogRecord => !!row && typeof row === "object");
}
// Master titles identify the original skill categories, including their
// activation/target conditions. The identity uses the fixed source language.
export function skillTypeTitle(title: string): string { return title.trim(); }
export function skillTypeKey(skill: CatalogRecord): string {
  const value = skill.skillName;
  const canonical = Array.isArray(value) ? value.find((text) => typeof text === "string" && text.trim()) : typeof value === "string" ? value : "";
  if (!canonical) return "";
  return skillTypeTitle(String(canonical));
}
export function skillFacetValues(item: CatalogRecord, key: string): string[] | undefined {
  const facet = CARD_SKILL_FACETS.find((facet) => facet.key === key);
  return facet ? [...new Set(cardSkills(item, facet.role).map(skillTypeKey).filter(Boolean))] : undefined;
}
export function songMissions(item: CatalogRecord): string[] {
  const value = item.gekisou as CatalogRecord | undefined;
  const types = value?.missionTypes ?? value?.missionPattern;
  return (Array.isArray(types) ? types : []).map((value) => {
    const n = Number(value);
    return Number.isInteger(n) ? ["", "Combo", "Luck", "JustCount"][n] || "" : ["Combo", "Luck", "JustCount"].includes(String(value)) ? String(value) : "";
  });
}
export function matchesSelections(values: readonly string[], selected: readonly string[]): boolean {
  return !selected.length || values.some((value) => selected.includes(value));
}

export function cardArtwork(item: CatalogRecord): string {
  const images = item.images as CatalogRecord | undefined;
  const value = images?.thumbnail || item.thumbnail || item.image;
  return typeof value === "string" ? value : value && typeof value === "object" ? String((value as CatalogRecord).url ?? (value as CatalogRecord).path ?? "") : "";
}
