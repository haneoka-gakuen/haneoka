// L3 — GEB
// Input: SDK 快照、账户指纹与云行文档。
// Output: 严格白名单投影、collection 合并和 422/409 错误。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 纯格式与合并；不读取凭据，不发 HTTP。
import {
  HISTORY_REGIONS,
  parseHistory,
  type HistoryRegion,
  type HistorySnapshot,
} from "@haneoka/game-data-exporter/gacha-history";
import { mergeHistoryCollection } from "./gacha-history-merge.ts";

export const HISTORY_CLOUD_SCHEMA = "haneoka-gacha-cloud-v1";
export const HISTORY_CLOUD_BYTES = 1024 * 1024;
export const historyCloudAccountKeyValid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export interface HistoryCloudSummary {
  accountKey: string;
  canonicalAccountKey?: string;
  aliases?: string[];
  server: HistoryRegion;
  revision: number;
  updatedAt: number;
  refreshRequested: number;
  refreshCompleted: number;
}

export interface HistoryCombineSource {
  accountKey: string;
  revision: number | null;
}

export interface HistoryCloudDocument extends HistoryCloudSummary {
  ownerId: string;
  histories: HistorySnapshot[];
}

export interface StoredCloudHistory {
  schema: typeof HISTORY_CLOUD_SCHEMA;
  histories: HistorySnapshot[];
}

export class HistoryCloudDataError extends Error {
  readonly status: 422 | 409;
  constructor(code: string, status: 422 | 409) {
    super(code);
    this.name = "HistoryCloudDataError";
    this.status = status;
  }
}

export function parseCloudHistory(value: unknown, accountKey?: string, server?: HistoryRegion): HistorySnapshot {
  let history: HistorySnapshot;
  try {
    history = parseHistory(value);
  } catch {
    throw new HistoryCloudDataError("invalid_history", 422);
  }
  if (!history.source.accountKey) throw new HistoryCloudDataError("invalid_history", 422);
  if (accountKey !== undefined && history.source.accountKey !== accountKey)
    throw new HistoryCloudDataError("history_account_mismatch", 409);
  if (server !== undefined && history.source.server !== server)
    throw new HistoryCloudDataError("history_server_mismatch", 409);
  return history;
}

export function parseStoredCloudHistory(value: unknown, accountKey: string, server: HistoryRegion): StoredCloudHistory {
  if (
    !historyCloudAccountKeyValid(accountKey) ||
    !HISTORY_REGIONS.includes(server) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("schema" in value) ||
    value.schema !== HISTORY_CLOUD_SCHEMA ||
    !("histories" in value) ||
    !Array.isArray(value.histories)
  )
    throw new HistoryCloudDataError("invalid_history", 422);
  return {
    schema: HISTORY_CLOUD_SCHEMA,
    histories: value.histories.map((history) => parseCloudHistory(history, accountKey, server)),
  };
}

/** Merges snapshots already projected at the cloud request and storage boundaries. */
export function mergeCloudHistory(stored: StoredCloudHistory, incoming: HistorySnapshot): StoredCloudHistory {
  const sameCapture = stored.histories.find((history) =>
    history.historyKind === incoming.historyKind &&
    history.queriedAt === incoming.queriedAt &&
    history.batches.length === incoming.batches.length,
  );
  if (sameCapture && JSON.stringify(sameCapture) === JSON.stringify(incoming)) return stored;
  try {
    return { schema: HISTORY_CLOUD_SCHEMA, histories: mergeHistoryCollection(stored.histories, incoming) };
  } catch {
    throw new HistoryCloudDataError("invalid_history", 422);
  }
}

/** The same key produced by the browser's companion-history import. */
export async function historyCloudAccountKey(server: HistoryRegion, localAccountKey: string): Promise<string> {
  if (!/^[a-f0-9]{64}(?:-(?:jp|global-hmt|global-en|global-kr))?$/u.test(localAccountKey))
    throw new Error("history_account_key_invalid");
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${server}:${localAccountKey}`))),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export const cloudHistoryUpload = (value: unknown, completedRequest = 0) => ({
  history: parseCloudHistory(value),
  completedRequest,
});
