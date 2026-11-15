// L3 — GEB
// Input: a public server and its pinned release catalog.
// Output: complete card growth, skill and material projections for owned-card comparison.
// Pos: [Map](L2-2.md); lightweight growth comparison data producer.
// Effects/Dependencies: build-time catalog reads; no engine or chart loading.
import {
  asRecord,
  staticCatalogRelease,
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  type RecordValue,
} from "../lib/static-catalog-source";
import { associationRows, entityReference, type ReferenceResolver } from "../lib/entity-associations";
import { projectCardGrowth } from "../lib/card-growth-data";
import { projectGrowthCard } from "./growth-catalog-projector";
import { resolveLocalizedText } from "../lib/localized-text";
import type { GrowthPageData } from "../lib/growth-catalog";
import type { ReleaseServer } from "../lib/release-server";

export async function growthPageData(server: ReleaseServer, locale: string): Promise<GrowthPageData> {
  const identity = await staticCatalogRelease(server);
  const paths = [
    "cards",
    "support-cards",
    "characters",
    "bands",
    "items",
    "progression",
    "skill-reference",
    "progression/views/member-card-levels",
    "progression/views/member-card-awake-resources",
    "progression/views/skill-level-resources",
    "progression/views/support-card-levels",
  ] as const;
  const values = await Promise.all(paths.map((path) => fetchStaticCatalog(path, server, identity)));
  const documents = Object.fromEntries(paths.map((path, index) => [path, values[index]]));
  const memberSummary = asRecord(documents.cards) || {};
  const supportSummary = asRecord(documents["support-cards"]) || {};
  const [members, supports] = await Promise.all([
    fetchStaticCatalogBatch("cards", Object.keys(memberSummary), server, identity),
    fetchStaticCatalogBatch("support-cards", Object.keys(supportSummary), server, identity),
  ]);
  const items = asRecord(asRecord(documents.items)?.items) || {};
  const resolve: ReferenceResolver = (resource, id) => {
    const row =
      resource === "items"
        ? asRecord(items[id])
        : resource === "cards"
          ? members.get(id)
          : resource === "support-cards"
            ? supports.get(id)
            : undefined;
    return row ? entityReference(resource, id, row) : undefined;
  };
  const source = {
    views: Object.fromEntries(
      paths
        .filter((path) => path.startsWith("progression/views/"))
        .map((path) => [path.split("/").at(-1)!, associationRows(documents[path])]),
    ),
    progression: asRecord(documents.progression) || {},
    skillReference: asRecord(documents["skill-reference"]) || {},
    resolve,
  };
  const characters = asRecord(documents.characters) || {};
  const text = (value: unknown) => resolveLocalizedText(value, locale).text;
  const experienceItems = Object.fromEntries(
    (
      [
        ["member", "MemberExp"],
        ["support", "SnapExp"],
      ] as const
    ).flatMap(([kind, type]) => {
      const matching = Object.entries(items).filter(([, value]) => asRecord(value)?.itemTypeName === type);
      if (matching.length !== 1) return [];
      const [id, value] = matching[0]!;
      const item = asRecord(value)!;
      if (Number(item.value) !== 1) return [];
      return [
        [kind, { identity: `items:${id}`, name: text(item.name), count: 1, href: `/${server}/${locale}/items/${id}/` }],
      ];
    }),
  );
  const project = (details: Map<string, RecordValue>, summary: RecordValue, support: boolean) =>
    Object.keys(summary).map((id) => {
      const detail = details.get(id);
      if (!detail) throw new Error(`Growth card missing: ${server}/${support ? "support-cards" : "cards"}/${id}`);
      const item = { ...asRecord(summary[id]), ...detail };
      const aux = projectCardGrowth(source, item, support);
      const character = asRecord(characters[String(item.characterId)]);
      const card = projectGrowthCard(
        item,
        aux,
        support,
        locale,
        server,
        Number(item.bandId ?? character?.bandId) || null,
      );
      if (card.image.startsWith(`/assets/${server}/`)) {
        const image = new URL(card.image, "https://release.invalid");
        image.searchParams.set("release", identity.releaseId);
        card.image = image.pathname + image.search;
      }
      return card;
    });
  return {
    schema: "haneoka-growth-page-v1",
    calculationRevision: 1,
    identity,
    locale,
    cards: [...project(members, memberSummary, false), ...project(supports, supportSummary, true)],
    experienceItems,
    bands: Object.entries(asRecord(documents.bands) || {}).map(([id, row]) => ({
      value: id,
      label: text(asRecord(row)?.bandName),
    })),
    characters: Object.entries(characters).map(([id, row]) => ({
      value: id,
      label: text(asRecord(row)?.characterName),
    })),
    events: [],
  };
}
