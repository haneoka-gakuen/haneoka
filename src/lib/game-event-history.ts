import type { EventRankingDto, GameRecordsRegion } from "./game-records";
export type HistoryKind = "snapshot" | "tier-history";
export type StoredEventPayload = {
  ranking: EventRankingDto | null;
  sourceBody: string;
  sourceHeaders: Record<string, string>;
  sourceTiers?: unknown[];
};
export type EventHistoryInput = {
  region: GameRecordsRegion;
  eventId: string;
  challengeId?: string;
  kind: HistoryKind;
  sourceUrl: string;
  sourceBody: string;
  sourceHeaders: Record<string, string>;
  ranking: EventRankingDto | null;
  sourceAtMs: number | null;
  rows: unknown[];
  sourceTiers?: unknown[];
};
const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const compress = async (text: string): Promise<ArrayBuffer> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
export const decodeEventHistory = async (bytes: number[]): Promise<StoredEventPayload> =>
  JSON.parse(
    await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))).text(),
  ) as StoredEventPayload;

/** Native integer tokens stay decimal strings in archived score lines. */
export function parseEventHistorySource(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number" || !Number.isInteger(value) || Number.isSafeInteger(value)) return value;
    if (context?.source && /^[0-9]+$/u.test(context.source)) return context.source;
    throw new Error("event-history-integer-source");
  }) as unknown;
}
export const exactEventScore = (value: unknown): string | null =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;

export function eventSnapshotRows(ranking: EventRankingDto, sourceBody: string): unknown[] {
  const source = parseEventHistorySource(sourceBody) as Record<string, unknown>;
  const players = Array.isArray(source.players) ? source.players : Array.isArray(source.rows) ? source.rows : [];
  return ranking.rows.map((row) => {
    const native = (
      Array.isArray(source.players)
        ? players[row.rank - 1]
        : players.find((entry) => Number((entry as Record<string, unknown>).rank) === row.rank)
    ) as Record<string, unknown> | undefined;
    return {
      rank: row.rank,
      tied: row.tied,
      scoreExact: exactEventScore(native?.score ?? native?.point ?? row.score),
      playerId: row.playerId,
      profileId: row.profileId,
      name: row.name,
    };
  });
}

export async function eventHistoryIdentity(input: EventHistoryInput) {
  const rowsJson = JSON.stringify(input.rows);
  const id = await sha256(
    JSON.stringify([
      input.region,
      input.eventId,
      input.challengeId ?? "",
      input.kind,
      input.sourceUrl,
      input.ranking?.rows,
      input.sourceTiers,
      rowsJson,
    ]),
  );
  return { id, rowsJson };
}

export async function prepareEventHistory(input: EventHistoryInput, observedAtMs = Date.now()) {
  const { id, rowsJson } = await eventHistoryIdentity(input);
  const payload: StoredEventPayload = {
    ranking: input.ranking,
    sourceBody: input.sourceBody,
    sourceHeaders: input.sourceHeaders,
    ...(input.sourceTiers ? { sourceTiers: input.sourceTiers } : {}),
  };
  return {
    id,
    input,
    observedAtMs,
    rowsJson,
    sourceSha256: await sha256(input.sourceBody),
    payloadGzip: await compress(JSON.stringify(payload)),
  };
}
