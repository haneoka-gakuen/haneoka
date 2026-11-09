// L3 — GEB
// Input: 引擎请求／结果与配队数据类型。
// Output: EngineCall（含 UTF-8／字符串计算资料、编译模块、固定谱面载荷、私有评分缓存、排序下界与活动养成分页控制）、EngineReply（含养成更新、协作能力和 Worker 四张缓存身份）、停止原因及 EngineSnapshot。
// Pos: [Map](L2-2.md)；主线程与当前引擎 Worker 的消息边界。
// Effects/Dependencies: 类型声明；资源获取与计算由 client／worker 实现。
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, Goal, SongRef, TeamSpec, RewardFloor } from "./api";
import type { MemberInput, SnapInput, UnknownPolicy } from "./box";
import type { PlayModel } from "./live";
import type { PlayerInput } from "./api";
import type { EventTeamGrowthRequest, EventTeamSearchResult } from "../../event-team-analysis";

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
  event: { eventId: number; route: "live" | "challenge"; consumption: number; rewardRoom?: import("./api").RewardRoom; eventEffects?: readonly import("./master").EventEffectRow[] } | null;
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
  | { type: "init"; id: number; data: string | Uint8Array; charts: EngineChartSources; module: WebAssembly.Module }
  | { type: "run"; id: number; request: EngineRequest; deferScores?: boolean; scoredSeeds?: unknown[]; cooperativeFloor?: boolean; initialFloor?: number; initialReward?: RewardFloor }
  | { type: "floor"; id: number; value: number; reward?: RewardFloor }
  | { type: "growth"; id: number; request: EngineRequest }
  | { type: "eventGrowth"; id: number; request: EventTeamGrowthRequest; paused?: boolean }
  | { type: "eventGrowthPage"; id: number; page: number; paused?: boolean }
  | { type: "pauseEventGrowth"; id: number; paused: boolean }
  | { type: "evaluate"; id: number; request: EvaluateRequest }
  | { type: "explain"; id: number; request: ExplainRequest }
  | { type: "charts"; id: number; songs: SongRef[] }) & { loadedCharts?: EngineChart[] };
export type EngineReply =
  | { type: "phase"; id: number; phase: "network" | "computation" }
  | { type: "snapshot"; id: number; snapshot: EngineSnapshot }
  | { type: "eventGrowth"; id: number; result: EventTeamSearchResult }
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
