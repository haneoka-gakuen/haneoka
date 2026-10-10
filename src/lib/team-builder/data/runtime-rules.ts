import { nativeRow, objectRow, dataRows, type DataRow, type TeamBuilderData } from "../data";

export const RUNTIME_MASTER_TABLES = {
  parameters: "MasterParameter",
  vipRanks: "MasterVip",
  vipRankBonuses: "MasterVipRankBonus",
  memoryMemberLevels: "MasterMemoryMemberLevel",
  memorySupportLevels: "MasterMemorySupportLevel",
  memoryMusic: "MasterMemoryMusic",
  memoryMusicBonuses: "MasterMemoryMusicBonus",
  memoryMusicGroups: "MasterMemoryMusicGroup",
} as const;
export const BOOST_MASTER_TABLES = {
  liveBoostBonuses: "MasterLiveMusicBoostBonus",
  challengeBoostBonuses: "MasterChallengeMusicBoostBonus",
} as const;
export const GEKISO_TIMELINE_MASTER_TABLES = {
  gekisouRankingScoreBonuses: "MasterLiveGekisouRankingScoreBonus",
  gekisouLuckBasePoints: "MasterLiveGekisouLuckBasePoint",
  gekisouLuckBonusLots: "MasterLiveGekisouLuckBonusLot",
} as const;
export interface RuntimeRuleTable {
  sourceTable: string;
  status: "ready" | "empty" | "missing";
  rows: DataRow[];
}
export interface GekisoTimelineTableAvailability {
  identity: TeamBuilderData["identity"];
  sourceTable: string;
  status: RuntimeRuleTable["status"];
  rowCount: number | null;
}
export interface LiveChallengePointTable extends RuntimeRuleTable {
  sourceTable: "MasterLiveChallengePoint";
  identity: RuntimeRulesIdentity;
}
export interface RuntimeRules {
  schema: "haneoka-team-runtime-rules-v1";
  status: "ready" | "unavailable" | "source-unverified";
  tables: Record<keyof typeof RUNTIME_MASTER_TABLES, RuntimeRuleTable>;
}
/** Zero memory bonuses are supported only when all five native tables are observed empty. */
export function hasEmptyMemoryTables(rules: RuntimeRules | undefined): boolean {
  const keys = ["memoryMemberLevels", "memorySupportLevels", "memoryMusic", "memoryMusicBonuses", "memoryMusicGroups"] as const;
  return rules?.status === "ready" && keys.every((key) => {
    const table = rules.tables[key];
    return table?.sourceTable === RUNTIME_MASTER_TABLES[key] && table.status === "empty" && table.rows.length === 0;
  });
}
export type RuntimeRulesIdentity = TeamBuilderData["identity"] & { sourceId: string };
export type RuntimeMasterReader = (identity: RuntimeRulesIdentity, sourceTable: string) => Promise<unknown | null>;

/** The transport owner reads only these tables from the already observed pin. */
export async function readRuntimeRulesDocument(identity: RuntimeRulesIdentity, read: RuntimeMasterReader) {
  const pin = Object.freeze({ ...identity });
  const tables: Record<string, RuntimeRuleTable> = {};
  const entries = Object.entries(RUNTIME_MASTER_TABLES);
  const readTable = async (sourceTable: string): Promise<RuntimeRuleTable> => {
    const document = await read(pin, sourceTable);
    if (document === null) return { sourceTable, status: "missing", rows: [] };
    const raw = objectRow(document)._allData;
    if (!Array.isArray(raw) || raw.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
      throw new Error(`Runtime Master table malformed:${sourceTable}`);
    const rows = raw.map((row) => nativeRow({ raw: row }));
    return { sourceTable, status: rows.length ? "ready" : "empty", rows };
  };
  for (let start = 0; start < entries.length; start += 4) {
    const batch = await Promise.all(
      entries.slice(start, start + 4).map(async ([key, sourceTable]): Promise<readonly [string, RuntimeRuleTable]> => {
        return [key, await readTable(sourceTable)];
      }),
    );
    for (const [key, table] of batch) tables[key] = table;
  }
  const challengePointTable = { ...await readTable("MasterLiveChallengePoint"), identity: { ...pin } };
  const challengeMusicTable = { ...await readTable("MasterChallengeMusic"), identity: { ...pin } };
  const boosts = await Promise.all(Object.entries(BOOST_MASTER_TABLES).map(async ([key, table]) =>
    [key, { ...await readTable(table), identity: { ...pin } }] as const));
  const gekiso = await Promise.all(Object.entries(GEKISO_TIMELINE_MASTER_TABLES).map(async ([key, table]) =>
    [key, { ...await readTable(table), identity: { ...pin } }] as const));
  // Optional compatibility with dispatchers deployed before this selected table was allowed.
  let characterRows: RuntimeRuleTable;
  try { characterRows = await readTable("MasterCharacter"); }
  catch { characterRows = { sourceTable: "MasterCharacter", status: "missing", rows: [] }; }
  return {
    schema: "haneoka-team-runtime-rules-v1", ...pin, tables, challengePointTable, challengeMusicTable,
    boostTables: Object.fromEntries(boosts),
    gekisoTables: Object.fromEntries(gekiso),
    masterCharacterRoster: { ...pin, sourceTable: "MasterCharacter",
      status: characterRows.status === "missing" ? "missing" : "complete", rows: characterRows.rows },
  };
}

/** Known collection rows are reusable; an unobserved empty legacy array is not an empty table. */
export function adaptGekisoTimelineTables(identity: TeamBuilderData["identity"], value: unknown, liveTools: DataRow, legacyRules: DataRow) {
  const input = objectRow(value), rows: Record<string, DataRow[]> = {}, availability: Record<string, GekisoTimelineTableAvailability> = {};
  const legacy = { gekisouRankingScoreBonuses: "rankingScoreBonuses", gekisouLuckBasePoints: "luckBasePoints", gekisouLuckBonusLots: "luckBonusLots" };
  for (const [key, sourceTable] of Object.entries(GEKISO_TIMELINE_MASTER_TABLES)) {
    const table = objectRow(input[key]);
    let status: RuntimeRuleTable["status"] = "missing", observed: DataRow[] | undefined;
    if (Object.keys(table).length) {
      const pin = objectRow(table.identity);
      if (!identity.sourceId || pin.server !== identity.server || pin.releaseId !== identity.releaseId || pin.sourceId !== identity.sourceId)
        throw new Error("Gekiso timeline table identity mismatch");
      if (table.sourceTable !== sourceTable || !["ready", "empty", "missing"].includes(String(table.status)) ||
          !Array.isArray(table.rows) || table.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)) ||
          (table.status === "ready" ? !table.rows.length : table.rows.length !== 0))
        throw new Error("Gekiso timeline table status or rows malformed");
      status = table.status as RuntimeRuleTable["status"];
      if (status !== "missing") observed = table.rows.map(nativeRow);
    }
    if (!observed && identity.sourceId && !Object.keys(table).length) {
      const projected = liveTools[key], old = legacyRules[legacy[key as keyof typeof legacy]];
      const meta = objectRow(objectRow(liveTools.tableAvailability)[key]);
      const validRows = (value: unknown): value is DataRow[] => Array.isArray(value) && value.every((row) =>
        !!row && typeof row === "object" && !Array.isArray(row) && (objectRow(row).sourceTable === undefined || objectRow(row).sourceTable === sourceTable));
      if (validRows(projected) && projected.length) { observed = projected.map(nativeRow); status = "ready"; }
      else if (Array.isArray(projected) && meta.sourceTable === sourceTable && meta.status === "empty" && meta.rowCount === 0) {
        observed = []; status = "empty";
      } else if (validRows(old) && old.length) { observed = old.map(nativeRow); status = "ready"; }
    }
    if (observed) rows[key] = observed;
    availability[key] = { identity: { ...identity }, sourceTable, status, rowCount: observed ? observed.length : null };
  }
  return { rows, availability };
}
export function adaptRuntimeRules(identity: TeamBuilderData["identity"], value: unknown): RuntimeRules {
  const document = objectRow(value);
  if (
    Object.keys(document).length &&
    (document.schema !== "haneoka-team-runtime-rules-v1" ||
      document.server !== identity.server ||
      (document.releaseId !== undefined && document.releaseId !== identity.releaseId) ||
      (identity.sourceId && document.sourceId !== identity.sourceId))
  )
    throw new Error("Runtime rules identity mismatch");
  const input = objectRow(document.tables),
    tables = {} as RuntimeRules["tables"];
  for (const [key, sourceTable] of Object.entries(RUNTIME_MASTER_TABLES)) {
    const table = objectRow(input[key]),
      rows = dataRows(table.rows).map(nativeRow);
    if (
      Object.keys(table).length &&
      (table.sourceTable !== sourceTable || !["ready", "empty", "missing"].includes(String(table.status)))
    )
      throw new Error("Runtime rules table identity mismatch");
    const status = table.status === "ready" ? "ready" : table.status === "empty" ? "empty" : "missing";
    if ((status === "ready" && !rows.length) || (status !== "ready" && rows.length))
      throw new Error("Runtime rules table status mismatch");
    tables[key as keyof typeof RUNTIME_MASTER_TABLES] = { sourceTable, status, rows };
  }
  return {
    schema: "haneoka-team-runtime-rules-v1",
    status: !Object.keys(document).length
      ? "unavailable"
      : !identity.sourceId || !document.releaseId
        ? "source-unverified"
        : Object.values(tables).some((table) => table.status === "missing") ? "unavailable" : "ready",
    tables,
  };
}

/** A global score-rank table has its own availability, independent of event groups. */
export function adaptChallengePointTable(
  identity: TeamBuilderData["identity"], value: unknown,
): LiveChallengePointTable | undefined {
  const table = objectRow(value);
  if (!identity.sourceId) {
    if (Object.keys(table).length) throw new Error("Challenge point table source identity missing");
    return undefined;
  }
  const pin = { server: identity.server, releaseId: identity.releaseId, sourceId: identity.sourceId };
  if (!Object.keys(table).length)
    return { identity: pin, sourceTable: "MasterLiveChallengePoint", status: "missing", rows: [] };
  const provided = objectRow(table.identity);
  if (provided.server !== pin.server || provided.releaseId !== pin.releaseId || provided.sourceId !== pin.sourceId)
    throw new Error("Challenge point table identity mismatch");
  if (table.sourceTable !== "MasterLiveChallengePoint" || !["ready", "empty", "missing"].includes(String(table.status)) ||
      !Array.isArray(table.rows) || table.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
    throw new Error("Challenge point table malformed");
  const status = table.status as RuntimeRuleTable["status"], rows = table.rows.map(nativeRow);
  if ((status === "ready" && !rows.length) || (status !== "ready" && rows.length))
    throw new Error("Challenge point table status mismatch");
  return { identity: pin, sourceTable: "MasterLiveChallengePoint", status, rows };
}

/** Prefer observed Master rows over an older collection's ambiguous empty array. */
export function adaptBoostTables(identity: TeamBuilderData["identity"], value: unknown) {
  const input = objectRow(value), rows: Record<string, DataRow[]> = {}, availability: Record<string, DataRow> = {};
  for (const [key, sourceTable] of Object.entries(BOOST_MASTER_TABLES)) {
    const table = objectRow(input[key]);
    if (!Object.keys(table).length) continue;
    const pin = objectRow(table.identity);
    if (!identity.sourceId || pin.server !== identity.server || pin.releaseId !== identity.releaseId || pin.sourceId !== identity.sourceId)
      throw new Error("Boost table identity mismatch");
    if (table.sourceTable !== sourceTable || !["ready", "empty", "missing"].includes(String(table.status)) ||
        !Array.isArray(table.rows) || table.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
      throw new Error("Boost table malformed");
    if ((table.status === "ready" && !table.rows.length) || (table.status !== "ready" && table.rows.length))
      throw new Error("Boost table status mismatch");
    // A missing raw mirror does not erase rows already observed in the same-pin collection.
    if (table.status === "missing") continue;
    rows[key] = table.rows.map(nativeRow);
    availability[key] = { sourceTable, status: table.status, rowCount: table.rows.length };
  }
  return { rows, availability };
}
