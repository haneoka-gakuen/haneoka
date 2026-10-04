import type { MemberOption, NativeEventScene, SnapshotOption } from "../contracts.ts";
import { dataRows, nativeRow, objectRow, type TeamBuilderData } from "../data.ts";
import type { PracticalDirection } from "../practical-search.ts";
import { createNativeNormalSupportResolver } from "./native-normal-support.ts";
import { resolveNormalSkillEffects } from "./normal-skills.ts";
import { sumEventEffectBP, type NativeEventEffect, type EventMember, type EventSnapshot } from "./event-rewards.ts";
import type { InventoryV1 } from "../inventory.ts";
import { validateNativeEventScene } from "./native-event-scene.ts";
import { nativeRuleSupports } from "./native-rule-profile.ts";

/** Dimensionless search priorities, with pair/leader terms consumed by the
 * scheduler. These are features, never a score, a power value or a bound. */
export interface NativePracticalFeatureDirection extends PracticalDirection {
  pairs?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  leaders?: Readonly<Record<string, number>>;
}
const total = (v: { performance: number; technique: number; visual: number }) =>
  v.performance + v.technique + v.visual;
const normalized = (values: Record<string, number>) => {
  const maximum = Math.max(0, ...Object.values(values));
  return Object.fromEntries(Object.entries(values).map(([id, value]) =>
    [id, maximum > 0 && Number.isFinite(value) && value >= 0 ? value / maximum : 0]));
};

export function createNativePracticalFeatureDirections(data: TeamBuilderData, inventory: InventoryV1,
  members: readonly MemberOption[], snapshots: readonly SnapshotOption[], scene?: NativeEventScene): NativePracticalFeatureDirection[] {
  const growth = normalized(Object.fromEntries(members.map(member => [member.instanceId, total(member.stats)])));
  const photoPower = normalized(Object.fromEntries(snapshots.map(photo => [photo.instanceId, photo.bonusBP ? total(photo.bonusBP) : 0])));
  const phases = Object.fromEntries(dataRows(data.skillReference.effectSettings).map(nativeRow)
    .map(row => [Number(row.skillEffectType), Number(row.phase)]));
  const targets = new Map(dataRows(data.skillReference.targets).map(nativeRow).map(row => [row.id, row]));
  const area = normalized(Object.fromEntries(members.map(member => {
    const plan = resolveNormalSkillEffects({ rows: dataRows(data.skills.live?.[String(member.liveSkillId)]?.effects),
      kind: "live", skillId: member.liveSkillId, level: member.liveSkillLevel, phaseByEffectType: phases,
      resolveJudgements: row => {
        if (!Array.isArray(row.skillTargetIDs)) return null;
        const values = row.skillTargetIDs.map(id => targets.get(id)?.judgement);
        return values.every(value => typeof value === "number" && [3, 4, 5, 6].includes(value)) ? values as number[] : null;
      } });
    return [member.instanceId, plan.gaps.length ? 0 : plan.effects.reduce((sum, effect) =>
      sum + ((effect.type === 2000 || (effect.type === 2004 && effect.judgements?.includes(5)))
        ? effect.value * effect.seconds : 0), 0)];
  })));
  // Cap heuristic pair tables independently of the legal candidate domain.
  // Larger inventories retain scalar directions and the same full evaluator.
  const pairRowsKnown = members.length * snapshots.length <= 8192;
  const supports = createNativeNormalSupportResolver(data, { members: [...members], snapshots: [...snapshots], evaluation: { mode: "normal" } });
  const extensionRows: Record<string, Record<string, number>> = {}, powerRows: Record<string, Record<string, number>> = {};
  for (const member of members) {
    extensionRows[member.instanceId] = {}; powerRows[member.instanceId] = {};
    for (const photo of pairRowsKnown ? snapshots : []) {
      const plans = supports.resolve(photo.instanceId, member.instanceId);
      const extension = plans.some(plan => plan?.gaps.length) ? 0 : plans.reduce((sum, plan) =>
        sum + (plan?.effects.reduce((value, effect) => value +
          (effect.type === 15000 && effect.condition.activation === "member-event" ? effect.value : 0), 0) ?? 0), 0);
      extensionRows[member.instanceId]![photo.instanceId] = extension * area[member.instanceId]!;
      // Power percentage and same-attribute link are separate diversity signals.
      // The complete native slot formula, including floors, runs only in full().
      const bonus = photo.bonusBP;
      powerRows[member.instanceId]![photo.instanceId] = bonus ?
        member.stats.performance * bonus.performance + member.stats.technique * bonus.technique + member.stats.visual * bonus.visual +
        (data.snapshots[String(photo.cardId)]?.attribute === member.attribute ? total(member.stats) * 500 : 0) : 0;
    }
  }
  const normalizePairs = (rows: Record<string, Record<string, number>>) => {
    const maximum = Math.max(0, ...Object.values(rows).flatMap(row => Object.values(row)));
    return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id,
      Object.fromEntries(Object.entries(row).map(([photo, value]) => [photo, maximum > 0 ? value / maximum : 0]))]));
  };
  const extension = normalizePairs(extensionRows), power = normalizePairs(powerRows);
  const directions: NativePracticalFeatureDirection[] = [
    { id: "growth", members: growth, snapshots: photoPower, pairs: power },
    { id: "live-area", members: area, snapshots: photoPower, leaders: area },
    { id: "photo-power-binding", members: growth, snapshots: photoPower, pairs: power },
    { id: "photo-live-extension", members: area, snapshots: photoPower, pairs: extension, leaders: area },
    { id: "growth-live", members: Object.fromEntries(members.map(member =>
      [member.instanceId, growth[member.instanceId]! + area[member.instanceId]!])), snapshots: photoPower, pairs: extension, leaders: area },
  ];
  if (scene && nativeRuleSupports(data.identity, "ordinary-event-points") && !validateNativeEventScene(data, scene).length) {
    const event = data.events[String(scene.eventId)];
    const tables = objectRow(event?.tables ?? event?.support);
    const rows = dataRows(tables.MasterEventEffect).map(nativeRow).filter(row => row.eventId === scene.eventId);
    const ints = ["eventId", "eventBonusType", "resourceTypeConstraint", "characterId", "bandId", "cardType", "tagId", "memberCardId", "supportCardId",
      "rank1EffectValue", "rank2EffectValue", "rank3EffectValue", "rank4EffectValue", "rank5EffectValue"];
    if (Array.isArray(tables.MasterEventEffect) && rows.every(row => [0, 1, 2].includes(Number(row.eventBonusType)) && ints.every(key =>
      typeof row[key] === "number" && Number.isInteger(row[key]) && Number(row[key]) >= -2147483648 && Number(row[key]) <= 2147483647))) {
      const effects = rows.map(row => ({ eventId: Number(row.eventId), bonusType: Number(row.eventBonusType),
        resourceTypeConstraint: Number(row.resourceTypeConstraint), characterId: Number(row.characterId), bandId: Number(row.bandId),
        cardType: Number(row.cardType), tagId: Number(row.tagId), memberCardId: Number(row.memberCardId), supportCardId: Number(row.supportCardId),
        rankValues: [1, 2, 3, 4, 5].map(rank => Number(row[`rank${rank}EffectValue`])) })) as NativeEventEffect[];
      for (const axis of [0, 1, 2] as const) {
        const memberValues: Record<string, number> = {}, photoValues: Record<string, number> = {};
        for (const member of members) {
          const card = data.members[String(member.cardId)], state = inventory.members.find(row => row.instanceId === member.instanceId);
          if (!card || !state?.awakening || !Array.isArray(card.bestMusicTagIds)) continue;
          const subject: EventMember = { cardId: card.id, characterId: card.characterId, bandId: card.bandId,
            cardType: card.attribute, musicTagIds: card.bestMusicTagIds, rank: state.awakening };
          memberValues[member.instanceId] = sumEventEffectBP(effects, [subject], [], axis);
        }
        for (const photo of snapshots) {
          const card = data.snapshots[String(photo.cardId)], state = inventory.snapshots.find(row => row.instanceId === photo.instanceId);
          if (!card || !state?.awakening || !Array.isArray(card.characterIds)) continue;
          const bands = card.characterIds.map(id => data.characters[String(id)]?.bandId);
          if (bands.some(band => typeof band !== "number" || !Number.isInteger(band) || band < 1)) continue;
          const subject: EventSnapshot = { cardId: card.id, characterIds: card.characterIds,
            bandIds: bands as number[], cardType: card.attribute, rank: state.awakening };
          photoValues[photo.instanceId] = sumEventEffectBP(effects, [], [subject], axis);
        }
        directions.push({ id: `event-bp:${axis}`, members: normalized(memberValues), snapshots: normalized(photoValues) });
      }
    }
  }
  for (const attribute of [...new Set(members.map(member => member.attribute))].slice(0, 4))
    directions.push({ id: `attribute:${attribute}`, members: Object.fromEntries(members.map(member =>
      [member.instanceId, growth[member.instanceId]! + Number(member.attribute === attribute)])), snapshots: photoPower, pairs: power });
  for (const band of [...new Set(members.map(member => member.bandId))].slice(0, 4))
    directions.push({ id: `band:${band}`, members: Object.fromEntries(members.map(member =>
      [member.instanceId, growth[member.instanceId]! + Number(member.bandId === band)])), snapshots: photoPower, pairs: extension });
  return directions;
}
