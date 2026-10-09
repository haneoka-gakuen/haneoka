/** Display/relationship participants are separate from the game's vocal and bonus fields. */
export type PerformerRecord = Record<string, unknown>;
export type PerformerGame = "our-notes" | "gbp";
export interface PerformerPortrait {
  key: string;
  provider: PerformerGame;
  server: string;
  sourceId?: string;
  id: number;
  name: unknown;
  image: string;
}
export interface PerformerRegistry {
  game: PerformerGame;
  server: string;
  sourceId?: string;
  bands: ReadonlyMap<number, PerformerRecord>;
  characters: ReadonlyMap<number, PerformerRecord>;
  /** Audited display portraits only. These never become local participant/filter IDs. */
  portraitFallbacks?: readonly PerformerPortrait[];
}
export interface SongPerformer {
  bandIds: number[];
  participantCharacterIds: number[];
  explicitCharacterIds: number[];
  portraits: PerformerPortrait[];
  names: unknown[];
  logos: Array<{ id: number; name: unknown; image: string }>;
  unresolvedNames: string[];
}

const ids = (value: unknown): number[] => [
  ...new Set(
    (Array.isArray(value) ? value : value === undefined ? [] : [value])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  ),
];
const texts = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && Boolean(v.trim()));
const key = (name: string) => name.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("ja");
const split = (value: unknown) =>
  texts(value).flatMap((name) =>
    name
      .split(/\s*[×＋+&＆]|\s+x\s+|\s+(?:feat\.?|with)\s+/iu)
      .map((name) => name.trim())
      .filter(Boolean),
  );
// Official BanG Dream news2067 explicitly identifies these five CRYCHIC members.
// Names are resolved separately against each game's real character registry.
const CRYCHIC = ["高松燈", "長崎そよ", "椎名立希", "若葉睦", "豊川祥子"];
const performerCache = new WeakMap<PerformerRegistry, WeakMap<PerformerRecord, SongPerformer>>();

export function resolveSongPerformer(song: PerformerRecord, registry: PerformerRegistry): SongPerformer {
  const cache = performerCache.get(registry) ?? new WeakMap<PerformerRecord, SongPerformer>();
  const existing = cache.get(song);
  if (existing) return existing;
  performerCache.set(registry, cache);
  const bandSet = new Set<number>();
  const explicit = new Set<number>();
  const participants = new Set<number>();
  const portraits = new Map<string, PerformerPortrait>();
  const names: unknown[] = [];
  const authoredNames: unknown[] = [];
  const unresolved = new Set<string>();
  const logos: SongPerformer["logos"] = [];
  const official = (band: PerformerRecord) =>
    registry.game === "our-notes" ? band.official !== false : band.official === true;
  const nameIds = (name: string, kind: "band" | "character") => {
    const records = [...(kind === "band" ? registry.bands : registry.characters)];
    const primary = records.filter(([, row]) =>
      texts(kind === "band" ? (row.bandName ?? row.name) : (row.characterName ?? row.name))
        .flatMap((value) => (kind === "character" ? value.split(/[／/]/u) : [value]))
        .some((v) => key(v) === key(name)),
    );
    const matches =
      primary.length || kind === "band"
        ? primary
        : records.filter(([, row]) => [row.firstName, row.nickname].flatMap(texts).some((v) => key(v) === key(name)));
    return matches.map(([id]) => id);
  };
  const addCharacter = (id: number, display = true, isExplicit = display) => {
    const row = registry.characters.get(id);
    if (!row) return;
    if (isExplicit && !participants.has(id)) names.push(row.characterName ?? row.name);
    participants.add(id);
    if (display) {
      if (isExplicit) explicit.add(id);
      const portrait: PerformerPortrait = {
        key: `${registry.game}:${registry.server}:${registry.sourceId ?? ""}:${id}`,
        provider: registry.game,
        server: registry.server,
        sourceId: registry.sourceId,
        id,
        name: row.characterName ?? row.name,
        image: String(row.faceImage ?? row.thumbnailImage ?? ""),
      };
      portraits.set(portrait.key, portrait);
    }
  };
  const addBand = (id: number) => {
    if (bandSet.has(id)) return;
    const row = registry.bands.get(id);
    if (!row || !official(row)) return;
    bandSet.add(id);
    names.push(row.bandName ?? row.name);
    const roster = ids(row.memberCharacterIds);
    for (const [characterId, character] of registry.characters)
      if (Number(character.bandId) === id) roster.push(characterId);
    const image = String(row.logo ?? row.icon ?? "");
    if (image) logos.push({ id, name: row.bandName ?? row.name, image });
    for (const characterId of new Set(roster)) addCharacter(characterId, !image, false);
  };
  const resolveName = (name: string, retainUnknown = true) => {
    if (key(name) === "crychic") {
      names.push("CRYCHIC");
      for (const member of CRYCHIC) {
        const candidates = nameIds(member, "character");
        if (candidates.length === 1) addCharacter(candidates[0]!, true, false);
        else {
          const fallback = registry.portraitFallbacks?.filter((p) => texts(p.name).some((v) => key(v) === key(member)));
          if (fallback?.length === 1) portraits.set(fallback[0]!.key, fallback[0]!);
          else unresolved.add(member);
        }
      }
      return;
    }
    const bands = nameIds(name, "band").filter((id) => official(registry.bands.get(id)!));
    if (bands.length === 1) {
      addBand(bands[0]!);
      return;
    }
    const chars = nameIds(name, "character");
    if (chars.length === 1) {
      addCharacter(chars[0]!);
      return;
    }
    if (retainUnknown) unresolved.add(name);
  };
  const direct = ids(song.bandIds ?? song.bandId);
  for (const id of direct) {
    const band = registry.bands.get(id);
    if (!band) continue;
    if (official(band)) {
      addBand(id);
      continue;
    }
    if (band.bandName ?? band.name) authoredNames.push(band.bandName ?? band.name);
    for (const member of ids(band.memberBandIds)) addBand(member);
    for (const member of ids(band.memberCharacterIds)) addCharacter(member);
    for (const name of texts(band.memberNames)) resolveName(name);
    // Credits in another authored language can resolve a source-language nickname.
    for (const name of split(band.bandName)) resolveName(name, false);
  }
  if (!direct.length) for (const name of split(song.artistName ?? song.bandName)) resolveName(name);
  const stated = ids(song.characterIds ?? song.characters ?? song.characterId);
  const vocals = ids(song.vocalCharacterIds);
  for (const id of [...stated, ...vocals]) {
    if (!participants.has(id)) addCharacter(id);
  }
  // A formal band's vocal subset does not shrink its participant roster or add duplicate faces.
  const result: SongPerformer = {
    bandIds: [...bandSet],
    participantCharacterIds: [...participants],
    explicitCharacterIds: [...explicit],
    portraits: [...portraits.values()],
    names: (unresolved.size && authoredNames.length ? authoredNames : [...names, ...unresolved]).filter(
      (name, index, values) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(name)) === index,
    ),
    logos,
    unresolvedNames: [...unresolved],
  };
  cache.set(song, result);
  return result;
}
