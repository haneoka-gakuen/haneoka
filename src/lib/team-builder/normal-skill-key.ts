import type { NormalPreparationInput } from "./solver/normal-preparation-cache.ts";
import type { NormalSkillPlan } from "./solver/normal-skills.ts";

function inactive(plan: NormalSkillPlan | null): boolean {
  return plan === null || (!!plan && Object.getPrototypeOf(plan) === Object.prototype &&
    Object.keys(plan).every(key => key === "effects" || key === "gaps") &&
    Array.isArray(plan.effects) && plan.effects.length === 0 && Array.isArray(plan.gaps) && plan.gaps.length === 0);
}

/** Key-only equivalence for two fully resolved inactive support slots.
 * The authoritative builder still receives its original physical-slot input.
 * An active second slot retains the empty first plan and its native compact index. */
export function normalSkillPreparationKeyInput(input: NormalPreparationInput): NormalPreparationInput {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || !Array.isArray(input.formation)) return input;
  let changed = false;
  const formation = input.formation.map(member => {
    if (!member || Object.getPrototypeOf(member) !== Object.prototype ||
      !Array.isArray(member.supports) || member.supports.length !== 2 ||
      !inactive(member.supports[0]) || !inactive(member.supports[1]) ||
      member.supports.every((plan: NormalSkillPlan | null) => plan === null)) return member;
    changed = true;
    return { ...member, supports: [null, null] as const };
  });
  return changed ? { ...input, formation } : input;
}
