import { associationRows, entityReference, upgradeSteps, type EntityReference } from "../lib/entity-associations";
import {
  asRecord,
  fetchOptionalStaticCatalog,
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  type RecordValue,
} from "../lib/static-catalog-source";
import type { ReleaseServer } from "../lib/resource-route";

export interface ItemOccurrence {
  count: number | null;
  path: string;
  conditions: RecordValue;
}
export interface ItemRelation {
  entity: EntityReference;
  purpose: string;
  occurrences: ItemOccurrence[];
}
export interface ItemRelations {
  acquisitions: ItemRelation[];
  uses: ItemRelation[];
  rules: Array<{ source: string; occurrences: ItemOccurrence[] }>;
  coverage: Array<{ resource: string; available: boolean }>;
}
const REWARD_PATHS = {
  missions: ["rewards"],
  shop: ["rewards"],
  exchange: ["products"],
  events: ["rewards"],
  "login-campaigns": ["rewards"],
  passes: ["rewards", "levels"],
  circle: ["rewards"],
} as const;
const REWARD_SOURCES = Object.keys(REWARD_PATHS) as Array<keyof typeof REWARD_PATHS>;
const promises = new Map<string, Promise<{ index: Map<number, ItemRelations>; coverage: ItemRelations["coverage"] }>>();
const quantity = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const itemIdentity = (row: RecordValue): number | undefined => {
  if (Number(row.resourceType) === 1 && Number.isSafeInteger(Number(row.resourceId)) && Number(row.resourceId) > 0)
    return Number(row.resourceId);
  if (row.kind !== "Item" || typeof row.href !== "string") return undefined;
  const url = new URL(row.href, "https://catalog.invalid");
  if (url.pathname !== "/catalog/items") return undefined;
  const id = Number(url.searchParams.get("item"));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

/** Each occurrence retains its own conditions; alternative rewards are never summed. */
async function build(server: ReleaseServer) {
  const pin = await staticCatalogRelease(server);
  const read = (path: string) => fetchStaticCatalog(path, server, pin);
  const [members, bands, progression, songs, sourceDocuments] = await Promise.all([
    read("cards"),
    read("band-items"),
    read("progression"),
    read("songs?projection=4"),
    Promise.all(
      REWARD_SOURCES.map(async (resource) => ({
        resource,
        result: await fetchOptionalStaticCatalog(resource, server, pin),
      })),
    ),
  ]);
  const [memberEntities, songEntities] = await Promise.all([
    fetchStaticCatalogBatch("cards", Object.keys(asRecord(members) ?? {}), server, pin),
    fetchStaticCatalogBatch("songs", Object.keys(asRecord(songs) ?? {}), server, pin),
  ]);
  const output = new Map<number, ItemRelations>();
  const coverage: ItemRelations["coverage"] = sourceDocuments.map(({ resource, result }) => ({
    resource,
    available: result.value !== null,
  }));
  coverage.push(...["cards", "songs", "band-items", "progression"].map((resource) => ({ resource, available: true })));
  const add = (
    itemId: number,
    direction: "acquisitions" | "uses",
    entity: EntityReference,
    purpose: string,
    occurrence: ItemOccurrence,
  ) => {
    const data = output.get(itemId) ?? { acquisitions: [], uses: [], rules: [], coverage };
    const rows = data[direction];
    let relation = rows.find(
      (row) => row.entity.resource === entity.resource && row.entity.id === entity.id && row.purpose === purpose,
    );
    if (!relation) {
      relation = { entity, purpose, occurrences: [] };
      rows.push(relation);
    }
    if (!relation.occurrences.some((row) => row.path === occurrence.path)) relation.occurrences.push(occurrence);
    output.set(itemId, data);
  };
  const scan = (value: unknown, entity: EntityReference, path: string, inherited: RecordValue) => {
    if (Array.isArray(value)) {
      value.forEach((row, index) => scan(row, entity, `${path}/${index}`, inherited));
      return;
    }
    const row = asRecord(value);
    if (!row) return;
    const conditions = { ...inherited };
    for (const key of [
      "day",
      "level",
      "premium",
      "rank",
      "minRank",
      "maxRank",
      "point",
      "points",
      "difficulty",
      "limit",
      "cost",
      "startAt",
      "endAt",
      "condition",
    ])
      if (row[key] !== undefined) conditions[key] = row[key];
    const raw = asRecord(row.raw);
    for (const [field, key] of [
      ["_rank", "rank"],
      ["_rankFrom", "minRank"],
      ["_rankTo", "maxRank"],
      ["_eventPoint", "points"],
      ["_scoreRank", "scoreRank"],
    ])
      if (raw?.[field] !== undefined) conditions[key] = raw[field];
    if (row.liveScoreRank !== undefined) conditions.scoreRank = row.liveScoreRank;
    if (row.comboRateType !== undefined) conditions.comboRateType = row.comboRateType;
    const itemId = itemIdentity(row);
    if (itemId !== undefined) {
      add(itemId, "acquisitions", entity, "reward", {
        count: quantity(row.resourceCount ?? row.count),
        path,
        conditions,
      });
      return;
    }
    for (const [key, child] of Object.entries(row)) {
      if (["raw", "currency", "payment", "images", "imageVariants"].includes(key)) continue;
      if (Array.isArray(child) || asRecord(child)) scan(child, entity, `${path}/${key}`, conditions);
    }
  };
  for (const { resource, result } of sourceDocuments) {
    const entries = asRecord(asRecord(result.value)?.entries) ?? {};
    for (const [id, value] of Object.entries(entries)) {
      const row = asRecord(value);
      if (row)
        for (const path of REWARD_PATHS[resource]) {
          const inherited = Object.fromEntries(
            ["startAt", "endAt", "rank", "goal"].flatMap((key) => (row[key] !== undefined ? [[key, row[key]]] : [])),
          );
          const currency = asRecord(row.currency);
          if (currency?.name !== undefined) inherited.currency = currency.name;
          scan(row[path], entityReference(resource, id, row), `${resource}/${path}`, inherited);
        }
      if (row && resource === "exchange") {
        const currency = asRecord(row.currency);
        const itemId = currency && itemIdentity(currency);
        if (itemId !== undefined)
          for (const [slot, product] of associationRows(row.products).entries()) {
            add(itemId, "uses", entityReference(resource, id, row), "exchange", {
              count: quantity(product.cost),
              path: `products/${slot}`,
              conditions: {
                limit: product.limit,
                reward: asRecord(product.reward)?.name,
                startAt: product.startAt,
                endAt: product.endAt,
              },
            });
          }
      }
    }
  }
  for (const [id, song] of songEntities) {
    const entity = entityReference("songs", id, song);
    scan(song.scoreRewards, entity, "scoreRewards", {});
    for (const [difficulty, rewards] of Object.entries(asRecord(song.comboRewards) ?? {}))
      scan(rewards, entity, `comboRewards/${difficulty}`, { difficulty });
  }
  const master = asRecord(progression) ?? {};
  const itemDocument = asRecord(await read("items")) ?? {};
  const ruleNames = [
    "MasterLiveFreeReward",
    "MasterBattleLiveReward",
    "MasterGekisouLiveRankReward",
    "MasterLiveStamp",
    "MasterInvitationReward",
  ];
  for (const source of ruleNames)
    for (const row of associationRows(asRecord(itemDocument.rewards)?.[source])) {
      const id = itemIdentity(row);
      if (id === undefined) continue;
      const data = output.get(id) ?? { acquisitions: [], uses: [], rules: [], coverage };
      let rule = data.rules.find((rule) => rule.source === source);
      if (!rule) {
        rule = { source, occurrences: [] };
        data.rules.push(rule);
      }
      const raw = asRecord(row.raw) ?? {};
      const conditions: RecordValue = {};
      for (const [key, name] of [
        ["_liveScoreRank", "scoreRank"],
        ["_probability", "probabilityBp"],
        ["_dayNo", "day"],
        ["_group", "group"],
      ])
        if (raw[key] !== undefined) conditions[name] = raw[key];
      rule.occurrences.push({ count: quantity(row.resourceCount), path: String(row.rewardId), conditions });
      output.set(id, data);
    }
  const skillResources = associationRows(master.skillLevelResources);
  const trainingResources = associationRows(master.memberCardAwakeResources);
  const recordCosts = (
    entity: EntityReference,
    purpose: string,
    rows: RecordValue[],
    level: string,
    resourceId?: number,
  ) => {
    const steps = upgradeSteps(
      purpose,
      rows,
      level,
      () => undefined,
      resourceId ? { resource: "items", id: String(resourceId) } : undefined,
    );
    for (const step of steps)
      for (const [slot, cost] of step.costs.entries()) {
        const itemId = resourceId ?? cost.itemId;
        if (typeof itemId === "number" && Number.isSafeInteger(itemId) && itemId > 0)
          add(itemId, "uses", entity, purpose, {
            count: quantity(cost.count),
            path: `${purpose}/${step.to}/${slot}`,
            conditions: { from: step.from, to: step.to },
          });
      }
  };
  for (const [id, card] of memberEntities) {
    const entity = entityReference("cards", id, card);
    recordCosts(
      entity,
      "training",
      trainingResources.filter((row) => Number(row.group) === Number(card.memberCardAwakeResourceGroup)),
      "awakeCount",
    );
    recordCosts(
      entity,
      "awakening",
      associationRows(master.memberCardRanks).filter(
        (row) => Number(asRecord(row.raw)?._group) === Number(card.memberCardRankGroup),
      ),
      "rank",
      Number(card.rankUpItemId),
    );
    recordCosts(
      entity,
      "live",
      skillResources.filter((row) => Number(row.group) === Number(card.liveSkillLevelResourceGroup)),
      "level",
    );
    recordCosts(
      entity,
      "gekisou",
      skillResources.filter((row) => Number(row.group) === Number(card.gekisouSkillLevelResourceGroup)),
      "level",
    );
  }
  for (const [id, band] of Object.entries(asRecord(asRecord(bands)?.items) ?? {})) {
    const row = asRecord(band);
    if (row) {
      const levels = new Set(associationRows(row.levels).map((level) => Number(level.level)));
      recordCosts(
        entityReference("band-items", id, row),
        "level",
        skillResources.filter(
          (cost) =>
            Number(cost.group) === Number(row.resourceGroupId) && (!levels.size || levels.has(Number(cost.level))),
        ),
        "level",
      );
    }
  }
  // Support ranks consume another card, not an item. Their EXP path needs a separate authored mapping.
  return { index: output, coverage };
}

export async function itemRelations(server: ReleaseServer, id: number, releaseId: string): Promise<ItemRelations> {
  const pin = await staticCatalogRelease(server);
  if (pin.releaseId !== releaseId) throw new Error("Item relationship release differs from entity payload");
  const key = `${server}:${pin.releaseId}:${pin.sourceId}`;
  let pending = promises.get(key);
  if (!pending) {
    pending = build(server);
    promises.set(key, pending);
    pending.catch(() => promises.delete(key));
  }
  const result = await pending;
  return result.index.get(id) ?? { acquisitions: [], uses: [], rules: [], coverage: result.coverage };
}
