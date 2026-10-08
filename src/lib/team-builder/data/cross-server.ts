import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";
import { OFFICIAL_CATALOG_SERVERS } from "../../cross-server/catalog";
import { fetchTeamBuilderData } from "./fetch";
import { visibleContentServers } from "../../test-server-visibility";

const COLLECTIONS = ["members", "snapshots", "characters", "bands", "bandItems", "songs", "events"] as const;
const GROWTH = ["memberCardLevels", "memberCardAwake", "memberCardRanks", "supportCardLevels", "supportCardRanks"] as const;

/** Select content by original ID, while keeping every foreign auxiliary reference in its own namespace. */
export function mergeTeamBuilderData(sources: readonly TeamBuilderData[], unavailableServers: string[] = []): TeamBuilderData {
  if (!sources.length) throw new Error("Team data source missing");
  const primary = sources[0]!;
  const result = structuredClone(primary);
  const metadata: NonNullable<TeamBuilderData["crossServer"]> = {
    identities: {}, owners: {}, availability: {}, unavailableServers, challengeMusics: [],
  };
  result.crossServer = metadata;
  for (const collection of COLLECTIONS) {
    metadata.owners[collection] = {};
    metadata.availability[collection] = {};
    // Maps are rebuilt in source priority order; no fields from different variants are mixed.
    Object.assign(result, { [collection]: {} });
  }

  // Stay inside int32 because native skill readers validate their reference IDs.
  const used = new Set<number>();
  const remember = (value: unknown): void => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fffffff) used.add(value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { remember(Number(key)); remember(child); }
    }
  };
  sources.forEach(remember);
  let next = 1;
  const allocate = () => {
    while (used.has(next)) next++;
    if (next > 0x7fffffff) throw new RangeError("Team data reference namespace exhausted");
    used.add(next);
    return next++;
  };

  const challengeIds = new Set<number>();
  for (let index = 0; index < sources.length; index++) {
    const source = structuredClone(sources[index]!);
    const server = source.identity.server;
    metadata.identities[server] = source.identity;
    const pinAssets = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith(`/assets/${server}/`)) {
        const url = new URL(value, "https://release.invalid");
        url.searchParams.set("release", source.identity.releaseId);
        return url.pathname + url.search;
      }
      if (Array.isArray(value)) return value.map(pinAssets);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, pinAssets(child)]));
      return value;
    };
    const references = new Map<string, number>();
    const reference = (namespace: string, value: unknown): unknown => {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0 || index === 0) return value;
      const key = `${namespace}:${id}`;
      if (!references.has(key)) references.set(key, allocate());
      return references.get(key)!;
    };
    const rewrite = (value: unknown, fields: Record<string, string>, arrays: Record<string, string> = {}): DataRow => {
      const row = nativeRow(value);
      for (const [field, namespace] of Object.entries(fields))
        if (row[field] !== undefined) row[field] = reference(namespace, row[field]);
      for (const [field, namespace] of Object.entries(arrays))
        if (Array.isArray(row[field])) row[field] = row[field].map((id) => reference(namespace, id));
      return row;
    };
    const effects = (value: unknown, family: string) => dataRows(value).map((row) => rewrite(row, {
      id: `effect:${family}`, effectId: `effect:${family}`,
      liveSkillID: "skill:live", liveSkillId: "skill:live",
      leaderSkillID: "skill:leader", leaderSkillId: "skill:leader",
      supportSkillID: "skill:support", supportSkillId: "skill:support",
      gekisouSkillID: "skill:gekiso", gekisouSkillId: "skill:gekiso",
      gekisouSupportSkillID: "skill:gekisoSupport", gekisouSupportSkillId: "skill:gekisoSupport",
      skillConditionGroup: "condition-group", conditionGroup: "condition-group",
      skillTriggerConditionGroup: "condition-group", triggerConditionGroup: "condition-group",
      skillReleaseConditionGroup: "condition-group", releaseConditionGroup: "condition-group",
      effectExecuteLimitResetConditionGroup: "condition-group", executeLimitResetConditionGroup: "condition-group",
      skillCumulativeConditionID: "cumulative", cumulativeConditionId: "cumulative",
    }, { skillTargetIDs: "target", targetIds: "target" }));

    for (const card of Object.values(source.members)) {
      card.levelLimits = Object.fromEntries((source.progression.memberCardLevelLimits ?? [])
        .filter((row) => Number(row.rarity) === card.rarity)
        .map((row) => [String(row.awakeCount), Number(row.limitLevel)]));
      card.levelGroup = Number(reference("memberCardLevels", card.levelGroup));
      card.trainingGroup = Number(reference("memberCardAwake", card.trainingGroup));
      card.awakeningGroup = Number(reference("memberCardRanks", card.awakeningGroup));
      card.leaderSkillId = Number(reference("skill:leader", card.leaderSkillId));
      card.liveSkillId = Number(reference("skill:live", card.liveSkillId));
      card.gekisoSkillId = Number(reference("skill:gekiso", card.gekisoSkillId));
    }
    for (const card of Object.values(source.snapshots)) {
      card.levelGroup = Number(reference("supportCardLevels", card.levelGroup));
      card.awakeningGroup = Number(reference("supportCardRanks", card.awakeningGroup));
      card.supportSkillIds = card.supportSkillIds.map((id) => Number(reference("skill:support", id)));
      card.gekisoSupportSkillIds = card.gekisoSupportSkillIds.map((id) => Number(reference("skill:gekisoSupport", id)));
    }
    for (const table of GROWTH) {
      const rows = (source.progression[table] ?? []).map((row) => rewrite(row, { group: table }));
      if (index === 0) result.progression[table] = rows;
      else result.progression[table] = [...(result.progression[table] ?? []), ...rows];
    }
    for (const [family, skills] of Object.entries(source.skills)) {
      const mapped = Object.fromEntries(Object.entries(skills).map(([id, row]) => [
        String(reference(`skill:${family}`, id)),
        pinAssets({ ...row, id: reference(`skill:${family}`, row.id ?? id), effects: effects(row.effects, family) }),
      ]));
      result.skills[family] = index === 0 ? mapped as Record<string, DataRow> : { ...result.skills[family], ...mapped } as Record<string, DataRow>;
    }
    const referenceTables: Record<string, [Record<string, string>, Record<string, string>]> = {
      targets: [{ id: "target" }, {}],
      conditions: [{ id: "condition" }, { conditionTargetIDs: "target" }],
      conditionSets: [{ id: "condition-set", group: "condition-group" }, { conditionIds: "condition" }],
      cumulativeConditions: [{ id: "cumulative" }, { conditionTargetIDs: "target" }],
    };
    for (const [table, [fields, arrays]] of Object.entries(referenceTables)) {
      const rows = dataRows(source.skillReference[table]).map((row) => rewrite(row, fields, arrays));
      result.skillReference[table] = index === 0 ? rows : [...dataRows(result.skillReference[table]), ...rows];
    }
    for (const item of Object.values(source.bandItems)) item.effects = effects(item.effects, "band-item");
    for (const song of Object.values(source.songs)) song.liveScoreRankGroup = reference("score-rank", song.liveScoreRankGroup);
    const scoreRanks = dataRows(source.liveTools.scoreRanks).map((row) => rewrite(row, { group: "score-rank" }));
    result.liveTools.scoreRanks = index === 0 ? scoreRanks : [...dataRows(result.liveTools.scoreRanks), ...scoreRanks];

    for (const event of Object.values(source.events)) {
      const tables = { ...objectRow(event.tables) };
      for (const [table, rows] of Object.entries(source.eventRules))
        if (Array.isArray(rows) && !Object.hasOwn(tables, table))
          tables[table] = rows.map(nativeRow).filter((row) => !row.eventId || Number(row.eventId) === Number(event.id));
      event.tables = tables;
    }
    // URLs are pinned to the selected row's source, including icons and chart files.
    for (const collection of COLLECTIONS) {
      for (const [id, row] of Object.entries(source[collection])) {
        const availability = metadata.availability[collection]![id] ?? [];
        availability.push(server);
        metadata.availability[collection]![id] = availability;
        if (Object.hasOwn(result[collection], id)) continue;
        Object.assign(result[collection], { [id]: pinAssets(row) });
        metadata.owners[collection]![id] = server;
      }
    }
    for (const row of source.challengeMusicTable?.rows ?? []) {
      const eventId = String(row.eventId), id = Number(row.id);
      if (metadata.owners.events![eventId] !== server || challengeIds.has(id)) continue;
      challengeIds.add(id);
      metadata.challengeMusics.push(row);
    }
  }
  return result;
}

/** A missing optional source does not prevent using the current server. */
export async function fetchCrossServerTeamBuilderData(server: string, signal?: AbortSignal): Promise<TeamBuilderData> {
  if (!visibleContentServers([server]).length) server = "intl";
  const servers = visibleContentServers([server, ...OFFICIAL_CATALOG_SERVERS.filter((peer) => peer !== server)]);
  const results = await Promise.allSettled(servers.map((peer) => fetchTeamBuilderData(peer, signal)));
  signal?.throwIfAborted();
  const primary = results[0]!;
  if (primary.status === "rejected") throw primary.reason;
  const loaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  return mergeTeamBuilderData(loaded, servers.filter((_, index) => results[index]!.status === "rejected"));
}
