// L3 — GEB
// Input: Release-pinned skill definitions and their related member and Snapshot cards.
// Output: Skill catalogue with level effects, card attributes, rarity, characters and pinned artwork.
// Pos: [Map](L2-2.md); shared skill page data.
// Effects/Dependencies: Reads immutable catalogue resources; card upgrade costs stay with card details.
import {
  skillDisplay,
  associationRows,
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
    attribute: number;
    rarity: number;
    characterIds: number[];
  }>;
}
export interface SkillCatalogPayload {
  server: ReleaseServer;
  releaseId: string;
  sourceId: string;
  marks: Record<string, string>;
  characters: Record<string, {
    characterId: number;
    characterName: unknown;
    englishName: unknown;
    faceImage: string;
  }>;
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
  const asset = (source: string): string => {
    if (!/^\/(?:assets|runtime|objects)\//u.test(source)) return source;
    const url = new URL(source, "https://asset.invalid");
    url.searchParams.set("release", pin.releaseId);
    return url.pathname + url.search;
  };
  const names = Object.keys(families) as SkillFamily[];
  const [documents, reference, members, supports, characters, marks] = await Promise.all([
    Promise.all(names.map((family) => fetchStaticCatalog(families[family], server, pin))),
    fetchStaticCatalog("skill-reference", server, pin),
    fetchStaticCatalog("cards", server, pin),
    fetchStaticCatalog("support-cards", server, pin),
    fetchStaticCatalog("characters", server, pin),
    fetchStaticCatalog("ui-marks", server, pin),
  ]);
  const [memberEntities, supportEntities] = await Promise.all([
    fetchStaticCatalogBatch("cards", Object.keys(asRecord(members) ?? {}), server, pin),
    fetchStaticCatalogBatch("support-cards", Object.keys(asRecord(supports) ?? {}), server, pin),
  ]);
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
        image: asset(String(skill.icon ?? "")),
        effects: [
          ...new Set(
            associationRows(skill.effects).map((row) => Number(row.effectType ?? asRecord(row.raw)?._skillEffectType)),
          ),
        ]
          .filter((id) => Number.isSafeInteger(id) && id > 0)
          .map((id) => ({ id, name: settings.get(id) })),
        levels: (Array.isArray(display?.levels) ? display.levels : []) as SkillCatalogEntry["levels"],
        cards: [],
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
          const images = asRecord(card.images);
          entry.cards.push({
            kind,
            id,
            name: card.prefix ?? card.cardName,
            image: asset(String(images?.thumbnail ?? "")),
            attribute: Number(card.cardType),
            rarity: Number(card.rarity),
            characterIds: kind === "member-cards" ? [Number(card.characterId)] : (card.characterIds as number[]),
          });
        }
      }
    }
  }
  return {
    server,
    releaseId: pin.releaseId,
    sourceId: pin.sourceId,
    entries: [...entries.values()],
    marks: Object.fromEntries(
      Object.entries(asRecord(marks) ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, path]) => [name, asset(`/runtime/${server}/${path.replace(/^runtime\//u, "")}`)]),
    ),
    characters: Object.fromEntries(
      Object.entries(asRecord(characters) ?? {}).map(([id, value]) => {
        const row = asRecord(value)!;
        return [id, {
          characterId: Number(row.characterId ?? id),
          characterName: row.characterName,
          englishName: row.englishName,
          faceImage: asset(String(row.faceImage || row.thumbnailImage || "")),
        }];
      }),
    ),
  };
}
