/** Exact symmetry reduction of the five resolved live-skill slots. */
import type { LifeGate, LiveEffect, SlotSkill } from "./skills";

// Fail typechecking when a skill shape gains a field that the exact comparator has not considered.
type AssertCompared<T extends true> = T;
type _SlotFields = AssertCompared<
  Exclude<keyof SlotSkill, "effects" | "extensionMs" | "recovery" | "convert"> extends never ? true : false
>;
type _EffectFields = AssertCompared<
  Exclude<keyof LiveEffect, "type" | "delta" | "seconds" | "gate" | "judgements"> extends never ? true : false
>;
type _ConvertFields = AssertCompared<
  Exclude<keyof NonNullable<SlotSkill["convert"]>, "judgements" | "limit"> extends never ? true : false
>;
type _GateKinds = AssertCompared<
  Exclude<LifeGate["kind"], "always" | "never" | "life-at-least"> extends never ? true : false
>;
type _LifeGateFields = AssertCompared<
  Exclude<keyof Extract<LifeGate, { kind: "life-at-least" }>, "kind" | "value" | "positive"> extends never
    ? true
    : false
>;
type _AlwaysGateFields = AssertCompared<
  Exclude<keyof Extract<LifeGate, { kind: "always" }>, "kind"> extends never ? true : false
>;
type _NeverGateFields = AssertCompared<
  Exclude<keyof Extract<LifeGate, { kind: "never" }>, "kind"> extends never ? true : false
>;
export type ComparedSkillShape = [
  _SlotFields,
  _EffectFields,
  _ConvertFields,
  _GateKinds,
  _LifeGateFields,
  _AlwaysGateFields,
  _NeverGateFields,
];

export const ORDERS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  const visit = (chosen: number[]) => {
    if (chosen.length === 5) out.push(chosen);
    else for (let slot = 0; slot < 5; slot++) if (!chosen.includes(slot)) visit([...chosen, slot]);
  };
  visit([]);
  return out;
})();

export interface SkillOrderPlan {
  /** First original order index for each distinct sequence of resolved skills. */
  representatives: readonly number[];
  /** Each original order's representative, preserving all 120 indices and their probability weights. */
  sources: Uint8Array;
}

export const FULL_SKILL_ORDER_PLAN: SkillOrderPlan = {
  representatives: ORDERS.map((_, index) => index),
  sources: Uint8Array.from(ORDERS, (_, index) => index),
};

function equalNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a === b || (a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
}

function equalEffect(a: LiveEffect, b: LiveEffect): boolean {
  return (
    a === b ||
    (a.type === b.type &&
      Object.is(a.delta, b.delta) &&
      Object.is(a.seconds, b.seconds) &&
      a.gate.kind === b.gate.kind &&
      (a.gate.kind !== "life-at-least" ||
        (b.gate.kind === "life-at-least" &&
          Object.is(a.gate.value, b.gate.value) &&
          a.gate.positive === b.gate.positive)) &&
      equalNumbers(a.judgements, b.judgements))
  );
}

/** Do not sort effects or judgement lists: their order can change binary32 additions or conversion priority. */
function equalSkill(a: SlotSkill | undefined, b: SlotSkill | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || !Object.is(a.extensionMs, b.extensionMs) || !Object.is(a.recovery, b.recovery)) return false;
  if (a.convert !== b.convert) {
    if (
      !a.convert ||
      !b.convert ||
      !Object.is(a.convert.limit, b.convert.limit) ||
      !equalNumbers(a.convert.judgements, b.convert.judgements)
    )
      return false;
  }
  return (
    a.effects.length === b.effects.length && a.effects.every((effect, index) => equalEffect(effect, b.effects[index]!))
  );
}

// Five slots have only 52 set partitions. Cache the position-equivalence plans, never inventories or score inputs.
const plans = new Map<number, SkillOrderPlan>();

export function skillOrderPlan(slots: readonly SlotSkill[]): SkillOrderPlan {
  const groups: number[] = [];
  let classes = 0;
  let key = 0;
  for (let slot = 0; slot < 5; slot++) {
    let previous = 0;
    while (previous < slot && !equalSkill(slots[slot], slots[previous])) previous++;
    const group = previous === slot ? classes++ : groups[previous]!;
    groups.push(group);
    key = key * 5 + group;
  }
  if (classes === 5) return FULL_SKILL_ORDER_PLAN;
  const cached = plans.get(key);
  if (cached) return cached;
  const representatives: number[] = [];
  const sources = new Uint8Array(ORDERS.length);
  const first = new Map<number, number>();
  ORDERS.forEach((order, index) => {
    let sequence = 0;
    for (const slot of order) sequence = sequence * 5 + groups[slot]!;
    let representative = first.get(sequence);
    if (representative === undefined) {
      representative = index;
      first.set(sequence, index);
      representatives.push(index);
    }
    sources[index] = representative;
  });
  const plan = { representatives, sources };
  plans.set(key, plan);
  return plan;
}

/** Restore before the existing summarizer runs; do not replace its canonical floating-point summation. */
export function restoreOrderScores(scores: Float64Array, plan: SkillOrderPlan): void {
  if (plan === FULL_SKILL_ORDER_PLAN) return;
  for (let index = 0; index < scores.length; index++) scores[index] = scores[plan.sources[index]!]!;
}
