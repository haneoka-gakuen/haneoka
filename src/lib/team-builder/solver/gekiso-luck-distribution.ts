import {
  resolveGekisoLuckStep,
  type GekisoLuckStep,
  type GekisoLuckStepResult,
  type GekisoResolved,
  type GekisoRules,
  type LuckLotResult,
} from "./gekiso-mission-luck.ts";
import {
  createGekisoLuckDrawResolver,
  type GekisoLotteryInput,
  type GekisoLotteryItem,
  type GekisoMinimumEntry,
  type GekisoRandomLaw,
} from "./gekiso-luck-lottery.ts";

export interface GekisoLuckBranch {
  probability: number;
  result: GekisoLuckStepResult;
  minimumEntries: readonly GekisoMinimumEntry[] | null;
  exhaustedAtDraw: readonly { id: number; timeMs: number }[];
}
export interface GekisoLuckDistributionInput {
  step: Omit<GekisoLuckStep, "initialDraw" | "nextDraw">;
  drawTimeMs: number;
  minimumEntries: readonly GekisoMinimumEntry[] | null;
  /** Each prefetch uses an independent draw under this explicitly supplied law. */
  randomLaw: GekisoRandomLaw;
  itemOrder?: GekisoLotteryInput["itemOrder"];
  orderedItemsByChance?: Readonly<Partial<Record<number, readonly GekisoLotteryItem[]>>>;
}

/** Joint prefetch/state transition: initial quota is consumed before selecting
 * the next draw law; the cached Next result, rather than that new draw, is scored.
 * This is one admitted native note/pending-frame invocation, not a frame driver.
 */
export function createGekisoLuckDistributionResolver(rules: GekisoRules) {
  const draw = createGekisoLuckDrawResolver(rules);
  return (
    input: GekisoLuckDistributionInput,
  ): GekisoResolved<{ branches: readonly GekisoLuckBranch[]; assumptions: string[] }> => {
    const probe = resolveGekisoLuckStep(rules, { ...input.step, initialDraw: null, nextDraw: null });
    if (probe.value)
      return {
        value: {
          branches: [
            { probability: 1, result: probe.value, minimumEntries: input.minimumEntries, exhaustedAtDraw: [] },
          ],
          assumptions: [],
        },
        gaps: [],
      };
    if (
      probe.gaps.some(
        (gap) =>
          gap.code !== "gekiso-initial-lot-random-outcome-required" &&
          gap.code !== "gekiso-next-lot-random-outcome-required",
      )
    )
      return { value: null, gaps: probe.gaps };
    const percent = Math.floor(Math.fround(Math.fround(input.step.probabilityUpFactor!) * Math.fround(100)));
    const assumptions = new Set<string>(["native-luck-independent-prefetch-laws"]);
    type Initial = {
      result: LuckLotResult | null;
      probability: number;
      entries: readonly GekisoMinimumEntry[] | null;
      exhausted: readonly { id: number; timeMs: number }[];
    };
    let initials: Initial[] = [{ result: null, probability: 1, entries: input.minimumEntries, exhausted: [] }];
    if (probe.gaps.some((gap) => gap.code === "gekiso-initial-lot-random-outcome-required")) {
      const initial = draw({
        drawTimeMs: input.drawTimeMs,
        chanceType: 0,
        minimumEntries: input.minimumEntries,
        probabilityUpFactorAtDraw: input.step.probabilityUpFactor!,
        randomLaw: input.randomLaw,
        itemOrder: input.itemOrder,
        orderedItems: input.orderedItemsByChance?.[0],
      });
      if (!initial.value) return { value: null, gaps: initial.gaps };
      if (initial.value.failureProbability > 0)
        return { value: null, gaps: [{ code: "gekiso-lottery-native-null-probability", source: "initial prefetch" }] };
      initial.value.assumptions.forEach((value) => assumptions.add(value));
      const value = initial.value;
      initials = value.probabilities.flatMap((probability, result) =>
        probability > 0
          ? [
              {
                result: result as LuckLotResult,
                probability,
                entries: value.entriesAfterSuccess,
                exhausted: value.exhaustedAtDraw,
              },
            ]
          : [],
      );
    }
    const branches: GekisoLuckBranch[] = [];
    for (const initial of initials) {
      const consumed = initial.result ?? input.step.state!.next;
      const rush = consumed === 3 ? (input.step.state!.rushCombo + 1) | 0 : 0;
      const chanceType = rush <= 3 ? [0, 4, 3, 2][rush]! : 1;
      const next = draw({
        drawTimeMs: input.drawTimeMs,
        chanceType,
        minimumEntries: initial.entries,
        probabilityUpFactorAtDraw: input.step.probabilityUpFactor!,
        randomLaw: input.randomLaw,
        itemOrder: input.itemOrder,
        orderedItems: input.orderedItemsByChance?.[chanceType],
      });
      if (!next.value) return { value: null, gaps: next.gaps };
      if (next.value.failureProbability > 0)
        return { value: null, gaps: [{ code: "gekiso-lottery-native-null-probability", source: "next prefetch" }] };
      next.value.assumptions.forEach((value) => assumptions.add(value));
      for (const [result, probability] of next.value.probabilities.entries()) {
        if (probability <= 0) continue;
        const resolved = resolveGekisoLuckStep(rules, {
          ...input.step,
          initialDraw:
            initial.result === null ? null : { chanceType: 0, result: initial.result, probabilityBuffPercent: percent },
          nextDraw: { chanceType, result: result as LuckLotResult, probabilityBuffPercent: percent },
        });
        if (!resolved.value) return { value: null, gaps: resolved.gaps };
        branches.push({
          probability: initial.probability * probability,
          result: resolved.value,
          minimumEntries: next.value.entriesAfterSuccess,
          exhaustedAtDraw: [...initial.exhausted, ...next.value.exhaustedAtDraw],
        });
      }
    }
    return { value: { branches, assumptions: [...assumptions] }, gaps: [] };
  };
}
