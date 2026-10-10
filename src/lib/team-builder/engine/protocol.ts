import type { TeamBuilderData } from "../data";
import type { EngineRequest, SongRef, TeamSpec } from "./api";
import type { MemberInput, SnapInput, UnknownPolicy } from "./box";
import type { PlayModel } from "./live";
import type { PlayerInput } from "./api";

export type EvaluateRequest = {
  inputIntent?: import("./input-eligibility").InputIntent;
  members: MemberInput[];
  snaps: SnapInput[];
  player: PlayerInput;
  unknownPolicy: UnknownPolicy;
  team: TeamSpec;
  songs: SongRef[];
  play: PlayModel;
  challengeEventId: number | null;
  event: { eventId: number; route: "live" | "challenge"; consumption: number } | null;
};
export type ExplainRequest = {
  inputIntent?: import("./input-eligibility").InputIntent;
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
  | { type: "run"; id: number; request: EngineRequest }
  | { type: "evaluate"; id: number; request: EvaluateRequest }
  | { type: "explain"; id: number; request: ExplainRequest }
  | { type: "charts"; id: number; songs: SongRef[] };
export type EngineReply =
  | { type: "ready"; id: number }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; message: string };
