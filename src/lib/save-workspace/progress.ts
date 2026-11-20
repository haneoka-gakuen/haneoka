import { object, saveEntity, text, type Row, type SaveCatalog } from "./catalog";

const integer = (value: unknown) => /^\d+$/u.test(String(value ?? "")) ? BigInt(String(value)) : null;
const id = (value: unknown) => {
  const number = integer(value);
  return number !== null && number > 0n ? String(number) : "";
};
const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : Object.values(object(value)).map(object);
const characterId = (row: Row) => id(row._masterCharacterId ?? row._characterId ?? row.character_id ?? row.characterId ?? row._masterId);
const friendshipId = (row: Row) => id(row._masterCharacterFriendshipId ?? row._characterFriendshipId ?? row._friendshipId ?? row.friendship_id ?? row.friendshipId ?? row._masterId);

export interface SaveRank {
  level: string;
  experience: bigint | null;
  progress: number | null;
}

export interface SaveCharacter extends SaveRank {
  id: string;
  name: string;
  image: string;
  bandId: number;
}

export interface SaveFriendship extends SaveRank {
  id: string;
  characters: SaveCharacter[];
}

export interface SaveMission {
  id: string;
  name: string;
  description: string;
  received: boolean;
  completed: boolean;
  progress: bigint | null;
  target: bigint | null;
  value: string;
}

function rankThresholds(value: unknown) {
  return rows(value).flatMap(row => {
    const experience = integer(row.exp);
    const level = id(row.rank);
    return experience === null || !level ? [] : [{ level, experience }];
  }).sort((a, b) => a.experience < b.experience ? -1 : a.experience > b.experience ? 1 : Number(a.level) - Number(b.level));
}

function rank(row: Row | undefined, thresholds: ReturnType<typeof rankThresholds>): SaveRank {
  const experience = integer(row?._exp ?? row?.exp ?? row?._experience);
  const savedLevel = id(row?._level ?? row?.level ?? row?._rank ?? row?.rank);
  if (experience === null) return { level: savedLevel, experience, progress: null };
  const nextIndex = thresholds.findIndex(item => item.experience > experience);
  const current = nextIndex === -1 ? thresholds.at(-1) : thresholds[nextIndex - 1];
  const next = thresholds[nextIndex];
  const level = savedLevel || current?.level || "";
  if (!current || !next || current.level !== level)
    return { level, experience, progress: null };
  return {
    level,
    experience,
    progress: Number((experience - current.experience) * 1000n / (next.experience - current.experience)) / 10,
  };
}

function indexedRows(value: unknown, key: (row: Row) => string): Map<string, Row> {
  const entries = Array.isArray(value) ? value.map(row => ["", row] as const) : Object.entries(object(value));
  return new Map(entries.flatMap(([fallback, value]) => {
    const row = object(value);
    const index = key(row) || id(fallback);
    return index ? [[index, row] as const] : [];
  }));
}

function characterMissions(value: unknown, catalog: SaveCatalog | undefined, locale: string) {
  const master = indexedRows(catalog?.resources["character-missions"]?.missions, row => id(row.missionId ?? row.id));
  const result = new Map<string, SaveMission[]>();
  for (const [character, group] of indexedRows(value, characterId)) {
    const claims = group._receivedMissionIds ?? group._missionIds ?? group.missionIds ?? group.mission_ids;
    const received = new Set((Array.isArray(claims) ? claims : []).map(id).filter(Boolean));
    const progress = indexedRows(group._missions ?? group.missions ?? group._missionProgress, row => id(row._masterMissionId ?? row._missionId ?? row.missionId));
    for (const mission of received) if (!progress.has(mission)) progress.set(mission, {});
    result.set(character, [...progress].map(([mission, row]) => {
      const metadata = master.get(mission);
      const claimed = received.has(mission) || row._isReceived === true || row.isReceived === true;
      const current = integer(row._progress ?? row.progress ?? row._count);
      const target = integer(metadata?.achievementCount ?? row._achievementCount);
      return {
        id: mission,
        name: text(metadata?.title, locale),
        description: text(metadata?.description, locale),
        received: claimed,
        completed: claimed || row._isCompleted === true || row.isCompleted === true || (current !== null && target !== null && target > 0n && current >= target),
        progress: current,
        target,
        value: String(metadata?.value ?? ""),
      };
    }).sort((a, b) => Number(a.id) - Number(b.id)));
  }
  return result;
}

export function saveAccountProgress(player: Row, catalog: SaveCatalog | undefined, locale: string) {
  const thresholds = catalog?.resources.progression;
  const characterRanks = rankThresholds(thresholds?.characterRanks);
  const friendshipRanks = rankThresholds(thresholds?.friendshipRanks);
  const characters = indexedRows(player._characters, characterId);
  const friendships = indexedRows(player._characterFriendships, friendshipId);
  const missions = characterMissions(player._characterMissions, catalog, locale);
  const roster = Object.entries(catalog?.resources.characters ?? {})
    .filter(([, character]) => character.faceImage).map(([key]) => key);
  const partners = Object.values(catalog?.resources.friendships ?? {}).flatMap(row =>
    Array.isArray(row.characterIds) ? row.characterIds.map(id).filter(Boolean) : []);
  const characterKeys = new Set([...roster, ...partners, ...characters.keys(), ...missions.keys()]);
  const members = new Map([...characterKeys].map(key => {
    const row = saveEntity(catalog, "characters", key);
    return [key, {
      id: key,
      name: text(row.name ?? row.characterName, locale),
      image: typeof row.faceImage === "string" ? row.faceImage : "",
      bandId: Number(row.bandId ?? 0),
      ...rank(characters.get(key), characterRanks),
    }] as const;
  }));
  const pairs = [...new Set([...Object.keys(catalog?.resources.friendships ?? {}), ...friendships.keys()])].map(key => {
    const source = friendships.get(key);
    const row = saveEntity(catalog, "friendships", key);
    const pair = row.characterIds ?? source?.characterIds ?? [source?._masterCharacterIdA, source?._masterCharacterIdB];
    const ids = Array.isArray(pair) ? pair.map(id) : [];
    return {
      id: key,
      characters: ids.flatMap(key => members.get(key) ? [members.get(key)!] : []),
      ...rank(source, friendshipRanks),
    };
  });
  return { characters: [...members.values()], friendships: pairs, missions,
    playerRank: rank(player, rankThresholds(thresholds?.playerRanks)),
  };
}
