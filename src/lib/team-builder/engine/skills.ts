/** Normal-live skill shapes of one member and its equipped snap. */
import type { ConditionRow, EngineMaster, SkillEffectRow } from "./master";
import { matchesTargets, type MemberState, type SnapState } from "./power";

const f = Math.fround;
/** Static checks resolved before the live; dynamic ones stay symbolic. */
export type LifeGate = { kind: "always" } | { kind: "life-at-least"; value: number; positive: boolean } | { kind: "never" };
export interface LiveEffect {
  type: 2000 | 2004;
  /** Native mill-percent delta added to the factor (value/10000·100000). */
  delta: number;
  seconds: number;
  gate: LifeGate;
  /** 2004 only: simulate judgements whose factor it raises (5 Perfect, 6 Just, 4 Great). */
  judgements: readonly number[];
}
export interface SlotSkill {
  effects: readonly LiveEffect[];
  /** 15000 sum, ms, binary32. */
  extensionMs: number;
  /** 3001 life recovery on the member's activation. */
  recovery: number;
  /** 12006: judgements converted to Perfect inside the member's window, and the per-activation limit. */
  convert: { judgements: readonly number[]; limit: number } | null;
}

export const scoreDelta = (value: number) => Math.floor(f(f(f(value) / f(10000)) * f(100000)));
/** AddJudgementNoteScoreUpFactor rounds (ties to even) after the binary32 product. */
export function judgementDelta(value: number) {
  const scaled = f(f(f(value) / f(10000)) * 100000);
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  return fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
}

type Context = { member: MemberState };
function conditionValue(master: EngineMaster, row: ConditionRow, context: Context): boolean | "life" | null {
  let match: boolean | "life" | null;
  switch (row.type) {
    case 5000:
      match = matchesTargets(master, context.member, row.targetIds);
      break;
    case 4010:
    case 5020:
      // Same-member live skill trigger: the snap fires with its member's activation.
      return row.positive ? true : null;
    case 2001:
      return "life";
    default:
      match = null;
  }
  return match === null ? null : row.positive ? match : !match;
}
/** OR over sets of AND conditions; a life comparison stays dynamic. */
function groupHolds(master: EngineMaster, group: number, context: Context): { holds: boolean; life: ConditionRow | null } | null {
  if (group <= 0) return { holds: true, life: null };
  const sets = master.conditionSets.get(group);
  if (!sets?.length) return null;
  let any = false;
  let life: ConditionRow | null = null;
  for (const set of sets) {
    let all = true;
    for (const id of set) {
      const row = master.conditions.get(id);
      const value = row ? conditionValue(master, row, context) : null;
      if (value === null) return null;
      if (value === "life") life = row!;
      else if (!value) all = false;
    }
    if (all) any = true;
  }
  return { holds: any, life };
}
const judgementsOf = (master: EngineMaster, ids: readonly number[]) =>
  ids.map((id) => master.targets.get(id)?.judgement ?? -1).filter((value) => value >= 3 && value <= 6);
const atLevel = (rows: readonly SkillEffectRow[] | undefined, level: number) => (rows ?? []).filter((row) => row.level === level);

export interface SkillIssues {
  unsupported: string[];
}
export function resolveSlotSkill(
  master: EngineMaster,
  member: MemberState,
  snap: SnapState | null,
  issues?: SkillIssues,
): SlotSkill {
  const context = { member };
  const effects: LiveEffect[] = [];
  for (const row of atLevel(master.liveSkills.get(member.card.liveSkillId), member.growth.liveSkillLevel)) {
    if (row.type !== 2000 && row.type !== 2004) {
      issues?.unsupported.push(`live:${member.card.liveSkillId}:${row.type}`);
      continue;
    }
    const condition = groupHolds(master, row.conditionGroup, context);
    if (!condition) {
      issues?.unsupported.push(`live-condition:${row.conditionGroup}`);
      continue;
    }
    const gate: LifeGate = !condition.holds
      ? { kind: "never" }
      : condition.life
        ? { kind: "life-at-least", value: condition.life.values[0] ?? 0, positive: condition.life.positive }
        : { kind: "always" };
    if (gate.kind === "never") continue;
    effects.push({
      type: row.type,
      delta: row.type === 2000 ? scoreDelta(row.value) : judgementDelta(row.value),
      seconds: f(row.seconds),
      gate,
      judgements: row.type === 2004 ? judgementsOf(master, row.targetIds) : [],
    });
  }
  let extensionMs = f(0);
  let recovery = 0;
  let convert: SlotSkill["convert"] = null;
  if (snap)
    snap.card.supportSkillIds.forEach((skillId, slot) => {
      if (!skillId) return;
      for (const row of atLevel(master.supportSkills.get(skillId), snap.skillLevels[slot] ?? 1)) {
        const enabled = groupHolds(master, row.conditionGroup, context);
        const trigger = groupHolds(master, row.triggerGroup, context);
        if (!enabled || !trigger) {
          issues?.unsupported.push(`support-condition:${skillId}`);
          continue;
        }
        if (!enabled.holds) continue;
        if (row.type === 15000) extensionMs = f(extensionMs + f(row.value));
        else if (row.type === 3001) recovery += row.value;
        else if (row.type === 12006) convert = { judgements: judgementsOf(master, row.targetIds), limit: row.limitCount || Infinity };
        else if (row.type !== 3003) issues?.unsupported.push(`support:${skillId}:${row.type}`);
      }
    });
  return { effects, extensionMs, recovery, convert };
}

/** Window length of an effect: ceil(seconds·1000 + extension) in binary32. */
export const windowMs = (seconds: number, extensionMs: number) => Math.ceil(f(f(f(seconds) * f(1000)) + extensionMs));
