import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  exactEventScore,
  parseEventHistorySource,
  prepareEventHistory,
  type EventHistoryInput,
} from "../../src/lib/game-event-history.ts";
import type { EventRankingDto, GameRecordsRegion } from "../../src/lib/game-records.ts";

const { values } = parseArgs({
  options: {
    captures: { type: "string" },
    receipts: { type: "string" },
    jp: { type: "string" },
    intl: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.captures || !values.receipts || !values.jp || !values.intl || !values.output)
  throw new Error("Use --captures DIR --receipts JSON --jp TEAM_JSON --intl TEAM_JSON --output SQL");
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const millis = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * 1000))
    throw new Error("Invalid native timestamp");
  return value * 1000;
};
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const literal = (value: number | null): string => (value === null ? "NULL" : String(value));
const catalogs = {
  jp: row(JSON.parse(await readFile(values.jp, "utf8"))),
  intl: row(JSON.parse(await readFile(values.intl, "utf8"))),
};
const receipts = row(JSON.parse(await readFile(values.receipts, "utf8")));
const observedAtMs = Date.parse(String(receipts.at));
if (!Number.isSafeInteger(observedAtMs)) throw new Error("Missing capture timestamp");
const sql: string[] = [],
  records: unknown[] = [];
const regionNumbers: Record<GameRecordsRegion, number> = {
  jp: 1,
  tw: 2,
  en: 3,
  kr: 4,
};
for (const raw of list(receipts.responses)) {
  const receipt = row(raw);
  if (receipt.status !== 200) continue;
  const region = receipt.region as GameRecordsRegion;
  if (!Object.hasOwn(regionNumbers, region) || receipt.server !== regionNumbers[region])
    throw new Error("Region binding mismatch");
  const eventId = String(receipt.eventId),
    musicId = String(receipt.musicId);
  if (!/^[1-9][0-9]*$/u.test(eventId) || !/^[1-9][0-9]*$/u.test(musicId)) throw new Error("Invalid native identity");
  const sourceUrl = `https://bdon.yatta.moe/Ranking/Event/Challenge/${eventId}/song-${regionNumbers[region]}-${musicId}.json`;
  if (receipt.url !== sourceUrl) throw new Error("Source URL mismatch");
  const catalog = catalogs[region === "jp" ? "jp" : "intl"];
  const expectedServer = region === "jp" ? "jp" : "intl";
  const identity = row(catalog.identity),
    table = row(catalog.challengeMusicTable);
  if (identity.server !== expectedServer || row(table.identity).releaseId !== identity.releaseId)
    throw new Error("Published catalog identity mismatch");
  const matching = list(table.rows)
    .map(row)
    .filter((entry) => String(entry.eventId) === eventId && String(entry.liveMusicId) === musicId);
  if (matching.length !== 1) throw new Error(`ChallengeMusic identity is ambiguous: ${region}/${eventId}/${musicId}`);
  const challengeId = String(matching[0]!.id);
  const sourceBody = await readFile(resolve(values.captures, `e${eventId}-${region}-${musicId}.json`), "utf8");
  const source = row(parseEventHistorySource(sourceBody));
  if (String(source.songId) !== musicId) throw new Error("Song identity mismatch");
  const sourceAtMs = millis(source.updated);
  const players = Object.entries(row(source.players))
    .map(([sourcePlayerId, value], sourceIndex) => ({
      sourcePlayerId,
      sourceIndex,
      value: row(value),
      scoreExact: exactEventScore(row(value).score),
    }))
    .sort((a, b) => {
      if (a.scoreExact === null || b.scoreExact === null)
        return a.scoreExact === null ? (b.scoreExact === null ? a.sourceIndex - b.sourceIndex : 1) : -1;
      const left = BigInt(a.scoreExact),
        right = BigInt(b.scoreExact);
      return left === right ? a.sourceIndex - b.sourceIndex : left > right ? -1 : 1;
    });
  const ranking: EventRankingDto = {
    region,
    eventId,
    challengeId,
    fetchedAtMs: sourceAtMs,
    serverTimeMs: null,
    stale: false,
    rows: players.map((entry, index) => ({
      rank: index + 1,
      tied: false,
      score:
        entry.scoreExact !== null && BigInt(entry.scoreExact) <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(entry.scoreExact)
          : null,
      name: typeof entry.value.name === "string" ? entry.value.name : "",
      playerId: null,
      profileId: null,
      rankExp: null,
      favoriteMemberCardId: null,
      deckId: null,
      deckName: null,
      totalPower: null,
      profileCard: null,
      cards: [],
    })),
  };
  const common = {
    region,
    eventId,
    challengeId,
    sourceUrl,
    sourceBody,
    sourceHeaders: Object.fromEntries(
      Object.entries(row(receipt.headers)).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    ),
    sourceAtMs,
  };
  const snapshots: EventHistoryInput[] = [
    {
      ...common,
      kind: "snapshot",
      ranking,
      rows: players.map((entry, index) => ({
        rank: index + 1,
        scoreExact: entry.scoreExact,
        sourcePlayerId: entry.sourcePlayerId,
        name: ranking.rows[index]!.name,
      })),
    },
  ];
  const sourceTiers = Object.entries(row(source.tiers)).flatMap(([tier, curves]) =>
    list(curves).map((value, index) => {
      const curve = row(value),
        times = list(curve.time),
        scores = list(curve.score);
      if (times.length !== scores.length || !times.length) throw new Error("Tier series length mismatch");
      const timeMs = times.map(millis);
      if (timeMs.some((time, i) => i > 0 && time < timeMs[i - 1]!)) throw new Error("Tier series is not chronological");
      return {
        tier,
        index,
        sourceId: exactEventScore(curve.id),
        timeMs,
        scoreExact: scores.map(exactEventScore),
        ...(Array.isArray(curve.ids) ? { sourceIds: curve.ids.map(exactEventScore) } : {}),
      };
    }),
  );
  if (sourceTiers.length)
    snapshots.push({
      ...common,
      kind: "tier-history",
      ranking: null,
      sourceTiers,
      rows: sourceTiers.map((series) => ({
        tier: series.tier,
        index: series.index,
        sourceId: series.sourceId,
        firstAtMs: series.timeMs[0],
        lastAtMs: series.timeMs.at(-1),
        points: series.timeMs.length,
        firstScoreExact: series.scoreExact[0],
        lastScoreExact: series.scoreExact.at(-1),
      })),
    });
  for (const input of snapshots) {
    const prepared = await prepareEventHistory(input, observedAtMs);
    const statement = `INSERT INTO game_event_ranking_history
      (id,region,event_id,challenge_id,record_kind,source_url,source_sha256,first_source_at_ms,last_source_at_ms,
      first_observed_at_ms,last_observed_at_ms,rows_json,payload_gzip) VALUES (
      ${quote(prepared.id)},${quote(region)},${quote(eventId)},${quote(challengeId)},${quote(input.kind)},${quote(sourceUrl)},
      ${quote(prepared.sourceSha256)},${literal(sourceAtMs)},${literal(sourceAtMs)},${observedAtMs},${observedAtMs},
      ${quote(prepared.rowsJson)},X'${Buffer.from(prepared.payloadGzip).toString("hex")}')
      ON CONFLICT(id) DO UPDATE SET
        first_source_at_ms=MIN(first_source_at_ms,excluded.first_source_at_ms),
        last_source_at_ms=MAX(last_source_at_ms,excluded.last_source_at_ms),
        last_observed_at_ms=MAX(last_observed_at_ms,excluded.last_observed_at_ms);`;
    if (Buffer.byteLength(statement) > 100_000) throw new Error("D1 statement size exceeded");
    sql.push(statement);
    records.push({
      id: prepared.id,
      region,
      eventId,
      challengeId,
      musicId,
      kind: input.kind,
      sourceUrl,
      sourceSha256: prepared.sourceSha256,
      sourceAtMs,
      observedAtMs,
      sourceBytes: Buffer.byteLength(sourceBody),
      payloadGzipBytes: prepared.payloadGzip.byteLength,
      rows: input.rows.length,
      nativeTierPoints: input.sourceTiers ? sourceTiers.reduce((sum, series) => sum + series.timeMs.length, 0) : 0,
      catalogIdentity: identity,
    });
  }
}
await writeFile(values.output, sql.join("\n") + "\n");
await writeFile(values.output + ".manifest.json", JSON.stringify({ at: new Date().toISOString(), records }, null, 2));
console.log(
  JSON.stringify({
    output: values.output,
    records: records.length,
    bytes: Buffer.byteLength(sql.join("\n")),
  }),
);
