// L3 — GEB
// Input: OptimizationInput、队伍分配与准备好的评价上下文。
// Output: 队伍指标、证据缺口及可复用评价器。
// Pos: [Map](L2-2.md)；TS 搜索的分配评价组合。
// Effects/Dependencies: 按评价上下文构建局部查找／缓存并调用规则计算，不持有云端存储。
import type {
  Candidate,
  EvidenceGap,
  MetricValue,
  Objective,
  OptimizationInput,
  ResolvedSlotProfile,
  SkillWindow,
  TeamAssignment,
} from "../contracts.ts";
import { calculateSSRatio } from "./score-ranks.ts";
import { applyEvaluationBasis } from "./basis.ts";
import { eventRewardMetrics } from "../rewards.ts";
import {
  calcNativeNoteScore,
  nativeComboFactor,
  nativeDifficultyFactor,
  nativeLuckFactorPercent,
  nativeScoreUpFactor,
  unavailableMetric,
} from "../score.ts";
import type { PreparedSong } from "../song-metrics.ts";

interface WindowCacheEntry {
  song: PreparedSong;
  profile: ResolvedSlotProfile;
  active: SkillWindow[][];
}
/** Bounded coverage cache; chart judgements and skill intervals resolve once. */
function windowCache() {
  const entries: WindowCacheEntry[] = [];
  let nodes = 0;
  return (song: PreparedSong, profile: ResolvedSlotProfile): SkillWindow[][] => {
    const hit = entries.findIndex((entry) => entry.song === song && entry.profile === profile);
    if (hit >= 0) {
      const entry = entries.splice(hit, 1)[0]!;
      entries.push(entry);
      return entry.active;
    }
    const empty: SkillWindow[] = [];
    const active = song.nodes.map(() => empty);
    if (profile.windows.length > 512) throw new RangeError("skill-window-limit");
    for (const window of profile.windows) {
      if (!Object.values(window).every(Number.isFinite) || window.endMs < window.startMs)
        throw new RangeError("skill-window-state");
      let low = 0,
        high = song.nodes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (song.nodes[mid]!.event.timeMs < window.startMs) low = mid + 1;
        else high = mid;
      }
      for (let i = low; i < song.nodes.length && song.nodes[i]!.event.timeMs <= window.endMs; i++) {
        if (active[i] === empty) active[i] = [window];
        else active[i]!.push(window);
      }
    }
    while (entries.length && (nodes + song.nodes.length > 100000 || entries.length >= 128))
      nodes -= entries.shift()!.song.nodes.length;
    entries.push({ song, profile, active });
    nodes += song.nodes.length;
    return active;
  };
}
interface AssignmentLookup {
  memberGaps: Map<string, EvidenceGap[]>;
  snapshotGaps: Map<string, EvidenceGap[]>;
}
function prepareAssignmentLookup(input: OptimizationInput): AssignmentLookup {
  return {
    memberGaps: new Map(input.members.map((member) => [member.instanceId, member.gaps])),
    snapshotGaps: new Map(input.snapshots.map((snapshot) => [snapshot.instanceId, snapshot.gaps])),
  };
}
export function createAssignmentEvaluator(
  input: OptimizationInput,
  resolveSlots?: (assignment: TeamAssignment, song: PreparedSong) => (ResolvedSlotProfile | undefined)[],
): (assignment: TeamAssignment, prepared: PreparedSong, scoreOverride?: MetricValue) => Candidate {
  const cache = windowCache();
  const lookup = prepareAssignmentLookup(input);
  return (assignment, prepared, scoreOverride?: MetricValue) =>
    evaluateAssignment(input, assignment, prepared, cache, lookup, resolveSlots, scoreOverride);
}

/** Scores a fully resolved native scenario. Missing runtime state remains null. */
export function evaluateAssignment(
  input: OptimizationInput,
  assignment: TeamAssignment,
  prepared: PreparedSong,
  coverage?: ReturnType<typeof windowCache>,
  lookup: AssignmentLookup = prepareAssignmentLookup(input),
  resolveSlots?: (assignment: TeamAssignment, song: PreparedSong) => (ResolvedSlotProfile | undefined)[],
  scoreOverride?: MetricValue,
): Candidate {
  const model = input.evaluation;
  const context = model.songContexts[prepared.song.key];
  const profiles =
    resolveSlots?.(assignment, prepared) ??
    assignment.memberInstanceIds.map(
      (member, slot) =>
        model.slots[prepared.song.key]?.[assignment.leaderInstanceId]?.[member]?.[
          assignment.snapshotInstanceIds[slot] ?? ""
        ] ?? model.defaultSlots?.[prepared.song.key]?.[member]?.[assignment.snapshotInstanceIds[slot] ?? ""],
    );
  const rewards = eventRewardMetrics();
  let score = unavailableMetric("unresolved-slot-or-song-context", "native power/skill/trigger/mission runtime state");
  const optionGaps = [
    ...assignment.memberInstanceIds.flatMap((id) => lookup.memberGaps.get(id) ?? []),
    ...assignment.snapshotInstanceIds.flatMap((id) => (id === null ? [] : (lookup.snapshotGaps.get(id) ?? []))),
  ];
  const gaps = [
    ...optionGaps,
    ...model.gaps,
    ...prepared.gaps,
    ...(context?.gaps ?? []),
    ...profiles.flatMap((profile) => profile?.gaps ?? []),
  ];
  if (context && profiles.every((profile) => profile !== undefined) && gaps.length === 0) {
    const resolved = profiles.map((profile) => profile!);
    if (scoreOverride) score = scoreOverride;
    else {
      const basePower = resolved.reduce((sum, profile) => sum + profile.power, 0);
      const intervals = coverage ? resolved.map((profile) => coverage(prepared, profile)) : null;
      let total = context.fixedScore;
      for (const [index, node] of prepared.nodes.entries()) {
        // Effective windows are resolved by the native trigger/condition adapter.
        const active = intervals
          ? intervals.flatMap((rows) => rows[index]!)
          : resolved.flatMap((profile) =>
              profile.windows.filter(
                (window) => window.startMs <= node.event.timeMs && node.event.timeMs <= window.endMs,
              ),
            );
        const sum = (
          key:
            | "scoreBonus"
            | "perfectBonus"
            | "justBonus"
            | "comboBonus"
            | "gekisoComboBonus"
            | "luckBonusPercent"
            | "powerDelta",
        ) => active.reduce((value, window) => Math.fround(value + window[key]), 0);
        const common = {
          bandPower: basePower + sum("powerDelta"),
          adjustmentFactor: model.adjustmentFactor,
          musicDifficultyFactor: nativeDifficultyFactor(prepared.song.playLevel),
          convertedNoteCount: prepared.convertedNoteCount,
          notePercent: model.noteScorePercents[node.event.operateType]!,
          comboFactor: nativeComboFactor(node.comboBonus, sum("comboBonus"), sum("gekisoComboBonus")),
          luckFactorPercent: nativeLuckFactorPercent(sum("luckBonusPercent")),
          eventBonusFactor: context.eventBonusFactor,
          life: context.life,
          lifeOnusFactor: model.lifeOnusFactor,
          assistModeFactor: context.assistModeFactor,
        };
        const perfect = calcNativeNoteScore({
          ...common,
          judgementPercent: model.perfectPercent,
          scoreUpFactor: nativeScoreUpFactor(sum("scoreBonus"), sum("perfectBonus")),
        });
        const rate = model.mode === "gekiso" && node.justable ? input.constraints.justRate : 0;
        const just =
          rate > 0
            ? calcNativeNoteScore({
                ...common,
                judgementPercent: model.justPercent,
                scoreUpFactor: nativeScoreUpFactor(sum("scoreBonus"), sum("justBonus")),
              })
            : perfect;
        total += (1 - rate) * perfect + rate * just;
      }
      score = {
        value: total,
        status: model.assumptions.length || input.constraints.justRate > 0 ? "conditional" : "verified",
        assumptions: [...model.assumptions],
        gaps: [],
        breakdown: [
          { key: "resolved-team-power", value: basePower, unit: "power", source: "resolved native slot power" },
          { key: "canonical-judged-nodes", value: prepared.nodes.length, unit: "count", source: "canonical chart" },
          {
            key: "converted-note-count",
            value: prepared.convertedNoteCount,
            unit: "count",
            source: "native note percentages",
          },
          {
            key: "justable-nodes",
            value: prepared.justableCount,
            unit: "count",
            source: "same-release judgement timing",
          },
          { key: "fixed-score", value: context.fixedScore, unit: "score", source: "native mode/mission context" },
          { key: "per-play-score", value: total, unit: "score", source: "native score core + fixed score" },
        ],
      };
      if (input.constraints.justRate > 0) score.assumptions.push("just-marginal-rate-fixed-runtime-state");
    }
  } else score.gaps.push(...gaps);
  const computed = score;
  if (model.scope === "growth-only")
    score = unavailableMetric(
      "full-power-and-skill-context-unresolved",
      "native song/player/leader/snapshot/trigger bonuses",
    );
  const threshold = context?.ssContext ? context.ssContext.threshold : (context?.personalSS ?? null);
  const domain = context?.ssContext?.domain ?? "personal";
  const numerator = domain === "personal" ? score.value : (context?.ssContext?.numerator ?? null);
  const surplus: MetricValue =
    score.value !== null && numerator !== null && threshold !== null && threshold > 0
      ? {
          ...score,
          value: numerator - threshold,
          range:
            domain === "personal" && score.range
              ? { minimum: score.range.minimum - threshold, maximum: score.range.maximum - threshold }
              : undefined,
          status: domain === "room" ? "conditional" : score.status,
          assumptions: [...score.assumptions, ...(domain === "room" ? ["explicit-room-score-context"] : [])],
          gaps: [],
          breakdown: [
            { key: "ss-surplus-numerator", value: numerator, unit: "score", source: domain },
            {
              key: "ss-surplus-threshold",
              value: threshold,
              unit: "score",
              source: context?.ssContext?.source ?? "explicit personal threshold",
            },
          ],
        }
      : unavailableMetric("ss-surplus-context-unresolved", "matching native score domain and positive threshold");
  const ratioValue = calculateSSRatio(numerator, threshold, domain, domain);
  const ratio: MetricValue =
    score.value !== null && ratioValue !== null
      ? {
          value: ratioValue,
          range:
            domain === "personal" && score.range
              ? { minimum: score.range.minimum / threshold!, maximum: score.range.maximum / threshold! }
              : undefined,
          bestSkillOrder: score.bestSkillOrder,
          worstSkillOrder: score.worstSkillOrder,
          skillOrderCriterion: score.skillOrderCriterion,
          scoreDomain: score.scoreDomain,
          status: domain === "room" ? "conditional" : score.status,
          assumptions: [...score.assumptions, ...(domain === "room" ? ["explicit-room-score-context"] : [])],
          gaps: [],
          breakdown: [
            { key: "ss-ratio-numerator", value: numerator, unit: "score", source: domain },
            {
              key: "ss-ratio-threshold",
              value: threshold,
              unit: "score",
              source: context?.ssContext?.source ?? "explicit personal threshold",
            },
          ],
        }
      : unavailableMetric(
          "ss-ratio-context-unresolved",
          "matching native personal/room numerator and positive threshold",
        );
  const metrics: Record<Objective, MetricValue> = {
    score,
    "base-score":
      model.scope === "growth-only"
        ? computed
        : unavailableMetric("base-score-scenario-not-requested", "evaluation scope"),
    "ss-ratio": ratio,
    "ss-surplus": surplus,
    "event-points": rewards.points,
    "event-items": rewards.items,
  };
  for (const objective of Object.keys(metrics) as Objective[])
    metrics[objective] = applyEvaluationBasis(metrics[objective], objective, prepared.song.key, input.basis);
  return {
    assignment,
    songKey: prepared.song.key,
    metrics,
    vector: input.objectives.map((objective) => metrics[objective].value ?? NaN),
  };
}
