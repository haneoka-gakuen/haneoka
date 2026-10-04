import type { EvidenceGap } from "../contracts.ts";
import { dataRows, nativeRow, type DataRow, type TeamBuilderData } from "../data.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";
import type { GekisoResolved } from "./gekiso-mission-luck.ts";

export interface NativeCumulativeJustRule {
  eachCount: number;
  value: number;
  maxCount: number;
  maxValue: number;
}
export interface NativePerfectCumulativeJustEffect extends NativeCumulativeJustRule {
  effectId: number;
  cumulativeConditionId: number;
  /** Qualified projection of the shared native registry under raw JUST zero. */
  rawJustCount: 0;
}
const int = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) &&
  value >= 0 && value <= 0x7fffffff;
const fail = <T>(source: string): GekisoResolved<T> => ({ value: null,
  gaps: [{ code: "native-gekiso-perfect-cumulative-just-unresolved", source }] });

/** ComputeCumulativeJustCountBonus: signed integer division, count cap,
 * native32 multiply, value cap and ordered native32 accumulation. */
export function resolveNativeCumulativeJustBonus(count: number, rules: readonly NativeCumulativeJustRule[]): GekisoResolved<number> {
  if (!int(count) || !Array.isArray(rules) || rules.length > 128 || rules.some(rule =>
    !rule || ![rule.eachCount, rule.value, rule.maxCount, rule.maxValue].every(int)))
    return fail("resolved cumulative JUST native integers");
  let total = 0;
  for (const rule of rules) {
    if (rule.eachCount < 1) continue;
    let repeats = Math.trunc(count / rule.eachCount);
    if (rule.maxCount > 0 && repeats > rule.maxCount) repeats = rule.maxCount;
    let bonus = Number(BigInt.asIntN(32, BigInt(repeats) * BigInt(rule.value)));
    if (rule.maxValue > 0) bonus = Math.min(bonus, rule.maxValue);
    total = (total + bonus) | 0;
  }
  return { value: total, gaps: [] };
}

/** Resolve exact positive member13002 rows. Runtime must prove complete
 * PERFECT histories with no converted or additional JUST before consuming
 * this projection; generic shared cumulative state remains unmodeled. */
export function createNativePerfectCumulativeJustResolver(data: TeamBuilderData) {
  const cumulatives = dataRows(data.skillReference.cumulativeConditions).map(nativeRow);
  const targets = dataRows(data.skillReference.targets).map(nativeRow);
  const sets = dataRows(data.skillReference.conditionSets).map(nativeRow);
  const conditions = dataRows(data.skillReference.conditions).map(nativeRow);
  const group = (id: unknown, type: number, justStart: boolean): boolean => {
    if (!int(id)) return false;
    const rows = sets.filter(row => row.group === id);
    if (rows.length !== 1 || !Array.isArray(rows[0]!.conditionIds) || rows[0]!.conditionIds.length !== 1) return false;
    const conditionId = rows[0]!.conditionIds[0];
    const matches = conditions.filter(row => row.id === conditionId);
    if (matches.length !== 1) return false;
    const row = matches[0]!;
    if (row.conditionType !== type || row.isPositive !== true || !Array.isArray(row.conditionValues) ||
      row.conditionValues.length || !Array.isArray(row.conditionTargetIDs)) return false;
    if (!justStart) return row.conditionTargetIDs.length === 0;
    if (row.conditionTargetIDs.length !== 1) return false;
    const targetId = row.conditionTargetIDs[0];
    const selected = targets.filter(target => target.id === targetId);
    return selected.length === 1 && selected[0]!.skillTargetType === 5 && selected[0]!.gekisouMissionType === 3;
  };
  return (row: DataRow): GekisoResolved<NativePerfectCumulativeJustEffect> => {
    const source = `effect:${row.id}/cumulative:${row.skillCumulativeConditionID}`;
    if (!nativeGekisoAllComboDriverSupports(data.identity) || row.skillEffectType !== 13002 || !int(row.id) ||
      !int(row.effectValue) || row.skillTriggerType !== 1 || row.skillConditionGroup !== 0 ||
      row.activationTimeSecond !== 9999 || !group(row.skillTriggerConditionGroup, 7010, true) ||
      !group(row.skillReleaseConditionGroup, 7013, false) || !Array.isArray(row.skillTargetIDs) || row.skillTargetIDs.length ||
      ["effectExecuteLimitCount", "effectExecuteLimitResetConditionGroup", "effectLimitCount", "maxEffectValue"].some(key => row[key] !== 0))
      return fail(source);
    const selected = cumulatives.filter(value => value.id === row.skillCumulativeConditionID);
    if (selected.length !== 1) return fail(source);
    const cumulative = selected[0]!;
    if (cumulative.skillCumulativeConditionType !== 1000 || !Array.isArray(cumulative.conditionValues) ||
      cumulative.conditionValues.length !== 1 || !int(cumulative.conditionValues[0]) || cumulative.conditionValues[0] < 1 ||
      !int(cumulative.maxCumulativeCount) || !Array.isArray(cumulative.conditionTargetIDs) || cumulative.conditionTargetIDs.length !== 1)
      return fail(source);
    const targetId = cumulative.conditionTargetIDs[0];
    const target = targets.filter(value => value.id === targetId);
    if (target.length !== 1 || target[0]!.skillTargetType !== 4 || target[0]!.judgement !== 6) return fail(source);
    return { value: { effectId: row.id, cumulativeConditionId: Number(row.skillCumulativeConditionID),
      eachCount: cumulative.conditionValues[0], value: row.effectValue,
      maxCount: cumulative.maxCumulativeCount, maxValue: 0, rawJustCount: 0 }, gaps: [] as EvidenceGap[] };
  };
}
