import type { GrowthAction, GrowthCard, GrowthState } from "./growth-comparison";
import type { EventBonusRule } from "./team-builder/data/events";
import type { OwnedMember, OwnedSnap } from "./team-builder/sync/box-view";

export interface GrowthSkill {
  group: string;
  slot: number;
  name: string;
  levels: { level: number; description: string }[];
}
export interface GrowthCatalogCard extends GrowthCard {
  id: number;
  name: string;
  image: string;
  bandId: number | null;
  characterIds: number[];
  attribute: number | null;
  rarity: number | null;
  tagIds: number[] | null;
  skills: GrowthSkill[];
}
export interface GrowthEvent {
  id: string;
  name: string;
  complete: boolean;
  rules: Record<"points" | "items" | "power", EventBonusRule[]>;
}
export interface GrowthPageData {
  schema: "haneoka-growth-page-v1";
  calculationRevision: number;
  locale: string;
  identity: { server: string; sourceId: string; releaseId: string };
  cards: GrowthCatalogCard[];
  bands: { value: string; label: string }[];
  characters: { value: string; label: string }[];
  events: GrowthEvent[];
}
export const growthActions = (kind: GrowthCard["kind"]): GrowthAction[] =>
  kind === "member" ? ["level", "training", "awakening", "live", "gekisou"] : ["level", "break"];
export const growthField = (action: GrowthAction) =>
  ({ level: "lvl", training: "awk", awakening: "rnk", live: "sk", gekisou: "gsk", break: "rnk" })[action];
/** Training and awakening read 1–5 as in the game; limit break counts breaks from 0. */
export const stageDisplay = (action: GrowthAction, value: number): number =>
  action === "break" ? value - 1 : value;
export function ownedGrowth(card: GrowthCatalogCard, owned: OwnedMember | OwnedSnap): GrowthState {
  return card.kind === "support"
    ? { level: owned.level, break: owned.rank }
    : {
        level: owned.level,
        training: (owned as OwnedMember).awake,
        awakening: owned.rank,
        live: (owned as OwnedMember).skill,
        gekisou: (owned as OwnedMember).gekisoSkill,
      };
}
export function growthCap(card: GrowthCard, state: GrowthState): number | null {
  const action = card.kind === "member" ? "training" : "break";
  return card.tracks[action]?.stages.find((row) => row.value === state[action])?.cap ?? null;
}
export function growthSkillLevel(skill: GrowthSkill, card: GrowthCard, state: GrowthState): number | null {
  if (skill.group === "live") return state.live ?? null;
  if (skill.group === "gekisou") return state.gekisou ?? null;
  const action = card.kind === "member" ? "awakening" : "break";
  const row = card.tracks[action]?.stages.find((row) => row.value === state[action]);
  if (skill.group === "leader") return row?.effects.leaderSkillLevel ?? null;
  const key = `${skill.group === "support" ? "support" : "gekisouSupport"}Skill0${skill.slot + 1}Level`;
  return row?.effects[key] ?? null;
}
