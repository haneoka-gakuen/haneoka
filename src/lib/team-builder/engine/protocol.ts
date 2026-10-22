// L3 — GEB
// Input: 引擎请求／结果与配队数据类型。
// Output: EngineCall（含私有 deferScores、rewardPhase）、EngineReply、停止原因及 EngineSnapshot。
// Pos: [Map](L2-2.md)；主线程与当前引擎 Worker 的消息边界。
// Effects/Dependencies: 类型声明；资源获取与计算由 client／worker 实现。
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, Goal, SongRef, TeamSpec } from "./api";
import type { MemberInput, SnapInput, UnknownPolicy } from "./box";
import type { PlayModel } from "./live";
import type { PlayerInput } from "./api";

export type EvaluateRequest = {
  members: MemberInput[];
  snaps: SnapInput[];
  player: PlayerInput;
  unknownPolicy: UnknownPolicy;
  team: TeamSpec;
  songs: SongRef[];
  play: PlayModel;
  gekiso?: Pick<Extract<Goal, { kind: "gekiso" }>, "accuracy" | "rank" | "seeds">;
  challengeEventId: number | null;
  event: { eventId: number; route: "live" | "challenge"; consumption: number } | null;
};
export type ExplainRequest = {
  members: MemberInput[];
  snaps: SnapInput[];
  unknownPolicy: UnknownPolicy;
  team: TeamSpec;
  song: SongRef;
  eventOrder: string[];
  play: PlayModel;
};
export type EngineCall =
  | { type: "init"; id: number; data: TeamBuilderData }
  | { type: "run"; id: number; request: EngineRequest; deferScores?: boolean }
  | { type: "growth"; id: number; request: EngineRequest }
  | { type: "evaluate"; id: number; request: EvaluateRequest }
  | { type: "explain"; id: number; request: ExplainRequest }
  | { type: "charts"; id: number; songs: SongRef[] };
export type EngineReply =
  | { type: "phase"; id: number; phase: "network" | "computation" }
  | { type: "snapshot"; id: number; snapshot: EngineSnapshot }
  | { type: "ready"; id: number }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; message: string };

export type StopReason = "complete" | "budget" | "cancelled" | "error";
export interface EngineSnapshot {
  requestId: string;
  contextKey: string;
  response: EngineResponse;
  coverage: { completed: number; total: number };
  stopReason?: StopReason;
}
