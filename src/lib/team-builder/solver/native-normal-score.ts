import type { EvidenceGap, MetricValue, OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { calcNativeNoteScore, nativeComboFactor, nativeDifficultyFactor, unavailableMetric } from "../score.ts";

import { normalSkillOrders, resolveNormalSkillEffects, type NormalSkillPlan } from "./normal-skills.ts";
import { addPower, floorPowerBP } from "./power.ts";
import { createNativeNormalSupportResolver } from "./native-normal-support.ts";
import { createNormalPreparationCache } from "./normal-preparation-cache.ts";
import { createNormalCommandPlanCache } from "./normal-command-plans.ts";

const f = Math.fround;
interface PrefixEntry {
  song: PreparedSong;
  power: number;
  factor: number;
  sums: Float64Array;
  augmentation?: NativeScoreAugmentation;
  luckPercent: number;
}
/** Worker-local GK composition. Per-node combo and complete-play additions
 * are resolved by the native GK factory before shuffle outcomes aggregate. */
export interface NativeScoreAugmentation {
  gekisoComboBonuses: readonly number[];
  completePlayBonus: (timingPrefix: Float64Array) => { value: number | null; gaps: EvidenceGap[] };
  assumptions: readonly string[];
  /** Resolve each complete native member order's joint Luck play before averaging. */
  luckPlay?: {
    rushFactorPercent: number;
    resolve: (samples: readonly { timeMs: number; idleScore: number; rushScore: number }[],
      controls: SearchEvaluationControls) => Promise<{ value: number | null; gaps: EvidenceGap[] }>;
  };
}
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;

const orders = normalSkillOrders();
export interface NativeNormalPlayScoreLaw {
  nominalOrders: number;
  /** Integer complete-play scores, grouped by identical outcome. */
  outcomes: readonly { score: number; multiplicity: number }[];
}

/** Prepare immutable live effects and chart event identities once. Per-order
 * commands retain the chart's original index even when their times are unsorted.
 * The normal scope includes positive-duration unconditional type2000/2004, with
 * same-member duration supports; unsupported state machines retain an explicit gap.
 */
export function createNativeNormalScoreResolver(data: TeamBuilderData, input: OptimizationInput) {
  const preparation = createNormalPreparationCache();
  const commandPlans = createNormalCommandPlanCache();
  const gaps: EvidenceGap[] = [];
  const phaseRows = dataRows(data.skillReference.effectSettings).map(nativeRow);
  const phase = phaseRows.filter((row) => row.skillEffectType === 2000);
  if (phase.length !== 1 || phase[0]!.phase !== 2)
    gaps.push(gap("native-normal-effect-phase-unresolved", "same-release MasterSkillEffectSetting/2000"));
  if (input.constraints.teamSize !== 5) gaps.push(gap("native-normal-requires-five-members", "normal formation"));
  // LiveScoreController .ctor passes literal s2=1 to LiveScoreCalculator;
  // assist percentage is the separate s3 argument. Event card power belongs
  // to the slot factory and must not be counted again through this multiplier.
  if (input.songs.some((song) => input.evaluation.songContexts[song.key]?.eventBonusFactor !== 1))
    gaps.push(gap("native-controller-event-factor-requires-one", "LiveScoreController .ctor 0x55e59b0"));
  const supports = createNativeNormalSupportResolver(data, input);
  const snapshotCards = new Map(input.snapshots.map((snapshot) => [snapshot.instanceId, snapshot.cardId]));
  const phaseByEffectType = Object.fromEntries(
    phaseRows.map((row) => [Number(row.skillEffectType), Number(row.phase)]),
  );
  const targets = new Map(
    dataRows(data.skillReference.targets)
      .map(nativeRow)
      .map((row) => [Number(row.id), row]),
  );
  const resolveJudgements = (row: Readonly<Record<string, unknown>>): readonly number[] | null => {
    if (!Array.isArray(row.skillTargetIDs) || row.skillTargetIDs.some((id) => !int(id) || !targets.has(id)))
      return null;
    const values = row.skillTargetIDs.map((id) => targets.get(id)!.judgement);
    return values.every((value) => typeof value === "number" && [3, 4, 5, 6].includes(value))
      ? (values as number[])
      : null;
  };
  const members = new Map<string, NormalSkillPlan>();
  const identities = new Map(
    input.members.map((member) => [member.instanceId, { cardId: member.cardId, characterId: member.characterId }]),
  );
  for (const member of input.members) {
    const raw = data.skills.live?.[String(member.liveSkillId)];
    const plan = resolveNormalSkillEffects({
      rows: dataRows(raw?.effects),
      kind: "live",
      skillId: member.liveSkillId,
      level: member.liveSkillLevel,
      phaseByEffectType,
      resolveJudgements,
    });
    if (plan.effects.some((effect) => effect.type !== 2000 && effect.type !== 2004))
      members.set(member.instanceId, {
        effects: [],
        gaps: [...plan.gaps, gap("native-normal-basic-live-skills-required", member.instanceId)],
      });
    else members.set(member.instanceId, plan);
  }
  const charts = new Map(input.songs.map((song) => [song.key, [...song.skillTimesMs]]));
  const prefixes: PrefixEntry[] = [];
  let cachedNodes = 0;
  const interrupted = (controls: SearchEvaluationControls) => controls.cancelled() || controls.expired();
  async function prefix(song: PreparedSong, power: number, factor: number, controls: SearchEvaluationControls,
    augmentation?: NativeScoreAugmentation, luckPercent = 100) {
    const found = prefixes.findIndex(
      (entry) => entry.song === song && entry.power === power && entry.factor === factor &&
        entry.augmentation === augmentation && entry.luckPercent === luckPercent,
    );
    if (found >= 0) {
      const entry = prefixes.splice(found, 1)[0]!;
      prefixes.push(entry);
      return entry.sums;
    }
    const model = input.evaluation,
      context = model.songContexts[song.song.key]!;
    const sums = new Float64Array(song.nodes.length + 1);
    for (const [index, node] of song.nodes.entries()) {
      if (index % 2048 === 0) {
        if (interrupted(controls)) return null;
        if (index) {
          controls.progress();
          await controls.yield();
        }
      }
      sums[index + 1] =
        sums[index]! +
        calcNativeNoteScore({
          bandPower: power,
          adjustmentFactor: model.adjustmentFactor,
          musicDifficultyFactor: nativeDifficultyFactor(song.song.playLevel),
          convertedNoteCount: song.convertedNoteCount,
          notePercent: model.noteScorePercents[node.event.operateType]!,
          judgementPercent: model.perfectPercent,
          comboFactor: nativeComboFactor(node.comboBonus, 0, augmentation?.gekisoComboBonuses[index] ?? 0),
          scoreUpFactor: factor,
          luckFactorPercent: luckPercent,
          eventBonusFactor: context.eventBonusFactor,
          life: context.life,
          lifeOnusFactor: model.lifeOnusFactor,
          assistModeFactor: context.assistModeFactor,
        });
    }
    while (prefixes.length && (prefixes.length >= 48 || cachedNodes + sums.length > 200000))
      cachedNodes -= prefixes.shift()!.sums.length;
    prefixes.push({ song, power, factor, sums, augmentation, luckPercent });
    cachedNodes += sums.length;
    return sums;
  }
  return {
    gaps,
    async score(
      assignment: TeamAssignment,
      song: PreparedSong,
      profiles: readonly (ResolvedSlotProfile | undefined)[],
      controls: SearchEvaluationControls,
      onCompleteLaw?: (law: NativeNormalPlayScoreLaw) => void,
      augmentation?: NativeScoreAugmentation,
    ): Promise<MetricValue> {
      const local = [
        ...gaps,
        ...song.gaps,
        ...profiles.flatMap((profile) => profile?.gaps ?? [gap("native-normal-slot-unresolved", song.song.key)]),
      ];
      if (augmentation && (augmentation.gekisoComboBonuses.length !== song.nodes.length ||
        augmentation.gekisoComboBonuses.some((value) => !Number.isFinite(f(value)) || value < 0)))
        local.push(gap("native-gekiso-node-combo-unresolved", song.song.key));
      if (augmentation?.luckPlay && (!int(augmentation.luckPlay.rushFactorPercent) ||
        augmentation.luckPlay.rushFactorPercent < 100 || augmentation.luckPlay.rushFactorPercent > 200 || onCompleteLaw))
        local.push(gap("native-gekiso-luck-play-domain-unresolved", "complete joint law requires its own probability outcomes"));
      const times = charts.get(song.song.key);
      if (!times || times.length !== 5 || times.some((time) => !int(time)))
        local.push(gap("native-normal-chart-events-unresolved", song.song.key));
      const nativeMembers = [...assignment.memberInstanceIds];
      const nativeSnapshots = [...assignment.snapshotInstanceIds];
      const leaderSlot = nativeMembers.indexOf(assignment.leaderInstanceId);
      const selectedIdentities = nativeMembers.map((id) => identities.get(id));
      const selectedSnapshots = nativeSnapshots.filter((id): id is string => id !== null);
      if (
        nativeMembers.length !== 5 ||
        assignment.snapshotInstanceIds.length !== 5 ||
        leaderSlot < 0 ||
        selectedIdentities.some((identity) => !identity) ||
        new Set(selectedIdentities.map((identity) => identity?.cardId)).size !== 5 ||
        new Set(selectedIdentities.map((identity) => identity?.characterId)).size !== 5 ||
        selectedSnapshots.some((id) => !snapshotCards.has(id)) ||
        new Set(selectedSnapshots.map((id) => snapshotCards.get(id))).size !== selectedSnapshots.length
      )
        local.push(gap("native-normal-formation-unresolved", "assignment"));
      else {
        [nativeMembers[2], nativeMembers[leaderSlot]] = [nativeMembers[leaderSlot]!, nativeMembers[2]!];
        [nativeSnapshots[2], nativeSnapshots[leaderSlot]] = [nativeSnapshots[leaderSlot]!, nativeSnapshots[2]!];
      }
      const plans = nativeMembers.map((id) => members.get(id));
      const supportPlans = nativeMembers.map((id, slot) => supports.resolve(nativeSnapshots[slot] ?? null, id));
      for (const [slot, plan] of plans.entries())
        local.push(...(plan?.gaps ?? [gap("native-normal-member-unresolved", nativeMembers[slot]!)]));
      for (const pair of supportPlans) for (const plan of pair) local.push(...(plan?.gaps ?? []));
      if (local.length) return { value: null, status: "unavailable", assumptions: [], gaps: local };
      // LiveDataCreator passes DeckPowerResult.TotalPower.get_Total to
      // MemberDataContainer.SelfDeckTotalPower, after the BP vectors are summed.
      const deck = profiles.every((profile) => profile!.bpPower)
        ? floorPowerBP(addPower(...profiles.map((profile) => profile!.bpPower!)))
        : null;
      const power = deck
        ? ((deck.performance + deck.technique + deck.visual) / 10000) | 0
        : profiles.reduce((sum, profile) => sum + profile!.power, 0);
      const lastNoteMs = song.nodes.at(-1)!.event.timeMs;
      for (const [slot, plan] of plans.entries())
        for (const timeMs of times!)
          for (const effect of plan!.effects) {
            let extension = f(0);
            for (const support of supportPlans[slot]!)
              for (const duration of support?.effects ?? [])
                if (duration.type === 15000 && duration.condition.activation === "member-event")
                  extension = f(extension + f(duration.value));
            const finish = (timeMs + Math.ceil(f(f(f(effect.seconds) * f(1000)) + extension))) | 0;
            if (finish < timeMs || finish > lastNoteMs)
              local.push(gap("native-music-length-required-for-skill-finish", song.song.key));
          }
      if (local.length) return { value: null, status: "unavailable", assumptions: [], gaps: local };
      const formation = plans.map((live, slot) => ({ live: live!, supports: supportPlans[slot]! }));
      const prepared = await preparation.prepare(
        { formation, skillTimesMs: times!, musicLengthMs: lastNoteMs },
        controls,
      );
      if (!prepared) return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
      if (!prepared.complete)
        return { value: null, status: "unavailable", assumptions: [], gaps: [...prepared.entries[0]!.result.gaps] };
      let total = 0,
        minimum = Infinity,
        maximum = -Infinity;
      let bestSkillOrder: string[] = [],
        worstSkillOrder: string[] = [];
      const scores = onCompleteLaw ? new Map<number, number>() : null;
      const expectedOrderScores: number[] | null = augmentation?.luckPlay ? [] : null;
      const assumptions = new Set([
        ...input.evaluation.assumptions,
        input.skillOrderCriterion === "worst-ap"
          ? "native-normal-complete-member-order-domain"
          : "native-normal-nominal-uniform-member-shuffle",
        "100-percent-perfect",
        ...(augmentation?.assumptions ?? []),
      ]);
      for (const [orderIndex, entry] of prepared.entries.entries()) {
        const { order, result: skills } = entry;
        if (interrupted(controls))
          return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
        if (orderIndex && orderIndex % 8 === 0) {
          controls.progress();
          await controls.yield();
        }
        // Every positive Live effect is known to finish before this horizon;
        // actual audio duration >= the last valid judged node gives the same commands.
        if (skills.gaps.length) return { value: null, status: "unavailable", assumptions: [], gaps: [...skills.gaps] };
        skills.assumptions.forEach((assumption) => assumptions.add(assumption));
        const intervals = await commandPlans.resolve(song, skills, controls);
        if (!intervals.value) return { value: null, status: "unavailable", assumptions: [], gaps: intervals.gaps };
        let score = input.evaluation.songContexts[song.song.key]!.fixedScore;
        const timingPrefix = augmentation && !augmentation.luckPlay ? new Float64Array(song.nodes.length + 1) : null;
        const luckSamples: { timeMs: number; idleScore: number; rushScore: number }[] = [];
        const accumulate = (sums: Float64Array, start: number, end: number, rush?: Float64Array) => {
          score += sums[end]! - sums[start]!;
          if (timingPrefix)
            for (let node = start; node < end; node++)
              timingPrefix[node + 1] = timingPrefix[start]! + sums[node + 1]! - sums[start]!;
          if (rush) for (let node = start; node < end; node++) luckSamples.push({
            timeMs: song.nodes[node]!.event.timeMs, idleScore: sums[node + 1]! - sums[node]!,
            rushScore: rush[node + 1]! - rush[node]!,
          });
        };
        for (const interval of intervals.value) {
          const sums = await prefix(song, power, interval.factor, controls, augmentation);
          if (!sums) return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
          const rush = augmentation?.luckPlay ? await prefix(song, power, interval.factor, controls,
            augmentation, augmentation.luckPlay.rushFactorPercent) : undefined;
          if (rush === null) return unavailableMetric("native-normal-shuffle-interrupted", "search cancellation/budget");
          accumulate(sums, interval.start, interval.end, rush);
        }
        if (augmentation?.luckPlay) {
          const played = await augmentation.luckPlay.resolve(luckSamples, controls);
          if (played.value === null || played.gaps.length)
            return { value: null, status: "unavailable", assumptions: [], gaps: played.gaps };
          score = played.value;
        } else if (augmentation) {
          const extra = augmentation.completePlayBonus(timingPrefix!);
          if (extra.value === null || extra.gaps.length)
            return { value: null, status: "unavailable", assumptions: [], gaps: extra.gaps };
          if (!int(extra.value))
            return unavailableMetric("native-gekiso-play-addition-unresolved", song.song.key);
          score += extra.value;
        }
        if (augmentation?.luckPlay ? !Number.isFinite(score) || score < 0 || score > 0x7fffffff : !int(score))
          return unavailableMetric("native-normal-score-domain-unresolved", "native signed score accumulation");
        total += score;
        expectedOrderScores?.push(score);
        scores?.set(score, (scores.get(score) ?? 0) + 1);
        if (score < minimum) {
          minimum = score;
          worstSkillOrder = order.map((slot) => nativeMembers[slot]!);
        }
        if (score > maximum) {
          maximum = score;
          bestSkillOrder = order.map((slot) => nativeMembers[slot]!);
        }
      }
      // A nominal mean is independent of the member-order enumeration order.
      // Canonical summation keeps equivalent shuffled formations tied in f64.
      if (expectedOrderScores) total = expectedOrderScores.sort((a, b) => a - b).reduce((sum, value) => sum + value, 0);
      // Publish once after all nominal orders complete. A cancelled/budgeted
      // prefix cannot become a reward law or a resource-cycle input.
      if (scores && !interrupted(controls))
        onCompleteLaw!({
          nominalOrders: orders.length,
          outcomes: [...scores].sort(([a], [b]) => a - b).map(([score, multiplicity]) => ({ score, multiplicity })),
        });
      return {
        value: input.skillOrderCriterion === "worst-ap" ? minimum : total / orders.length,
        status: "conditional",
        range: { minimum, maximum },
        bestSkillOrder,
        worstSkillOrder,
        skillOrderCriterion: input.skillOrderCriterion ?? "nominal-mean",
        assumptions: [...assumptions],
        gaps: [],
        breakdown: [
          { key: "resolved-team-power", value: power, unit: "power", source: "native normal slot factory" },
          {
            key: "normal-shuffle-orders",
            value: orders.length,
            unit: "count",
            source: "native Fisher–Yates bounded-draw domain",
          },
          { key: "normal-score-minimum", value: minimum, unit: "score", source: "complete play per native order" },
          { key: "normal-score-maximum", value: maximum, unit: "score", source: "complete play per native order" },
          {
            key: "normal-score-mean",
            value: total / orders.length,
            unit: "score",
            source: "uniform nominal order expectation",
          },
        ],
      };
    },
  };
}
