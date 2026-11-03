// L3 — GEB
// Input: 手动阵容、实际评分输入与完整逐曲评价。
// Output: 冻结的结果来源、共用详情候选与独立基准快照。
// Pos: [Map](../L2-2.md)；手动评分与自动结果展示之间的适配。
// Effects/Dependencies: 按评价对象保留页面内结果上下文；不修改 Box 或自动搜索结果。
import type { EngineHit, EngineRequest, Goal, TeamEvaluation } from "../../lib/team-builder/engine/api";
import type { ManualTeam, TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { manualResultSource, registerManualResult, resultOrderIndex } from "./score-goal";
import { ORDERS } from "../../lib/team-builder/engine/order-equivalence";

const hits = new WeakMap<TeamEvaluation, EngineHit>();
export const manualResultHit = (row: TeamEvaluation) => hits.get(row)!;
const preferences = new WeakMap<TeamBuilder, { scope: string; orders: Map<string, number[]> }>();
function orderPreferences(host: TeamBuilder) {
  const scope = JSON.stringify([host.snapshot?.owner, host.data?.identity, host.data?.crossServer?.identities]);
  let value = preferences.get(host);
  if (!value || value.scope !== scope) {
    value = { scope, orders: new Map() };
    preferences.set(host, value);
  }
  return value.orders;
}
export const clearManualOrders = (host: TeamBuilder) => orderPreferences(host).clear();
export function seedManualOrder(host: TeamBuilder, hit: EngineHit) {
  const index = resultOrderIndex(host, hit);
  clearManualOrders(host);
  if (hit.song) orderPreferences(host).set(`${hit.song.songId}:${hit.song.difficulty}`, [...ORDERS[index]!]);
}

export function manualResultRequest(host: TeamBuilder, team: ManualTeam, goal: Goal): EngineRequest {
  const inputs = host.manualInputs(team);
  const members = team.members.map((id) => `m${id}`);
  const snaps = team.snaps.map((id) => (id === null ? null : `s${id}`));
  return structuredClone({
    ...inputs,
    player: host.view!.player,
    songRules: host.songRules(goal),
    goal,
    constraints: {
      requiredMembers: members,
      requiredSnaps: snaps.filter((key): key is string => key !== null),
      excludedMembers: [],
      excludedSnaps: [],
      leader: members[team.leader]!,
      bindings: members.map((key, index): [string, string | null] => [key, snaps[index] ?? null]),
      noSnaps: false,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs: null,
  });
}

export function manualResultSettings(host: TeamBuilder, goal: Goal): BuildSettings {
  return structuredClone({
    ...host.searchSettings,
    goal: goal.kind,
    criterion: "mean",
    scoreTiming: "nominal",
    scoreTarget: "none",
    aggregation: "individual",
    gekisoPlacementMode: "rank",
    eventId: goal.kind === "score" ? goal.challengeEventId : null,
    challengeRules: goal.kind === "score" && goal.challengeEventId !== null,
    route: goal.kind === "score" && goal.challengeEventId !== null ? "challenge" : "live",
    songs: "songs" in goal ? goal.songs : [],
  });
}

export function attachManualResults(
  host: TeamBuilder,
  rows: TeamEvaluation[],
  team: ManualTeam,
  input: EngineRequest,
  settings: BuildSettings,
  previous?: TeamEvaluation[],
): TeamEvaluation[] {
  const slots = [team.leader, ...[0, 1, 2, 3, 4].filter((slot) => slot !== team.leader)];
  const session = crypto.randomUUID();
  const choices = orderPreferences(host);
  for (const row of rows) {
    const key = `${row.song.songId}:${row.song.difficulty}`;
    const hit: EngineHit = {
      song: row.song,
      members: slots.map((slot) => `m${team.members[slot]}`),
      snaps: slots.map((slot) => (team.snaps[slot] === null ? null : `s${team.snaps[slot]}`)),
      power: row.power,
      slotPowers: row.slotPowers,
      key: row.score.mean,
      score: row.score,
      skipScore: settings.goal === "gekiso" ? null : row.skipScore,
      justWindow: row.justWindow,
      event: null,
      potential: null,
    };
    const prior = previous?.find(
      (candidate) => candidate.song.songId === row.song.songId && candidate.song.difficulty === row.song.difficulty,
    );
    const choice = choices.get(key);
    const selectedOrder = prior
      ? manualResultSource(manualResultHit(prior))!.selectedOrder
      : choice
        ? ORDERS.findIndex((order) => order.every((slot, event) => slots[slot] === choice[event]))
        : row.score.orders.reduce((best, value, index, values) => (value > values[best]! ? index : best), 0);
    hits.set(row, hit);
    registerManualResult(hit, {
      input,
      settings,
      session,
      selectedOrder,
      onOrderChange: previous
        ? undefined
        : (order) =>
            choices.set(
              key,
              ORDERS[order]!.map((slot) => slots[slot]!),
            ),
    });
  }
  return rows;
}

export function snapshotManualResults(rows: TeamEvaluation[]): TeamEvaluation[] {
  return rows.map((row) => {
    const copy = structuredClone(row);
    const hit = structuredClone(manualResultHit(row));
    hits.set(copy, hit);
    registerManualResult(hit, { ...manualResultSource(manualResultHit(row))!, onOrderChange: undefined });
    return copy;
  });
}

export function manualOrderScore(row: TeamEvaluation): number | undefined {
  const hit = manualResultHit(row);
  return row.score.orders[manualResultSource(hit)!.selectedOrder];
}
