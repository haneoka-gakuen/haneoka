import { asRecord, type RecordValue } from "../lib/static-catalog-source";
import { associationRows } from "../lib/entity-associations";
import { resolveLocalizedText } from "../lib/localized-text";
import type { GrowthAction, GrowthStage, GrowthStat, GrowthTrack } from "../lib/growth-comparison";
import type { GrowthCatalogCard } from "../lib/growth-catalog";

const rows = associationRows;
const value = (row: RecordValue, key: string) => row[key] ?? (asRecord(row.raw) || row)[`_${key}`];
const number = (value: unknown): number | undefined =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : undefined;
const rates = (row: RecordValue): GrowthStat | undefined => {
  const values = ["performanceRate", "technicRate", "visualRate"].map((key) => number(value(row, key)));
  return values.every((v) => v !== undefined) ? (values as unknown as GrowthStat) : undefined;
};
export function projectGrowthCard(
  item: RecordValue,
  aux: RecordValue,
  support: boolean,
  locale: string,
  server: string,
  bandId: number | null,
): GrowthCatalogCard {
  const text = (v: unknown) => resolveLocalizedText(v, locale).text;
  const progression = asRecord(aux.progression) || {};
  const associations = asRecord(aux.associations) || {};
  const upgrades = rows(associations.upgrades);
  const tracks: Partial<Record<GrowthAction, GrowthTrack>> = {};
  const costs = (kind: string) =>
    upgrades
      .filter((row) => row.kind === kind)
      .map((row) => ({
        from: Number(row.from),
        to: Number(row.to),
        items: rows(row.costs).map((cost) => {
          const reference = asRecord(cost.reference);
          return {
            identity: reference ? `${reference.resource}:${reference.id}` : "",
            name: text(reference?.name),
            count: typeof cost.count === "number" ? cost.count : Number.NaN,
            ...(reference
              ? {
                  href: `/${server}/${locale}/${reference.resource === "cards" ? "member-cards" : reference.resource}/${reference.id}/`,
                }
              : {}),
          };
        }),
      }));
  const stages = (source: unknown, key: string, effects: readonly string[] = []): GrowthStage[] =>
    rows(source).map((row) => ({
      value: Number(value(row, key)),
      ...(key === "level" && /^\d+$/u.test(String(value(row, "exp"))) ? { exp: String(value(row, "exp")) } : {}),
      rates: rates(row),
      cap: number(value(row, "limitLevel")),
      effects: Object.fromEntries(
        effects.flatMap((key) => {
          const v = number(value(row, key));
          return v === undefined ? [] : [[key, v]];
        }),
      ),
    }));
  tracks.level = { stages: stages(aux[support ? "support-card-levels" : "member-card-levels"], "level"), costs: [] };
  if (support)
    tracks.break = {
      stages: stages(progression.supportCardRanks, "rank", [
        "cardTypeLinkBonusRate",
        "supportSkill01Level",
        "supportSkill02Level",
        "gekisouSupportSkill01Level",
        "gekisouSupportSkill02Level",
      ]),
      costs: costs("rank"),
    };
  else {
    tracks.training = {
      stages: stages(progression.memberCardAwake, "awakeCount").map((stage) => ({
        ...stage,
        cap: number(
          value(
            rows(progression.memberCardLevelLimits).find((row) => Number(value(row, "awakeCount")) === stage.value) ||
              {},
            "limitLevel",
          ),
        ),
      })),
      costs: costs("training"),
    };
    tracks.awakening = {
      stages: stages(progression.memberCardRanks, "rank", [
        "leaderSkillLevel",
        "musicTypeBonusRate",
        "musicTagBonusRate",
      ]),
      costs: costs("awakening"),
    };
  }
  const skills = rows(associations.skills).map((skill) => ({
    group: String(skill.group),
    slot: Number(skill.slot),
    name: text(skill.name),
    levels: rows(skill.levels).map((level) => ({ level: Number(level.level), description: text(level.description) })),
  }));
  if (tracks.break) {
    const keys = new Set(
      skills.map((skill) => `${skill.group === "support" ? "support" : "gekisouSupport"}Skill0${skill.slot + 1}Level`),
    );
    tracks.break = {
      ...tracks.break,
      stages: tracks.break.stages.map((stage) => ({
        ...stage,
        effects: Object.fromEntries(
          Object.entries(stage.effects).filter(([key]) => !key.endsWith("Level") || keys.has(key)),
        ),
      })),
    };
  }
  if (!support)
    for (const action of ["live", "gekisou"] as const) {
      const skill = skills.find((skill) => skill.group === action);
      if (skill)
        tracks[action] = {
          stages: skill.levels.map((level) => ({ value: level.level, effects: {} })),
          costs: costs(action),
        };
    }
  const stat = asRecord(item.stat) || item;
  const maxima = ["performance", "technique", "visual"].map((key) => number(stat[key]));
  const images = asRecord(item.images) || {};
  const characterIds = Array.isArray(item.characterIds)
    ? item.characterIds.map(Number)
    : item.characterId
      ? [Number(item.characterId)]
      : [];
  return {
    id: Number(item[support ? "supportCardId" : "cardId"]),
    kind: support ? "support" : "member",
    name: text(item.prefix ?? item.cardName ?? item.name),
    image: String(images.thumbnail ?? item.thumbnailImage ?? ""),
    bandId,
    characterIds,
    attribute: number(item.cardType) ?? null,
    rarity: number(item.rarity) ?? null,
    tagIds: Array.isArray(item.tagIds) ? item.tagIds.map(Number) : null,
    maximum: maxima.every((v) => v !== undefined) ? (maxima as unknown as GrowthStat) : null,
    tracks,
    skills,
  };
}
