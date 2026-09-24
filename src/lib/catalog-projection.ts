export type CatalogJson = null | boolean | number | string | CatalogJson[] | { [key: string]: CatalogJson };
type RecordValue = { [key: string]: CatalogJson };
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const rows = (value: unknown): RecordValue[] => {
  const data = Array.isArray(value) ? value : record(value)._allData;
  return Array.isArray(data) ? data.map(record) : [];
};
export const catalogProjectionTables = (resource: string): string[] =>
  resource === "stories"
    ? ["MasterAdv", "MasterStoryEpisode"]
    : resource === "songs"
      ? ["MasterLiveMusic", "MasterText"]
      : [];
export function projectCatalogDocument(resource: string, input: unknown, tables: Record<string, unknown>): RecordValue {
  const document = record(input);
  if (resource === "stories") {
    const ids = new Map(
      rows(tables.MasterAdv).map((row) => [
        Number(row._id),
        String(row._advEpisodeAsset || "").replace(/^adv_script_/, ""),
      ]),
    );
    const episodes = { ...record(document.episodes) };
    for (const row of rows(tables.MasterStoryEpisode)) {
      const id = ids.get(Number(row._advId));
      if (!id || !Object.hasOwn(episodes, id)) continue;
      episodes[id] = {
        ...record(episodes[id]),
        isExtraEpisode: row._isExtraEpisode === true,
        isAnotherEpisode: row._isAnotherEpisode === true,
        perspectiveCharacterId: Number(row._characterId || 0),
        characterRank: Number(row._characterRank || 0),
      };
    }
    return { ...document, episodes };
  }
  if (resource === "songs") {
    const texts = new Map(rows(tables.MasterText).map((row) => [String(row._id), row]));
    const result = { ...document };
    for (const row of rows(tables.MasterLiveMusic)) {
      const id = String(row._id);
      if (!Object.hasOwn(result, id)) continue;
      const text = texts.get(String(row._bandNameTextID));
      if (!text) continue;
      const names = ["_japanese", "_english", "_traditionalChinese", "_simplifiedChinese", "_korean"].map((field) =>
        String(text[field] || ""),
      );
      if (!names.some(Boolean)) continue;
      result[id] = { ...record(result[id]), artistId: String(row._bandNameTextID), artistName: names, bandName: names };
    }
    return result;
  }
  return document;
}
