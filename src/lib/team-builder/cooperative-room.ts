// L3 — GEB
// Input: 当前账号的持久卡库、每席编队和演奏条件、固定区服版本、已保存的累计工作量。
// Output: 玩家可提交的卡库、按席位排序的阵容、固定样本均分与 SS 达标率、可继续的整房进度。
// Pos: [Map](L2-2.md)，激奏联机房与 Rust 联合搜索的浏览器接口。
// Effects/Dependencies: 读取固定版本资料和谱面，独占一个引擎 Worker，取消时释放。
import { throwIfAborted } from "../request-scope";
import type { TeamBuilderData } from "./data";
import { fetchTeamBuilderData } from "./data/fetch";
import type { ConstraintInput, SongRef, TeamSpec } from "./engine/api";
import type { MemberInput, PlayerInput, SnapInput, UnknownPolicy } from "./engine/box";
import { EngineClient } from "./engine/client";
import { readSkillRoleLimits } from "./skill-roles";
import { engineInputs, type BoxView, type OwnedMember, type OwnedSnap } from "./sync/box-view";

export interface RoomSettings {
  server: "jp" | "intl";
  releaseId: string;
  sourceId?: string;
  song: SongRef;
  objective: "meanScore" | "ssRate";
  sampling?: { seed: number; count: number; skillOrders: "fixed" | "uniform" };
}
export interface RoomPlayerOptions {
  difficulty: number;
  accuracy: { just: number; great: number; missEvery: number };
  constraints: ConstraintInput;
  unknownPolicy: UnknownPolicy;
  lockedTeam?: TeamSpec;
  seed?: number;
  orderIndex?: number;
}
export interface RoomPlayer extends RoomPlayerOptions {
  members: MemberInput[];
  snaps: SnapInput[];
  player: PlayerInput;
}
export type RoomSearchInput = Pick<RoomSettings, "song" | "objective" | "sampling"> & { players: RoomPlayer[] };
type Phase = "inventory" | "bounds" | "search" | "complete";
export interface RoomSearchSlice {
  release: string;
  searchId: number;
  stepWork: number;
  complete: boolean;
  phase: Phase;
  upperBound: number;
  evaluated: number | string;
  ss: { roomThreshold?: number };
  teams: { team: TeamSpec; power: number; score: number }[] | null;
  statistics: { meanTotal: number; meanScores: number[]; ssHits: number | null; ssRate: number | null } | null;
  sampleProgress: { sampleCount: number };
}
export interface RoomResult {
  phase: Phase;
  evaluated: number | string;
  upperBound: number;
  sampleCount: number;
  ssThreshold: number | null;
  teams: { leader: number; members: number[]; snaps: (number | null)[]; power: number; score: number; meanScore: number }[] | null;
  meanTotal: number | null;
  ssHits: number | null;
  ssRate: number | null;
}
export interface RoomCheckpoint { work: number; complete: boolean; result: RoomResult }

export function exportRoomPlayer(view: BoxView, options: RoomPlayerOptions): RoomPlayer {
  const { members, snaps } = engineInputs(view, true);
  const { leader, bindings, noSnaps, minMissionMembers, skillRoles, skillRoleMissions } = options.constraints;
  const limits = options.constraints;
  const participation = (owned: Iterable<OwnedMember | OwnedSnap>, prefix: "m" | "s", required: string[], excluded: string[]) => {
    const keys = new Set<string>(), locks = new Set(required), skipped = new Set(excluded);
    for (const card of owned) {
      const key = prefix + card.cardId;
      keys.add(key);
      if (!card.use) skipped.add(key);
      else if (card.lock) locks.add(key);
    }
    return { keys, required: [...locks], excluded: [...skipped].filter(key => keys.has(key)) };
  };
  const member = participation(view.members.values(), "m", limits.requiredMembers, limits.excludedMembers);
  const snap = participation(view.snaps.values(), "s", limits.requiredSnaps, limits.excludedSnaps);
  const locked = options.lockedTeam;
  // The workspace draft may refer to a planning card, even though it cannot enter an owned room seat.
  const usedMembers = [...member.required, leader, ...bindings.map(pair => pair[0]), ...(locked?.members ?? []), locked?.leader];
  const usedSnaps = [...snap.required, ...bindings.map(pair => pair[1]), ...(locked?.snaps ?? [])];
  if (usedMembers.some(key => key != null && !member.keys.has(key)) || usedSnaps.some(key => key != null && !snap.keys.has(key)))
    throw new Error("room-unowned-constraint");
  const constraints: ConstraintInput = {
    requiredMembers: member.required, requiredSnaps: snap.required,
    excludedMembers: member.excluded, excludedSnaps: snap.excluded,
    leader, bindings: bindings.map(([member, snap]) => [member, snap]), noSnaps, minBonusPercent: null,
    ...(minMissionMembers ? { minMissionMembers: [...minMissionMembers] as [number, number, number] } : {}),
    ...(skillRoles ? { skillRoles: readSkillRoleLimits(skillRoles) } : {}),
    ...(skillRoleMissions ? { skillRoleMissions: [...skillRoleMissions] } : {}),
  };
  const { characterRanks, characterTotalRank, bandItems, vipRank, characterMemory, musicMemory } = view.player;
  const { just, great, missEvery } = options.accuracy;
  return {
    members, snaps, constraints,
    player: { characterRanks: { ...characterRanks }, characterTotalRank, bandItems: { ...bandItems }, vipRank,
      characterMemory: { ...characterMemory }, musicMemory: { ...musicMemory } },
    unknownPolicy: options.unknownPolicy, difficulty: options.difficulty, accuracy: { just, great, missEvery },
    ...(locked ? { lockedTeam: { leader: locked.leader, members: [...locked.members], snaps: [...locked.snaps] } } : {}),
    ...(options.orderIndex !== undefined ? { orderIndex: options.orderIndex } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
}

export function assertRoomRelease(data: TeamBuilderData, settings: RoomSettings): void {
  const { server, releaseId, sourceId } = data.identity;
  if (server !== settings.server || releaseId !== settings.releaseId || settings.sourceId && sourceId !== settings.sourceId)
    throw new Error("room-release-mismatch");
}

/** The normal workspace can merge both servers or include planning cards. A room uses its immutable public catalog. */
async function roomData(data: TeamBuilderData, settings: RoomSettings, signal: AbortSignal): Promise<TeamBuilderData> {
  if (data.identity.server !== settings.server) throw new Error("room-release-mismatch");
  if (!data.crossServer && data.identity.releaseId === settings.releaseId) {
    assertRoomRelease(data, settings);
    return data;
  }
  const sourceId = settings.sourceId ?? (data.identity.releaseId === settings.releaseId ? data.identity.sourceId : undefined);
  if (!sourceId) throw new Error("room-release-mismatch");
  const pinned = await fetchTeamBuilderData(settings.server, signal, fetch, { server: settings.server, releaseId: settings.releaseId, sourceId });
  assertRoomRelease(pinned, settings);
  return pinned;
}

function roomResult(slice: RoomSearchSlice, cards: { members: Map<string, number>; snaps: Map<string, number> }[]): RoomResult {
  const { phase, evaluated, upperBound, statistics } = slice;
  const id = (keys: Map<string, number>, key: string) => {
    const value = keys.get(key);
    if (value === undefined) throw new Error("room-result-card-missing");
    return value;
  };
  return {
    phase, evaluated, upperBound, sampleCount: slice.sampleProgress.sampleCount, ssThreshold: slice.ss.roomThreshold ?? null,
    teams: slice.teams?.map(({ team, power, score }, index) => {
      const seat = cards[index]!;
      return { leader: id(seat.members, team.leader), members: team.members.map(key => id(seat.members, key)),
        snaps: team.snaps.map(key => key === null ? null : id(seat.snaps, key)), power, score, meanScore: statistics!.meanScores[index]! };
    }) ?? null,
    meanTotal: statistics?.meanTotal ?? null, ssHits: statistics?.ssHits ?? null, ssRate: statistics?.ssRate ?? null,
  };
}

/** A new browser session reconstructs the native cursor from the same seat order and seed up to the saved unit count. */
export async function* runRoomSearch(data: TeamBuilderData, settings: RoomSettings, players: RoomPlayer[], resumeWork: number,
  signal: AbortSignal): AsyncGenerator<RoomCheckpoint> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(resumeWork) || resumeWork < 0) throw new Error("invalid-room-checkpoint");
  const pinned = await roomData(data, settings, signal);
  throwIfAborted(signal);
  const cards = players.map(player => ({ members: new Map(player.members.map(card => [card.key, card.cardId])),
    snaps: new Map(player.snaps.map(card => [card.key, card.cardId])) }));
  const engine = new EngineClient(pinned, undefined, { maxWorkers: 1 });
  const dispose = () => engine.dispose();
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const { song, objective, sampling } = settings;
    let work = 0;
    let slice = await engine.roomSearchStart({ song, objective, ...(sampling ? { sampling } : {}), players }, 0, 0);
    while (true) {
      throwIfAborted(signal);
      if (slice.release !== settings.releaseId) throw new Error("room-release-mismatch");
      work += slice.stepWork;
      if (!Number.isSafeInteger(work) || slice.complete && work < resumeWork) throw new Error("invalid-room-checkpoint");
      if (work > resumeWork || slice.complete) yield { work, complete: slice.complete, result: roomResult(slice, cards) };
      if (slice.complete) return;
      throwIfAborted(signal);
      const budget = work < resumeWork ? Math.min(16384, resumeWork - work) : 16384;
      slice = await engine.roomSearchStep(slice.searchId, budget, 160);
      if (slice.stepWork === 0 && !slice.complete) throw new Error("room-search-stalled");
    }
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}
