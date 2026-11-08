// L3 — GEB
// Input: Save server and cancellation signal.
// Output: Release-pinned metadata and capped card levels.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Reads public catalogue resources; verifies release and source headers.
import { resolveLocalizedText } from "../localized-text";
export type Row = Record<string, unknown>;
export type SaveCatalog = {
  releaseId: string;
  sourceId: string;
  server: string;
  resources: Record<string, Record<string, Row>>;
};
export const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
export const text = (v: unknown, locale: string) => resolveLocalizedText(v, locale).text;
export async function loadSaveCatalog(server: "jp" | "intl", signal: AbortSignal): Promise<SaveCatalog> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const base = `/api/v1/servers/${server}/`;
  const pinResponse = await fetch(`${base}release`, { signal });
  if (!pinResponse.ok) throw new Error("catalog_failed");
  const pin = await pinResponse.json();
  if (pin.server !== server || typeof pin.releaseId !== "string" || typeof pin.sourceId !== "string")
    throw new Error("catalog_failed");
  const pairs = await Promise.all(
    ["cards", "support-cards", "characters", "songs", "items", "band-items", "progression"].map(async (key) => {
      const response = await fetch(`${base}${key}?release=${encodeURIComponent(pin.releaseId)}`, { signal });
      if (
        !response.ok ||
        response.headers.get("x-haneoka-release-id") !== pin.releaseId ||
        response.headers.get("x-haneoka-source-id") !== pin.sourceId
      )
        throw new Error("catalog_failed");
      const data = object(await response.json());
      return [key, object(data.entries ?? data.items ?? data[key] ?? data)] as const;
    }),
  );
  return { ...pin, resources: Object.fromEntries(pairs) };
}
export function saveEntity(catalog: SaveCatalog | undefined, resource: string, id: unknown): Row {
  return object(catalog?.resources[resource]?.[String(id)]);
}
export function saveLevel(catalog: SaveCatalog | undefined, row: Row, member: boolean): number | null {
  const metadata = saveEntity(catalog, member ? "cards" : "support-cards", row._masterId),
    group = metadata[member ? "memberCardLevelGroup" : "supportCardLevelGroup"];
  const table = catalog?.resources.progression?.[member ? "memberCardLevels" : "supportCardLevels"] as unknown;
  if (group == null || !Array.isArray(table) || !/^\d+$/.test(String(row._exp ?? ""))) return null;
  let result: number | null = null;
  for (const value of table) {
    const entry = object(value);
    if (String(entry.group) !== String(group) || !/^\d+$/.test(String(entry.exp ?? ""))) continue;
    const level = Number(entry.level);
    if (Number.isSafeInteger(level) && BigInt(String(entry.exp)) <= BigInt(String(row._exp)))
      result = Math.max(result ?? 0, level);
  }
  if (result === null) return null;
  const limits = catalog?.resources.progression?.[member ? "memberCardLevelLimits" : "supportCardRanks"] as unknown;
  if (Array.isArray(limits))
    for (const value of limits) {
      const raw = object(object(value).raw);
      const matches = member
        ? String(raw._rarity) === String(metadata.rarity) && String(raw._awakeCount) === String(row._awakeCount)
        : String(raw._group) === String(metadata.supportCardRankGroup) && String(raw._rank) === String(row._rank);
      const cap = Number(raw._limitLevel);
      if (matches && Number.isSafeInteger(cap) && cap > 0) return Math.min(result, cap);
    }
  return result;
}
