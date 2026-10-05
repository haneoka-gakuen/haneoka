import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { GekisoResolved, GekisoSkillBinding } from "./gekiso-mission-luck.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";

/** Current native RushPlaying checker resets its retained bit at live start.
 * It can set it only while a LUCK range is Playing and its LuckScore is Rush.
 * A qualified fresh no-LUCK driver therefore never activates these bindings.
 * This is an inactive-trigger projection, not support score/lifecycle support. */
export function resolveDormantNativeLuckRushSupports(data: TeamBuilderData,
  bindings: readonly GekisoSkillBinding[], missions: readonly number[], freshStart: boolean): GekisoResolved<number> {
  const fail = (source: string): GekisoResolved<number> => ({ value: null,
    gaps: [{ code: "native-gekiso-support-phase-factory-unresolved", source }] });
  if (!freshStart || !nativeGekisoAllComboDriverSupports(data.identity) || missions.length !== 3 ||
    missions.some(mission => ![1, 3].includes(mission))) return fail("fresh qualified no-LUCK chart driver");
  const settings = dataRows(data.skillReference.effectSettings).map(nativeRow).filter(row => row.skillEffectType === 2000);
  if (settings.length !== 1 || settings[0]!.phase !== 2) return fail("native phase2 ScoreFactorUp effect");
  const sets = dataRows(data.skillReference.conditionSets).map(nativeRow);
  const conditions = new Map(dataRows(data.skillReference.conditions).map(nativeRow).map(row => [row.id, row]));
  const targets = new Map(dataRows(data.skillReference.targets).map(nativeRow).map(row => [row.id, row]));
  const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
  const condition = (group: unknown) => {
    const rows = sets.filter(row => row.group === group);
    if (rows.length !== 1 || !Array.isArray(rows[0]!.conditionIds) || rows[0]!.conditionIds.length !== 1) return null;
    return conditions.get(rows[0]!.conditionIds[0]) ?? null;
  };
  for (const binding of bindings) {
    if (!["01", "02"].includes(binding.physicalSupportSlot ?? "") ||
      !integer(binding.nativeCompactSkillIndex) || binding.nativeCompactSkillIndex > 1 ||
      binding.skill.mission !== 2 || binding.skill.supportExecTiming !== 1 || !binding.effectsAtLevel.length)
      return fail(`support:${binding.skill.id}/physical binding`);
    for (const row of binding.effectsAtLevel) {
      const trigger = condition(row.skillTriggerConditionGroup), enable = condition(row.skillConditionGroup);
      if (!trigger || trigger.conditionType !== 7021 || trigger.isPositive !== true ||
        !Array.isArray(trigger.conditionValues) || trigger.conditionValues.length ||
        !Array.isArray(trigger.conditionTargetIDs) || trigger.conditionTargetIDs.length ||
        !enable || enable.conditionType !== 5000 || typeof enable.isPositive !== "boolean" ||
        !Array.isArray(enable.conditionValues) || enable.conditionValues.length ||
        !Array.isArray(enable.conditionTargetIDs) || !enable.conditionTargetIDs.length ||
        !enable.conditionTargetIDs.every(id => {
          const target = targets.get(id);
          return target && integer(target.bandID) && target.bandID > 0 &&
            ["characterID", "cardType", "tagID", "liveMusicType", "gekisouMissionType"].every(key => target[key] === 0) &&
            Array.isArray(target.liveSkillCategories) && !target.liveSkillCategories.length &&
            Array.isArray(target.gekisouSkillCategories) && !target.gekisouSkillCategories.length;
        }) || row.skillEffectType !== 2000 || row.skillTriggerType !== 2 || row.activationTimeSecond !== 0 ||
        !integer(row.id) || !integer(row.effectValue) || row.skillReleaseConditionGroup !== 0 ||
        !Array.isArray(row.skillTargetIDs) || row.skillTargetIDs.length ||
        ["skillCumulativeConditionID", "effectExecuteLimitCount", "effectExecuteLimitResetConditionGroup", "effectLimitCount", "maxEffectValue"]
          .some(key => row[key] !== 0) ||
        (row.sourceTable !== undefined && row.sourceTable !== "MasterGekisouSupportSkillEffect"))
        return fail(`support:${binding.skill.id}/effect:${String(row.id)}`);
    }
  }
  return { value: bindings.length, gaps: [] };
}
