import type { TeamBuilderData } from "./data.ts";
import type { InventoryV1 } from "./inventory.ts";
import type { NativeGekisoPlans, NativeGekisoSongPlan } from "./solver/native-gekiso-evaluation.ts";
import type { ResourcePlannerPreparationInput, ResourcePlannerProgress, ResourcePlannerResult } from "./resource-plan-contract.ts";
import type { ResourceStagePreparationProgress } from "./solver/native-challenge-stage-adapter.ts";
import type { NativePracticalPreparationInput, NativePracticalProgress, NativePracticalResult } from "./solver/native-practical-search.ts";
/** Serializable inputs shared by the inventory adapter, solver worker and UI. */
export interface ReleaseIdentity {
  server: string;
  releaseId: string;
  /** Source producer's related-method/ABI/selected-patch audit, independent of resource release. */
  nativeRuleEvidence?: NativeRuleEvidence;
}
export type NativeRuleDomain =
  "normal-score" | "personal-solo" | "ordinary-event-points" | "snapshot-equip" | "challenge-context";
export interface NativeRuleEvidence {
  schema: "haneoka-native-rule-evidence-v1";
  sourceId: string;
  /** Hashes identify the audited rule inputs; package version is provenance, not the rule selector. */
  nativeFiles: { il2cpp: string; metadata: string; loader: string };
  selectedPatches: { address: string; sha256: string | null }[];
  patchSelection: "complete" | "unresolved";
  domains: Partial<
    Record<
      NativeRuleDomain,
      {
        profile: string;
        methodFingerprint: string;
        abiFingerprint: string;
        callGraph: "reviewed" | "unresolved";
        patchCoverage: "disjoint" | "equivalent" | "unresolved";
      }
    >
  >;
}
export type Objective = "score" | "ss-ratio" | "ss-surplus" | "event-points" | "event-items" | "base-score";
export type PlayMode = "normal" | "gekiso" | "multi" | "battle";
export type SkillOrderCriterion = "nominal-mean" | "worst-ap" | "best-ap";
export type PersonalScoreDomain = "personal-solo" | "personal-live";
export interface EvidenceGap {
  code: string;
  source: string;
}

export type EvaluationBasisRequest =
  | { kind: "single" }
  | { kind: "time"; secondsBySong: Record<string, number>; downtimeSeconds: number; source: string }
  | { kind: "consumption"; amount: number; resource: "live-boost" | "event-item" | "challenge-point"; source: string };
export interface EvaluationBasis {
  kind: EvaluationBasisRequest["kind"];
  denominator: number | null;
  unit: "play" | "second" | "live-boost" | "event-item" | "challenge-point";
  source: string;
}
export interface MetricBreakdownEntry {
  key: string;
  value: number | null;
  unit: "score" | "power" | "count";
  source: string;
}
export interface TargetCapability {
  mode: PlayMode;
  objective: Objective;
  supported: boolean;
  bases: EvaluationBasisRequest["kind"][];
  gaps: EvidenceGap[];
  /** Input conditions for a factory that supports a calibrated subset. */
  conditions?: string[];
  /** Gekiso score uses the explicitly selected personal ledger. */
  scoreDomain?: "personal-solo";
  scoreDomains?: PersonalScoreDomain[];
  scoreDomainConditions?: Partial<Record<PersonalScoreDomain, string[]>>;
  skillOrderCriteria?: SkillOrderCriterion[];
}
export interface TeamBuilderCapabilities extends ReleaseIdentity {
  targets: TargetCapability[];
}

export interface MetricValue {
  value: number | null;
  status: "verified" | "conditional" | "unavailable";
  /** Raw per-play amount, before an explicitly selected efficiency denominator. */
  perPlayValue?: number | null;
  basis?: EvaluationBasis;
  breakdown?: MetricBreakdownEntry[];
  /** Bounds over the nominal native member-shuffle orders, in this metric's units. */
  range?: { minimum: number; maximum: number };
  /** Members bound to original chart event indices for the highest-scoring order. */
  bestSkillOrder?: string[];
  worstSkillOrder?: string[];
  skillOrderCriterion?: SkillOrderCriterion;
  scoreDomain?: "personal-solo" | "personal-live";
  assumptions: string[];
  gaps: EvidenceGap[];
}
export interface PowerStats {
  performance: number;
  technique: number;
  visual: number;
}
/** Adapter resolves the player's actual levels; no implicit maximum training. */
export interface MemberOption {
  instanceId: string;
  cardId: number;
  characterId: number;
  bandId: number;
  attribute: number;
  stats: PowerStats;
  leaderSkillId?: number;
  leaderSkillLevel?: number;
  /** CardPower stores 1 point as 10,000 integer BP units. */
  bpPower?: PowerStats;
  liveSkillId: number;
  liveSkillLevel: number;
  gekisoSkillId: number;
  gekisoSkillLevel: number | null;
  gaps: EvidenceGap[];
}
export interface SnapshotOption {
  instanceId: string;
  cardId: number;
  stats: PowerStats;
  /** PowerBonusPercent uses BP percentages, not additive member power. */
  bonusBP?: PowerStats;
  supportSkills?: { id: number; level: number }[];
  gekisoSupportSkills?: { id: number; level: number | null }[];
  supportSkillId: number;
  supportSkillLevel: number;
  gekisoSupportSkillId: number;
  gekisoSupportSkillLevel: number | null;
  /** undefined means the adapter has not established equip restrictions. */
  allowedCharacterIds?: number[];
  gaps: EvidenceGap[];
}
export interface ChartEvent {
  tick: number;
  timeMs: number;
  operateType: number;
  judgementType: number;
}
export interface SongOption {
  key: string;
  songId: number;
  scoreId: number;
  difficulty: number;
  playLevel: number;
  durationMs: number;
  events: ChartEvent[];
  skillTimesMs: number[];
  segments: { startTick: number; endTick: number; mission: number }[];
  nativeGekisoPlan?: NativeGekisoSongPlan;
  nativeGekisoPlanGaps?: EvidenceGap[];
  gaps: EvidenceGap[];
}
export interface TeamAssignment {
  memberInstanceIds: string[];
  /** Each index equips the corresponding member; null is an empty slot. */
  snapshotInstanceIds: (string | null)[];
  leaderInstanceId: string;
}
export interface Candidate {
  assignment: TeamAssignment;
  songKey: string;
  metrics: Record<Objective, MetricValue>;
  /** The objective values used by Pareto comparison, in requested order. */
  vector: number[];
  /** Native formation BP bonuses before rank/consumption/reward selection. */
  eventBonusBP?: { points: number | null; items: number | null; gaps: EvidenceGap[] };
}
export interface RequiredSnapshotBinding {
  memberInstanceId: string;
  /** Null fixes an empty physical slot for this required member. */
  snapshotInstanceId: string | null;
}
export interface SearchConstraints {
  lockedMemberIds: string[];
  excludedMemberIds: string[];
  lockedSnapshotIds: string[];
  excludedSnapshotIds: string[];
  excludedSongKeys: string[];
  /** A locked chart is the single permitted song/difficulty candidate. */
  lockedSongKey?: string | null;
  excludeJustMissions: boolean;
  /** Fraction of eligible nodes receiving JUST, default 0; other nodes PERFECT. */
  justRate: number;
  teamSize: number;
  /** Required leader is also a required member; null/omitted leaves it open. */
  requiredLeaderId?: string | null;
  /** Each pair requires its member and, if nonnull, its owned photo. */
  requiredBindings?: RequiredSnapshotBinding[];
  /** BP units:10000=100%; each supplied floor needs an identified event scene. */
  bonusFloors?: { eventPointsBP?: number; eventItemsBP?: number };
  /** 1..15 distinct unordered member card-ID sets, independent of leader/photos. */
  resultDistinctCardSets?: number;
}
export interface SearchBudget {
  maxEvaluations: number;
  maxMilliseconds: number;
  maxCandidates: number;
}
export interface SearchProgress {
  evaluated: number;
  elapsedMs: number;
  phase: "loading" | "search" | "complete";
  candidateCount?: number;
  proofStatus?: "candidate" | "proven" | "unavailable";
}
export interface SongSearchRanking {
  songKey: string;
  songId: number;
  difficulty: number;
  /** Independent Top3 per objective, collected before global Pareto filtering. */
  top3: Partial<Record<Objective, Candidate[]>>;
  evaluated: number;
  proven: boolean;
}
export interface SearchProof {
  status: "candidate" | "proven" | "unavailable";
  method: "exhaustive-selected-domain";
  scope: "selected-input-domain";
}
export interface SearchResult {
  capabilities?: TeamBuilderCapabilities;
  candidates: Candidate[];
  completeness: "exhaustive" | "budget-limited" | "cancelled" | "unavailable";
  evaluated: number;
  elapsedMs: number;
  gaps: EvidenceGap[];
  proof?: SearchProof;
  bySong?: SongSearchRanking[];
  /** Best real complete candidate per distinct unordered member card-ID set,
   * independently ranked for each objective; other bindings stay on that candidate. */
  cardSetsByObjective?: Partial<Record<Objective, { memberCardIds: number[]; candidate: Candidate }[]>>;
}

/** A completed selected-domain result. Budget-limited DFS state is not persisted. */
export interface SearchCheckpoint {
  schema: "haneoka-search-checkpoint-v1";
  engineRevision: string;
  fingerprint: string;
  resultDigest: string;
  result: SearchResult;
}
/** Partial traversal is opaque to UI. The cursor owner validates its schema,
 * full semantic fingerprint, checksum and bounded internal state on restore. */
export interface SearchResumeCheckpoint {
  schema: "haneoka-search-resume-v1";
  engineRevision: string;
  fingerprint: string;
  stateDigest: string;
  state: unknown;
}

/** Fully resolved native slot state. The adapter preserves gaps until the full
 * power/skill/condition path is established for this player and selected mode. */
export interface ResolvedSlotProfile {
  power: number;
  /** Native total BP vector, retained for the deck-wide integer getter. */
  bpPower?: PowerStats;
  windows: SkillWindow[];
  gaps: EvidenceGap[];
}
export interface SkillWindow {
  startMs: number;
  endMs: number;
  scoreBonus: number;
  perfectBonus: number;
  justBonus: number;
  comboBonus: number;
  gekisoComboBonus: number;
  luckBonusPercent: number;
  powerDelta: number;
}
export interface SongScoreContext {
  eventBonusFactor: number;
  life: number;
  assistModeFactor: number;
  /** Extra native fixed scores (for example resolved mission-rank rewards). */
  fixedScore: number;
  /** Personal threshold only; a room-total threshold must stay separate. */
  personalSS: number | null;
  /** A room threshold never divides a personal score; its numerator is explicit. */
  ssContext?: { domain: "personal" | "room"; threshold: number | null; numerator: number | null; source: string };
  gaps: EvidenceGap[];
}
export interface ScoreEvaluationModel extends ReleaseIdentity {
  mode: PlayMode;
  /** A growth-only result belongs to base-score, never the full score objective. */
  scope?: "native-runtime" | "growth-only";
  noteScorePercents: Record<number, number>;
  justJudgementTypes: number[];
  comboBonuses: { requiredCombo: number; bonus: number }[];
  adjustmentFactor: number;
  lifeOnusFactor: number;
  perfectPercent: number;
  justPercent: number;
  /** Leader-independent profiles, shared across songs when the scenario allows it. */
  defaultSlots?: Record<string, Record<string, Record<string, ResolvedSlotProfile>>>;
  /** songKey → leader → member → snapshot instance ("" = none). */
  slots: Record<string, Record<string, Record<string, Record<string, ResolvedSlotProfile>>>>;
  songContexts: Record<string, SongScoreContext>;
  assumptions: string[];
  gaps: EvidenceGap[];
}
export interface OptimizationInput extends ReleaseIdentity {
  skillOrderCriterion?: SkillOrderCriterion;
  scoreDomain?: PersonalScoreDomain;
  members: MemberOption[];
  snapshots: SnapshotOption[];
  songs: SongOption[];
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
  evaluation: ScoreEvaluationModel;
  inputGaps?: EvidenceGap[];
  basis?: EvaluationBasisRequest;
}
export interface WorkerPreparationInput {
  /** Optional explicit context; the Worker otherwise produces eligible chart plans. */
  nativeGekisoPlans?: NativeGekisoPlans;
  /** Default mean; AP endpoints select the lowest/highest complete native order. */
  skillOrderCriterion?: SkillOrderCriterion;
  /** Gekiso personal-live selects the chart/native driver; personal-solo selects its Solo ledger. */
  scoreDomain?: PersonalScoreDomain;
  data: TeamBuilderData;
  inventory: InventoryV1;
  /** Multiple charts compete under the same explicit objective and basis. */
  selections: { songId: number; difficulty: number }[];
  basis?: EvaluationBasisRequest;
  mode: PlayMode;
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
  eventScene?: NativeEventScene;
  /** Qualified single-wrapper challenge context for this one parent chart. */
  challengeMusicId?: number;
}
export interface ManualTeamPreparationInput extends WorkerPreparationInput {
  assignment: TeamAssignment;
}
export interface ManualTeamEvaluationResult extends ReleaseIdentity {
  schema: "haneoka-manual-team-result-v1";
  sourceId: string;
  /** Shared native parsed-chart context for comparing fixed assignments; absent for an unprepared pool. */
  contextFingerprint?: string;
  assignment: TeamAssignment;
  status: "complete" | "cancelled" | "budget-limited" | "unavailable";
  /** One fixed-assignment result per completely evaluated chart. */
  candidates: Candidate[];
  elapsedMs: number;
  gaps: EvidenceGap[];
}
export interface ManualTeamProgress {
  phase: "loading" | "evaluation" | "complete";
  chartsCompleted: number;
  totalCharts: number;
  elapsedMs: number;
}
/** A recorded native start or explicitly identified replay scenario. The
 * server's held-event list and Master time-column choice are supplied together;
 * the public event picker alone does not establish these runtime facts.
 */
export interface NativeEventScene {
  eventId: number;
  kind: "normal" | "challenge";
  consumedCount: number;
  heldEventIds: number[];
  masterTimeSlot: 0 | 1 | 2 | 3 | 4;
  liveStartServerTime: {
    epochMilliseconds: number;
    source: "game-server" | "explicit-scenario";
    reference: string;
  };
}
export type SolverRequest =
  | { type: "practical-prepare"; runId: string; request: NativePracticalPreparationInput }
  | { type: "manual-prepare"; runId: string; request: ManualTeamPreparationInput }
  | { type: "resource-prepare"; runId: string; request: ResourcePlannerPreparationInput }
  | { type: "prepare"; runId: string; request: WorkerPreparationInput; checkpoint?: SearchCheckpoint;
      resumeCheckpoint?: SearchResumeCheckpoint }
  | { type: "start"; runId: string; input: OptimizationInput; checkpoint?: SearchCheckpoint;
      resumeCheckpoint?: SearchResumeCheckpoint }
  | { type: "cancel"; runId: string };
export type SolverResponse =
  | { type: "practical-progress"; runId: string; progress: NativePracticalProgress }
  | { type: "practical-result"; runId: string; result: NativePracticalResult }
  | { type: "manual-progress"; runId: string; progress: ManualTeamProgress }
  | { type: "manual-result"; runId: string; result: ManualTeamEvaluationResult }
  | { type: "resource-progress"; runId: string; progress:
      { phase: "loading" } | ({ phase: "stage" } & ResourceStagePreparationProgress) | ResourcePlannerProgress }
  | { type: "resource-result"; runId: string; result: ResourcePlannerResult }
  | { type: "progress"; runId: string; progress: SearchProgress }
  | { type: "result"; runId: string; result: SearchResult; checkpoint?: SearchCheckpoint; reusedCheckpoint?: boolean;
      resumeCheckpoint?: SearchResumeCheckpoint }
  | { type: "error"; runId: string; code: string };
