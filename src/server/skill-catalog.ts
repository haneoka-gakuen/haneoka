import {
  skillDisplay,
  associationRows,
  upgradeSteps,
  entityReference,
  type UpgradeStep,
} from "../lib/entity-associations";
import {
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  asRecord,
} from "../lib/static-catalog-source";
import type { ReleaseServer } from "../lib/resource-route";
export { skillPageId } from "../lib/skill-page";

const families = {
  leader: "leader-skills",
  live: "skills",
  gekisou: "gekisou-skills",
  support: "support-skills",
  gekisouSupport: "gekisou-support-skills",
} as const;

export type SkillFamily = keyof typeof families;
export interface SkillCatalogEntry {
  key: string;
  id: string;
  family: SkillFamily;
  name: unknown;
  image: string;
  effects: Array<{ id: number; name: unknown }>;
  levels: Array<{ level: number; description: unknown; descriptionLocales?: string[] }>;
  cards: Array<{
    kind: "member-cards" | "support-cards";
    id: string;
    name: unknown;
    image: string;
    costGroup?: number;
    costKey?: string;
  }>;
  costs: Array<{
    key: string;
    kind: "level" | "awakening" | "rank";
    group: number;
    steps: UpgradeStep[];
    cardIds: string[];
  }>;
}
export interface SkillCatalogPayload {
  server: ReleaseServer;
  releaseId: string;
  sourceId: string;
  entries: SkillCatalogEntry[];
}

const payloads = new Map<ReleaseServer, Promise<SkillCatalogPayload>>();

/** One immutable server revision owns both skill definitions and card references. */
export function skillCatalogPayload(server: ReleaseServer): Promise<SkillCatalogPayload> {
  let pending = payloads.get(server);
  if (!pending) {
    pending = buildSkillCatalog(server);
    payloads.set(server, pending);
    pending.catch(() => payloads.delete(server));
  }
  return pending;
}

async function buildSkillCatalog(server: ReleaseServer): Promise<SkillCatalogPayload> {
  const pin = await staticCatalogRelease(server);
  const names = Object.keys(families) as SkillFamily[];
  const [documents, reference, members, supports, resources, progression, items] = await Promise.all([
    Promise.all(names.map((family) => fetchStaticCatalog(families[family], server, pin))),
    fetchStaticCatalog("skill-reference", server, pin),
    fetchStaticCatalog("cards", server, pin),
    fetchStaticCatalog("support-cards", server, pin),
    fetchStaticCatalog("progression/views/skill-level-resources", server, pin),
    fetchStaticCatalog("progression", server, pin),
    fetchStaticCatalog("items", server, pin),
  ]);
  const [memberEntities, supportEntities] = await Promise.all([
    fetchStaticCatalogBatch("cards", Object.keys(asRecord(members) ?? {}), server, pin),
    fetchStaticCatalogBatch("support-cards", Object.keys(asRecord(supports) ?? {}), server, pin),
  ]);
  const itemEntries = asRecord(asRecord(items)?.items) ?? {};
  const resolve = (resource: string, id: string) => {
    const record =
      resource === "items"
        ? asRecord(itemEntries[id])
        : resource === "support-cards"
          ? supportEntities.get(id)
          : undefined;
    return record ? entityReference(resource, id, record) : undefined;
  };
  const settings = new Map(
    associationRows(asRecord(reference)?.effectSettings).map(
      (row) => [Number(row.skillEffectType ?? asRecord(row.raw)?._skillEffectType), row.name] as const,
    ),
  );
  const entries = new Map<string, SkillCatalogEntry>();
  for (const [slot, family] of names.entries()) {
    for (const [key, value] of Object.entries(asRecord(documents[slot]) ?? {})) {
      const skill = asRecord(value);
      if (!skill) continue;
      const id = String(skill.id ?? key);
      const display = skillDisplay({ resolvedSkills: { [family]: skill } }, asRecord(reference) ?? {})[0];
      entries.set(`${family}:${id}`, {
        key: `${family}:${id}`,
        id,
        family,
        name: skill.skillName,
        image: String(skill.icon ?? ""),
        effects: [
          ...new Set(
            associationRows(skill.effects).map((row) => Number(row.effectType ?? asRecord(row.raw)?._skillEffectType)),
          ),
        ]
          .filter((id) => Number.isSafeInteger(id) && id > 0)
          .map((id) => ({ id, name: settings.get(id) })),
        levels: (Array.isArray(display?.levels) ? display.levels : []) as SkillCatalogEntry["levels"],
        cards: [],
        costs: [],
      });
    }
  }
  for (const [kind, entities] of [
    ["member-cards", memberEntities],
    ["support-cards", supportEntities],
  ] as const) {
    for (const [id, value] of entities) {
      const card = asRecord(value);
      if (!card) continue;
      for (const [family, skills] of Object.entries(asRecord(card.resolvedSkills) ?? {})) {
        if (!(family in families)) continue;
        for (const skill of associationRows(Array.isArray(skills) ? skills : [skills])) {
          const entry = entries.get(`${family}:${skill.id}`);
          if (!entry || entry.cards.some((related) => related.kind === kind && related.id === id)) continue;
          const direct = family === "live" || family === "gekisou";
          const group = Number(
            family === "live"
              ? card.liveSkillLevelResourceGroup
              : family === "gekisou"
                ? card.gekisouSkillLevelResourceGroup
                : family === "leader"
                  ? card.memberCardRankGroup
                  : card.supportCardRankGroup,
          );
          const costKind = direct ? "level" : family === "leader" ? "awakening" : "rank";
          const costKey = `${family}:${group}:${direct ? "" : family === "leader" ? card.rankUpItemId : id}`;
          let cost = entry.costs.find((cost) => cost.key === costKey);
          if (!cost && Number.isSafeInteger(group) && group > 0) {
            const rows = direct
              ? associationRows(resources).filter((row) => Number(row.group) === group)
              : associationRows(
                  asRecord(progression)?.[family === "leader" ? "memberCardRanks" : "supportCardRanks"],
                ).filter((row) => Number(asRecord(row.raw)?._group) === group);
            cost = {
              key: costKey,
              kind: costKind,
              group,
              cardIds: [],
              steps: upgradeSteps(
                direct ? family : costKind,
                rows,
                direct ? "level" : "rank",
                resolve,
                direct
                  ? undefined
                  : {
                      resource: family === "leader" ? "items" : "support-cards",
                      id: String(family === "leader" ? card.rankUpItemId : id),
                    },
              ),
            };
            entry.costs.push(cost);
          }
          if (cost) cost.cardIds.push(`${kind}:${id}`);
          const images = asRecord(card.images);
          entry.cards.push({
            kind,
            id,
            name: card.prefix ?? card.cardName,
            image: String(images?.thumbnail ?? ""),
            ...(cost ? { costGroup: group, costKey } : {}),
          });
        }
      }
    }
  }
  return { server, releaseId: pin.releaseId, sourceId: pin.sourceId, entries: [...entries.values()] };
}
