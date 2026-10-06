/** Performers of a deck for the whole-live simulation. */
import type { EngineMaster } from "../master";
import type { MemberState, SnapState } from "../power";
import type { Performer } from "./conditions";

/** The performer of a member card paired with a snap (Gekisou fields are read only by a live with Gekisou). */
export function performer(master: EngineMaster, m: MemberState, s: SnapState | null): Performer {
  const card = m.card;
  const pairs = (ids: readonly number[], levels: readonly number[]) =>
    ids.every((id) => !id) ? [] : ids.map((id, i) => [id, levels[i] ?? 0] as const).filter(([id]) => id !== 0);
  return {
    liveSkill: [card.liveSkillId, m.growth.liveSkillLevel],
    supportSkills: s ? pairs(s.card.supportSkillIds, s.skillLevels) : [],
    bandId: card.bandId,
    characterId: card.characterId,
    cardType: card.cardType,
    tagIds: card.bestTags,
    liveSkillCategories: m.liveSkillCategories,
    gekisouSkillCategories: m.gekisoSkillCategories,
    gekisouMissionType: m.gekisoMissionType,
    gekisouSkill: card.gekisoSkillId && master.gekisoSkills.has(card.gekisoSkillId) ? [card.gekisoSkillId, m.growth.gekisoSkillLevel] : null,
    gekisouSupportSkills: s ? pairs(s.card.gekisoSupportSkillIds, s.gekisoSkillLevels) : [],
  };
}
