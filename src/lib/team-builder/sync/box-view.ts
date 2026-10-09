/** Typed reads of box entries: owned cards, account bonuses, saved teams, engine inputs. */
import type { BoxEntry, BoxValue } from "./box-doc";
import type { MemberInput, SnapInput } from "../engine/box";
import type { PlayerInput } from "../engine/api";

type Entries = Readonly<Record<string, BoxEntry>>;
export interface OwnedMember {
  cardId: number;
  use: boolean;
  lock: boolean;
  level: number | null;
  awake: number | null;
  rank: number | null;
  skill: number | null;
  gekisoSkill: number | null;
}
export interface OwnedSnap {
  cardId: number;
  use: boolean;
  lock: boolean;
  level: number | null;
  rank: number | null;
}
export interface SavedTeam {
  id: string;
  name: string;
  members: number[];
  snaps: (number | null)[];
  leader: number | null;
  song?: { songId: number; difficulty: number } | null;
  note?: string;
  createdAt: number;
}
export interface BoxView {
  members: Map<number, OwnedMember>;
  snaps: Map<number, OwnedSnap>;
  player: PlayerInput;
  bandRanks: Record<string, number | null>;
  teams: SavedTeam[];
  prefs: Record<string, unknown>;
}

const num = (value: BoxValue | undefined) => (typeof value === "number" ? value : null);
export function readBox(entries: Entries): BoxView {
  const members = new Map<number, OwnedMember>();
  const snaps = new Map<number, OwnedSnap>();
  const player: PlayerInput = { characterRanks: {}, characterTotalRank: null, bandItems: {}, vipRank: null, characterMemory: {}, musicMemory: {} };
  const bandRanks: Record<string, number | null> = {};
  const teams: SavedTeam[] = [];
  const prefs: Record<string, unknown> = {};
  const memberOf = (id: number) => {
    let row = members.get(id);
    if (!row) members.set(id, (row = { cardId: id, use: true, lock: false, level: null, awake: null, rank: null, skill: null, gekisoSkill: null }));
    return row;
  };
  const snapOf = (id: number) => {
    let row = snaps.get(id);
    if (!row) snaps.set(id, (row = { cardId: id, use: true, lock: false, level: null, rank: null }));
    return row;
  };
  const owned = { m: new Set<number>(), s: new Set<number>() };
  for (const [key, entry] of Object.entries(entries)) {
    const parts = key.split(".");
    const head = parts[0]!;
    if (head === "m" || head === "s") {
      const id = Number(parts[1]);
      const field = parts[2]!;
      if (field === "own") {
        if (entry.v === true) owned[head].add(id);
        continue;
      }
      if (head === "m") {
        const row = memberOf(id);
        if (field === "use") row.use = entry.v !== false;
        else if (field === "lock") row.lock = entry.v === true;
        else if (field === "lvl") row.level = num(entry.v);
        else if (field === "awk") row.awake = num(entry.v);
        else if (field === "rnk") row.rank = num(entry.v);
        else if (field === "sk") row.skill = num(entry.v);
        else if (field === "gsk") row.gekisoSkill = num(entry.v);
      } else {
        const row = snapOf(id);
        if (field === "use") row.use = entry.v !== false;
        else if (field === "lock") row.lock = entry.v === true;
        else if (field === "lvl") row.level = num(entry.v);
        else if (field === "rnk") row.rank = num(entry.v);
      }
    } else if (head === "cr") player.characterRanks[parts[1]!] = num(entry.v);
    else if (head === "bi") player.bandItems[parts[1]!] = num(entry.v);
    else if (head === "br") bandRanks[parts[1]!] = num(entry.v);
    else if (head === "cm") player.characterMemory[parts[1]!] = num(entry.v);
    else if (head === "mm") player.musicMemory[parts[1]!] = num(entry.v);
    else if (key === "p.vip") player.vipRank = num(entry.v);
    else if (key === "p.total") player.characterTotalRank = num(entry.v);
    else if (head === "team" && entry.v && typeof entry.v === "object" && !Array.isArray(entry.v)) {
      const value = entry.v as Record<string, unknown>;
      teams.push({
        id: parts.slice(1).join("."),
        name: String(value.name ?? ""),
        members: Array.isArray(value.members) ? value.members.map(Number) : [],
        snaps: Array.isArray(value.snaps) ? value.snaps.map((item) => (item === null ? null : Number(item))) : [],
        leader: typeof value.leader === "number" ? value.leader : null,
        song: value.song && typeof value.song === "object" ? (value.song as SavedTeam["song"]) : null,
        note: typeof value.note === "string" ? value.note : undefined,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : entry.t,
      });
    } else if (head === "pref") prefs[parts.slice(1).join(".")] = entry.v;
  }
  for (const id of [...members.keys()]) if (!owned.m.has(id)) members.delete(id);
  for (const id of [...snaps.keys()]) if (!owned.s.has(id)) snaps.delete(id);
  for (const id of owned.m) memberOf(id);
  for (const id of owned.s) snapOf(id);
  teams.sort((a, b) => b.createdAt - a.createdAt);
  return { members, snaps, player, bandRanks, teams, prefs };
}

/** Engine inputs for the cards taking part (or all owned when `all`). */
export function engineInputs(view: BoxView, all = false): { members: MemberInput[]; snaps: SnapInput[] } {
  return {
    members: [...view.members.values()]
      .filter((row) => all || row.use)
      .map((row) => ({
        key: `m${row.cardId}`,
        cardId: row.cardId,
        level: row.level,
        awake: row.awake,
        rank: row.rank,
        liveSkillLevel: row.skill,
        gekisoSkillLevel: row.gekisoSkill,
      })),
    snaps: [...view.snaps.values()]
      .filter((row) => all || row.use)
      .map((row) => ({ key: `s${row.cardId}`, cardId: row.cardId, level: row.level, rank: row.rank })),
  };
}
export const memberKey = (cardId: number) => `m${cardId}`;
export const snapKey = (cardId: number) => `s${cardId}`;
export const cardIdOf = (key: string) => Number(key.slice(1));

/** Changes that add a member or snap with the given growth. */
export function ownMemberChanges(cardId: number, growth: Partial<Omit<OwnedMember, "cardId">>) {
  const changes: { key: string; value: BoxValue }[] = [{ key: `m.${cardId}.own`, value: true }];
  const fields: [Exclude<keyof OwnedMember, "cardId">, string][] = [["use", "use"], ["lock", "lock"], ["level", "lvl"], ["awake", "awk"], ["rank", "rnk"], ["skill", "sk"], ["gekisoSkill", "gsk"]];
  for (const [field, key] of fields) if (field in growth) changes.push({ key: `m.${cardId}.${key}`, value: growth[field] as BoxValue });
  return changes;
}
export function ownSnapChanges(cardId: number, growth: Partial<Omit<OwnedSnap, "cardId">>) {
  const changes: { key: string; value: BoxValue }[] = [{ key: `s.${cardId}.own`, value: true }];
  const fields: [Exclude<keyof OwnedSnap, "cardId">, string][] = [["use", "use"], ["lock", "lock"], ["level", "lvl"], ["rank", "rnk"]];
  for (const [field, key] of fields) if (field in growth) changes.push({ key: `s.${cardId}.${key}`, value: growth[field] as BoxValue });
  return changes;
}
