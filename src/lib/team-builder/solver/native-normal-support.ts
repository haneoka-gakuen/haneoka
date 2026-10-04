import type { EvidenceGap, OptimizationInput } from "../contracts.ts";
import { dataRows, nativeRow, type DataRow, type TeamBuilderData } from "../data.ts";
import { resolveNormalSkillEffects, type NormalSkillPlan } from "./normal-skills.ts";
import { createNativeNormalAPNeutralResolver } from "./native-normal-ap-neutral.ts";

type Match = boolean | "member-event" | null;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const ids = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0);

/** Native condition sets are OR groups of AND children. SnapMemberTarget checks
 * the assigned member; IsPositive=false wraps that checker in a native NOT.
 * This scope resolves type15000 with a same-member Live trigger and static band
 * conditions. Other support state machines retain their own evidence gap.
 */
export function createNativeNormalSupportResolver(data: TeamBuilderData,
  input: Pick<OptimizationInput, "members" | "snapshots"> & { evaluation: Pick<OptimizationInput["evaluation"], "mode"> }) {
  const neutral = createNativeNormalAPNeutralResolver(data);
  const conditions = new Map(
    dataRows(data.skillReference.conditions)
      .map(nativeRow)
      .map((row) => [row.id, row]),
  );
  const targets = new Map(
    dataRows(data.skillReference.targets)
      .map(nativeRow)
      .map((row) => [row.id, row]),
  );
  const groups = new Map<unknown, DataRow[]>();
  for (const row of dataRows(data.skillReference.conditionSets).map(nativeRow))
    groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const phases = Object.fromEntries(
    dataRows(data.skillReference.effectSettings)
      .map(nativeRow)
      .map((row) => [Number(row.skillEffectType), Number(row.phase)]),
  );
  const members = new Map(input.members.map((member) => [member.instanceId, member]));
  const snapshots = new Map(
    input.snapshots.map((snapshot) => [
      snapshot.instanceId,
      {
        option: snapshot,
        card: data.snapshots[String(snapshot.cardId)],
        rows: snapshot.supportSkills?.map((skill) =>
          dataRows(data.skills.support?.[String(skill.id)]?.effects).map(nativeRow),
        ),
      },
    ]),
  );
  const cache = new Map<string, readonly [NormalSkillPlan | null, NormalSkillPlan | null]>();
  const combine = (values: Match[], and: boolean): Match => {
    if (values.includes(!and)) return !and;
    if (values.includes(null)) return null;
    return values.includes("member-event") ? "member-event" : and;
  };
  const condition = (row: DataRow, bandId: number): Match => {
    if (typeof row.isPositive !== "boolean") return null;
    let match: Match = null;
    if (row.conditionType === 4010 && Array.isArray(row.conditionTargetIDs) && !row.conditionTargetIDs.length)
      return row.isPositive ? "member-event" : null;
    if (row.conditionType === 5000 && ids(row.conditionTargetIDs)) {
      const list = row.conditionTargetIDs.map((id) => targets.get(id));
      // The current duration cards target a band. Resolve additional target
      // dimensions only when their full native member contract is implemented.
      if (
        list.every(
          (target) =>
            target &&
            Number.isSafeInteger(target.bandID) &&
            Number(target.bandID) >= 0 &&
            target.characterID === 0 &&
            target.cardType === 0 &&
            target.tagID === 0 &&
            target.liveMusicType === 0 &&
            target.gekisouMissionType === 0 &&
            Array.isArray(target.liveSkillCategories) &&
            !target.liveSkillCategories.length &&
            Array.isArray(target.gekisouSkillCategories) &&
            !target.gekisouSkillCategories.length,
        )
      )
        match = list.some((target) => Number(target!.bandID) > 0 && target!.bandID === bandId);
    }
    return match === null ? null : row.isPositive ? match : !match;
  };
  const group = (id: unknown, bandId: number): Match => {
    if (id === 0) return true;
    const sets = groups.get(id);
    if (!sets?.length) return null;
    return combine(
      sets.map((set) => {
        if (!ids(set.conditionIds)) return null;
        return combine(
          set.conditionIds.map((id) => {
            const row = conditions.get(id);
            return row ? condition(row, bandId) : null;
          }),
          true,
        );
      }),
      false,
    );
  };
  return {
    resolve(snapshotId: string | null, memberId: string): readonly [NormalSkillPlan | null, NormalSkillPlan | null] {
      if (snapshotId === null) return [null, null];
      const key = JSON.stringify([snapshotId, memberId]);
      const found = cache.get(key);
      if (found) {
        cache.delete(key);
        cache.set(key, found);
        return found;
      }
      const prepared = snapshots.get(snapshotId),
        member = members.get(memberId);
      const snapshot = prepared?.option,
        card = prepared?.card;
      const error = (code: string): readonly [NormalSkillPlan, null] => [
        { effects: [], gaps: [gap(code, snapshotId)] },
        null,
      ];
      if (
        !snapshot ||
        !member ||
        !card ||
        !snapshot.supportSkills ||
        snapshot.supportSkills.length > 2 ||
        snapshot.supportSkills.length !== card.supportSkillIds.length ||
        snapshot.supportSkills.some((skill, slot) => skill.id !== card.supportSkillIds[slot])
      )
        return error("native-normal-support-slots-unresolved");
      const plans = snapshot.supportSkills.map((skill, slot) => {
        if (skill.id === 0) return null;
        const rows = prepared!.rows![slot]!;
        const selected = rows.filter(
          (row) => row.level === skill.level && (row.supportSkillID === undefined || row.supportSkillID === skill.id),
        );
        if (!selected.length)
          return {
            effects: [],
            gaps: [gap("native-normal-skill-level-unresolved", `support:${skill.id}/level:${skill.level}`)],
          };
        const accepted = selected.filter((row) => {
          // Pure recovery and conversions are score-equivalent in this AP scope.
          // Validate static enable/own-member trigger before omitting the effect.
          return !(
            input.evaluation.mode === "normal" &&
            neutral(row) &&
            typeof group(row.skillConditionGroup, member.bandId) === "boolean" &&
            group(row.skillTriggerConditionGroup, member.bandId) === "member-event"
          );
        });
        if (!accepted.length) return { effects: [], gaps: [] };
        return resolveNormalSkillEffects({
          rows: accepted,
          kind: "support",
          skillId: skill.id,
          level: skill.level,
          phaseByEffectType: phases,
          resolveCondition: (row) => {
            if (row.skillEffectType !== 15000 || row.skillTriggerType !== 1 || row.skillReleaseConditionGroup !== 0)
              return null;
            const enabled = group(row.skillConditionGroup, member.bandId);
            const trigger = group(row.skillTriggerConditionGroup, member.bandId);
            if (enabled === false) return { activation: [] };
            return enabled === true && trigger === "member-event" ? { activation: "member-event" } : null;
          },
        });
      });
      const result = [plans[0] ?? null, plans[1] ?? null] as const;
      if (cache.size >= 512) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    },
  };
}
