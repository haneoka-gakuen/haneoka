export const BESTDORI_CHARACTER_ICON_MAX_ID = 50;
export const BESTDORI_CATALOG_VERSION = "v23-character-identity";

export const hasBestdoriCharacterIcon = (characterId: unknown): boolean => {
  const id = Number(characterId);
  return Number.isInteger(id) && id > 0 && id <= BESTDORI_CHARACTER_ICON_MAX_ID;
};

export const normalizeBestdoriCharacterName = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/gu, "").replaceAll("ヴ", "ブ");

export function bestdoriCharacterAliases(characters: Record<string, unknown>): Map<string, number> {
  const candidates = new Map<string, { priority: number; ids: Set<number> }>();
  for (const [key, value] of Object.entries(characters)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const canonicalId = id === 601 ? 15 : id;
    for (const [index, field] of ["characterName", "firstName", "nickname"].entries()) {
      const name = Array.isArray(entry[field]) ? entry[field][0] : undefined;
      if (typeof name !== "string" || !name.trim() || name === "-") continue;
      const alias = normalizeBestdoriCharacterName(name);
      // A cast member's name takes precedence over an NPC's shared short name.
      const priority = (Number(entry.bandId) > 0 ? 10 : 0) + 3 - index;
      const previous = candidates.get(alias);
      if (!previous || priority > previous.priority) candidates.set(alias, { priority, ids: new Set([canonicalId]) });
      else if (priority === previous.priority) previous.ids.add(canonicalId);
    }
  }
  return new Map(
    [...candidates].flatMap(([name, candidate]) => (candidate.ids.size === 1 ? [[name, [...candidate.ids][0]!]] : [])),
  );
}

export function bestdoriAfterLiveCharacterIds(description: unknown, aliases: ReadonlyMap<string, number>): number[] {
  const japanese = Array.isArray(description) ? description[0] : description;
  if (typeof japanese !== "string") return [];
  const cast = normalizeBestdoriCharacterName(japanese).replace(/の(?:大成功(?:位)?|成功|失敗)会話\d*$/u, "");
  return [
    ...new Set(
      cast.split(/と|×/u).flatMap((name) => {
        const id = aliases.get(name);
        return id === undefined ? [] : [id];
      }),
    ),
  ];
}
