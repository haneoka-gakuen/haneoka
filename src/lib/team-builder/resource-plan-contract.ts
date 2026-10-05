import type {
  EvidenceGap, NativeEventScene, ReleaseIdentity, SearchConstraints, SkillOrderCriterion, TeamAssignment,
} from "./contracts.ts";
import type { TeamBuilderData } from "./data.ts";
import type { InventoryV1 } from "./inventory.ts";

export type ResourcePlanObjective = "event-points" | "event-items";
export interface ResourcePlanParameters {
  boostBudget: number;
  boostPerNormalPlay: number;
  initialChallengePoints: number;
  challengePointCost: number;
}
export interface ResourcePlannerPreparationInput {
  characterRankTotalScope?: import("./data/character-rank-total.ts").CharacterRankTotalScope;
  schema: "haneoka-resource-plan-request-v1";
  data: TeamBuilderData;
  inventory: InventoryV1;
  parameters: ResourcePlanParameters;
  objectives: ResourcePlanObjective[];
  skillOrderCriterion: SkillOrderCriterion;
  /** Items are one specified native resource, not a sum of unlike rewards. */
  itemResource?: { type: number; id: number };
  normal: {
    mode: "normal" | "gekiso";
    scene: NativeEventScene;
    charts: { songId: number; difficulty: number }[];
    constraints: SearchConstraints;
  };
  challenge: {
    mode: "normal" | "gekiso";
    scene: NativeEventScene;
    /** Native challenge wrapper identity is distinct from its parent song. */
    charts: { challengeMusicId: number; difficulty: number }[];
    constraints: SearchConstraints;
  };
  budget: ResourcePlannerBudget;
}
export interface ResourcePlannerBudget {
  maxPairs: number;
  maxMilliseconds: number;
  maxCycleStates: number;
  maxCycleTransitions: number;
}
export interface ResourcePlayOutcome {
  probability: number;
  /** Already ranked/rounded whole-play amounts. Unknown is never a zero reward. */
  eventPoints: number | null;
  eventItems: number | null;
  challengePoints: number | null;
}
export interface ResourceStageCandidate extends ReleaseIdentity {
  sourceId: string;
  kind: "normal" | "challenge";
  eventId: number;
  consumedCount: number;
  skillOrderCriterion: SkillOrderCriterion;
  itemResource?: { type: number; id: number };
  key: string;
  songKey: string;
  songId: number;
  difficulty: number;
  challengeMusicId?: number;
  assignment: TeamAssignment;
  power: number;
  outcomes: readonly ResourcePlayOutcome[];
  /** Factory publishes a law once the entire selected-criterion play is resolved. */
  completeLaw: boolean;
  gaps: EvidenceGap[];
  metricGaps: Partial<Record<ResourcePlanObjective | "challenge-points", EvidenceGap[]>>;
}
export interface ResolvedResourceStage {
  kind: "normal" | "challenge";
  candidates: readonly ResourceStageCandidate[];
  /** Exhaustive refers to the original requested legal card/chart domain. */
  completeness: "exhaustive" | "budget-limited" | "cancelled" | "unavailable";
  gaps: EvidenceGap[];
}
export interface ResolvedResourcePlannerInput extends ReleaseIdentity {
  sourceId: string;
  eventId: number;
  skillOrderCriterion: SkillOrderCriterion;
  schema: "haneoka-resolved-resource-plan-v1";
  parameters: ResourcePlanParameters;
  objectives: ResourcePlanObjective[];
  itemResource?: { type: number; id: number };
  normal: ResolvedResourceStage;
  challenge: ResolvedResourceStage;
  budget: ResourcePlannerBudget;
}
export interface ResourcePlanTotals {
  normalPlays: number;
  expectedChallengePlays: number;
  boostSpent: number;
  boostRemaining: number;
  expectedChallengePointsGained: number;
  expectedChallengePointsSpent: number;
  expectedChallengePointsRemaining: number;
  remainingChallengePoints: readonly { value: number; probability: number }[];
  /** Null when that axis has no complete native law. */
  eventPoints: number | null;
  eventItems: number | null;
}
export interface ResourcePlan {
  normal: ResourceStageCandidate;
  challenge: ResourceStageCandidate;
  totals: ResourcePlanTotals;
}
export interface ResourceObjectivePlans {
  best: ResourcePlan | null;
  /** Three different song IDs; each song owns its entire optimized stage pair. */
  top3: { normal: ResourcePlan[]; challenge: ResourcePlan[] };
  status: "proven" | "candidate" | "unavailable";
  gaps: EvidenceGap[];
  pairsEvaluated: number;
  /** Other reward axis is a tie-break only when every candidate has its complete law. */
  secondaryObjective: ResourcePlanObjective | null;
}
export interface ResourcePlannerResult {
  schema: "haneoka-resource-plan-result-v1";
  byObjective: Partial<Record<ResourcePlanObjective, ResourceObjectivePlans>>;
  completeness: "exhaustive" | "budget-limited" | "cancelled" | "unavailable";
  elapsedMs: number;
  pairsEvaluated: number;
  difference: { eventPointsLostWithItemPlan: number; eventItemsLostWithPointPlan: number } | null;
  scope: "fixed-normal-challenge-pair-requested-domain";
}
export interface ResourcePlannerProgress {
  phase: "pairs" | "complete";
  pairsEvaluated: number;
  totalPairs: number;
  /** Counts are actual evaluated complete cycles, never proof percent. */
  proofStatus: "candidate" | "proven" | "unavailable";
}

/** Captured account/revision/pin for stale-result rejection by the owning UI. */
export interface ResourcePlannerRunContext {
  ownerId: string | null;
  inventoryRevision: number;
  server: string;
  releaseId: string;
  sourceId: string;
}
/** Structural match for the established solver Worker protocol. */
export type ResourcePlanningProgress = ResourcePlannerProgress | { phase: "loading" } | {
  phase: "stage";
  kind: "normal" | "challenge";
  chartsCompleted: number;
  totalCharts: number;
  evaluated: number;
  retainedLaws: number;
};
export type ResourcePlannerRequest = { type: "resource-prepare"; runId: string; request: ResourcePlannerPreparationInput }
  | { type: "cancel"; runId: string };
export type ResourcePlannerResponse = { type: "resource-progress"; runId: string; progress: ResourcePlanningProgress }
  | { type: "resource-result"; runId: string; result: ResourcePlannerResult }
  | { type: "error"; runId: string; code: string };
