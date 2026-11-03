// L3 — GEB
// Input: Frozen engine inputs, a formation and the growth items proposed for one card.
// Output: Temporary growth scenarios and constrained requests for the same native goal.
// Pos: [Map](L2-2.md); growth comparison request projection, not a scoring implementation.
// Effects/Dependencies: No Box writes; preserves the source's candidates and scoring conditions.
import type { EngineHit, EngineRequest } from "./engine/api";
import { maxMemberGrowth, maxSnapGrowth, type MemberInput } from "./engine/box";
import type { EngineMaster } from "./engine/master";
import { memberLevelCap, snapLevelCap } from "./engine/power";
import type { GrowthAction } from "../growth-comparison";

export interface TeamGrowthChoice {
  kind: "members" | "snaps";
  key: string;
  /** Growth items raised together; each goes one stage up, or to its maximum. */
  actions: GrowthAction[];
  target: "next" | "cap";
}
export const teamGrowthActions = (kind: TeamGrowthChoice["kind"]): GrowthAction[] =>
  kind === "members" ? ["level", "training", "awakening", "live", "gekisou"] : ["level", "break"];
/** Stage items first: training and limit break set the level cap. */
const APPLY_ORDER: GrowthAction[] = ["training", "break", "awakening", "live", "gekisou", "level"];
export const teamGrowthFields = {
  level: "level",
  training: "awake",
  awakening: "rank",
  live: "liveSkillLevel",
  gekisou: "gekisoSkillLevel",
  break: "rank",
} as const;
export interface TeamGrowthStep {
  action: GrowthAction;
  from: number | null;
  to: number;
}
export interface TeamGrowthChange {
  status: "ready" | "missing-state" | "missing-data" | "at-cap" | "invalid-state";
  steps: TeamGrowthStep[];
  request: EngineRequest | null;
}

/** A new search must not inherit completed results, scores, floors or an expired deadline. */
export function freshGrowthRequest(source: EngineRequest): EngineRequest {
  return structuredClone({
    members: source.members,
    snaps: source.snaps,
    player: source.player,
    unknownPolicy: source.unknownPolicy,
    goal: source.goal,
    constraints: source.constraints,
    aggregation: source.aggregation,
    songRules: source.songRules,
    k: 1,
    timeLimitMs: source.timeLimitMs,
  });
}

export function teamGrowthChange(
  master: EngineMaster,
  source: EngineRequest,
  choice: TeamGrowthChoice,
): TeamGrowthChange {
  const result: TeamGrowthChange = { status: "missing-data", steps: [], request: null };
  const row = source[choice.kind].find((row) => row.key === choice.key);
  if (!row) return result;
  const member = choice.kind === "members" ? master.members.get(row.cardId) : undefined;
  const snap = choice.kind === "snaps" ? master.snaps.get(row.cardId) : undefined;
  if (!member && !snap) return result;
  const allowed = teamGrowthActions(choice.kind);
  const actions = APPLY_ORDER.filter((action) => choice.actions.includes(action) && allowed.includes(action));
  if (!actions.length) return result;
  const max = (member ? maxMemberGrowth(master, member) : maxSnapGrowth(master, snap!)) as Omit<MemberInput, "key" | "cardId">;
  const values = { ...(row as MemberInput) };
  const steps: TeamGrowthStep[] = [];
  for (const action of actions) {
    const field = teamGrowthFields[action];
    const from = values[field];
    if (from == null && choice.target === "next") return { ...result, status: "missing-state" };
    let cap = max[field]!;
    if (action === "level") {
      const stage = member ? values.awake : values.rank;
      if (stage === null && choice.target === "next") return { ...result, status: "missing-state" };
      cap = member ? memberLevelCap(master, member, stage ?? max.awake!) : snapLevelCap(master, snap!, stage ?? max.rank!);
    }
    if (from != null && (!Number.isInteger(from) || from < 1 || from > cap)) return { ...result, status: "invalid-state" };
    // An unentered value already counts as its maximum under the "max" policy.
    if (from === cap || (from == null && source.unknownPolicy === "max")) continue;
    const to = choice.target === "cap" ? cap : from! + 1;
    values[field] = to;
    steps.push({ action, from, to });
  }
  if (!steps.length) return { ...result, status: "at-cap" };
  const request = freshGrowthRequest(source);
  Object.assign(request[choice.kind].find((row) => row.key === choice.key)!, Object.fromEntries(steps.map((step) => [teamGrowthFields[step.action], step.to])));
  return { status: "ready", steps, request };
}

/** All five bindings include empty slots, so a fixed comparison cannot fill or swap a Snapshot. */
export function fixedGrowthRequest(
  source: EngineRequest,
  team: Pick<EngineHit, "song" | "members" | "snaps" | "aggregate">,
): EngineRequest {
  const request = freshGrowthRequest(source);
  request.timeLimitMs = null;
  request.members = team.members.map((key) => request.members.find((row) => row.key === key)!);
  request.snaps = request.snaps.filter((row) => team.snaps.includes(row.key));
  request.constraints = {
    requiredMembers: [...team.members],
    excludedMembers: [],
    requiredSnaps: team.snaps.filter((key): key is string => key !== null),
    excludedSnaps: [],
    leader: team.members[0]!,
    bindings: team.members.map((key, index) => [key, team.snaps[index] ?? null]),
    noSnaps: team.snaps.every((key) => key === null),
    minBonusPercent: null,
  };
  if (request.goal.kind === "plan") throw new Error("growth-plan-needs-route");
  if ("songs" in request.goal)
    request.goal.songs = team.aggregate
      ? team.aggregate.songs.map((hit) => ({ ...hit.song! }))
      : team.song ? [{ ...team.song }] : [];
  if (request.goal.kind === "power") request.goal.song = team.song;
  return request;
}
