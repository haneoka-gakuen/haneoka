// L3 — GEB
// Input: 引擎请求／结果与配队数据类型。
// Output: EngineCall（含编译模块、固定谱面载荷、私有评分缓存及标量／奖励排序下界）、EngineReply（含协作能力和 Worker 四张缓存身份）、停止原因及 EngineSnapshot。
// Pos: [Map](L2-2.md)；主线程与当前引擎 Worker 的消息边界。
// Effects/Dependencies: 类型声明；资源获取与计算由 client／worker 实现。
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, Goal, SongRef, TeamSpec, RewardFloor } from "./api";
import type { MemberInput, SnapInput, UnknownPolicy } from "./box";
import type { PlayModel } from "./live";
import type { PlayerInput } from "./api";

export type EvaluateRequest = {
  songRules?: import("../arena").SongRules;
  members: MemberInput[];
  snaps: SnapInput[];
  player: PlayerInput;
  unknownPolicy: UnknownPolicy;
  team: TeamSpec;
  songs: SongRef[];
  play: PlayModel;
  gekiso?: Pick<Extract<Goal, { kind: "gekiso" }>, "accuracy" | "rank" | "ranks" | "seeds" | "arena" | "minJustWindowMs">;
  challengeEventId: number | null;
  event: { eventId: number; route: "live" | "challenge"; consumption: number; eventEffects?: readonly import("./master").EventEffectRow[] } | null;
};
export type ExplainRequest = {
  songRules?: import("../arena").SongRules;
  arena?: import("./api").ArenaGoal;
  members: MemberInput[];
  snaps: SnapInput[];
  unknownPolicy: UnknownPolicy;
  team: TeamSpec;
  song: SongRef;
  eventOrder: string[];
  play: PlayModel;
  /** Normal lives: the evaluation context for the order's best judgement timing. */
  timing?: { player: PlayerInput; play: PlayModel; challengeEventId: number | null };
};
export type EngineChartSources = Record<string, { identity: TeamBuilderData["identity"]; file: string; apiBase?: string }>;
export type EngineChart = { song: SongRef; chart: Record<string, unknown> };
export type EngineCall = (
  | { type: "init"; id: number; data: string; charts: EngineChartSources; module: WebAssembly.Module }
  | { type: "run"; id: number; request: EngineRequest; deferScores?: boolean; scoredSeeds?: unknown[]; cooperativeFloor?: boolean; initialFloor?: number; initialReward?: RewardFloor }
  | { type: "floor"; id: number; value: number; reward?: RewardFloor }
  | { type: "growth"; id: number; request: EngineRequest }
  | { type: "evaluate"; id: number; request: EvaluateRequest }
  | { type: "explain"; id: number; request: ExplainRequest }
  | { type: "charts"; id: number; songs: SongRef[] }) & { loadedCharts?: EngineChart[] };
export type EngineReply =
  | { type: "phase"; id: number; phase: "network" | "computation" }
  | { type: "snapshot"; id: number; snapshot: EngineSnapshot }
  | { type: "ready"; id: number; cooperativeFloor?: boolean; cooperativeReward?: boolean }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "result"; id: number; result: unknown; scoredSeeds?: unknown[]; cachedCharts?: string[] }
  | { type: "error"; id: number; message: string };

export type StopReason = "complete" | "budget" | "cancelled" | "error";
export interface EngineSnapshot {
  requestId: string;
  contextKey: string;
  response: EngineResponse;
  coverage: { completed: number; total: number };
  stopReason?: StopReason;
}
