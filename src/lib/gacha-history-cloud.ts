// L3 — GEB
// Input: 当前 Haneoka owner 与白名单快照。
// Output: 认证云传输、刷新请求及有界错误。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 发 same-origin HTTP；期望 owner、响应身份和 1 MiB 上限均受检查。
import {
  cloudHistoryUpload,
  historyCloudAccountKeyValid,
  HISTORY_CLOUD_BYTES,
  HISTORY_CLOUD_SCHEMA,
  parseStoredCloudHistory,
  type HistoryCloudDocument,
  type HistoryCloudSummary,
  type HistoryCombineSource,
} from "./gacha-history-cloud-data";
import { HISTORY_REGIONS, historyObject, parseHistory } from "@haneoka/game-data-exporter/gacha-history";
import { JsonResponseError } from "../lit/shared/catalog";

export * from "./gacha-history-cloud-data";

export class HistoryCloudError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(code);
  }
}

export function historyCloudErrorCode(error: unknown): string {
  const code =
    error instanceof HistoryCloudError
      ? error.code
      : error instanceof JsonResponseError
        ? String(historyObject(historyObject(error.body).error).code ?? "")
        : error instanceof Error
          ? error.message
          : "";
  if (code === "account_changed") return code;
  if (error instanceof JsonResponseError && error.status === 401) return "authentication_required";
  if (["authentication_required", "unauthenticated", "expected_user_required"].includes(code))
    return "authentication_required";
  if (
    [
      "email_verification_required",
      "history_too_large",
      "history_account_limit",
      "history_account_mismatch",
      "history_server_mismatch",
      "history_session_expired",
    ].includes(code)
  )
    return code;
  if (code.startsWith("account_")) return "account_restricted";
  if (["invalid_history", "history_account_key_invalid"].includes(code)) return "history_account_mismatch";
  return error instanceof TypeError ? "history_network_error" : "history_cloud_unavailable";
}

function summary(value: HistoryCloudSummary): HistoryCloudSummary {
  if (
    !value ||
    !historyCloudAccountKeyValid(value.accountKey) ||
    !HISTORY_REGIONS.includes(value.server) ||
    (value.canonicalAccountKey !== undefined && !historyCloudAccountKeyValid(value.canonicalAccountKey)) ||
    (value.aliases !== undefined &&
      (!Array.isArray(value.aliases) || value.aliases.some((key) => !historyCloudAccountKeyValid(key)))) ||
    ![value.revision, value.updatedAt, value.refreshRequested, value.refreshCompleted].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    value.refreshCompleted > value.refreshRequested
  )
    throw new HistoryCloudError("invalid_history", 422);
  return {
    accountKey: value.accountKey,
    ...(value.canonicalAccountKey ? { canonicalAccountKey: value.canonicalAccountKey } : {}),
    aliases: value.aliases ?? [],
    server: value.server,
    revision: value.revision,
    updatedAt: value.updatedAt,
    refreshRequested: value.refreshRequested,
    refreshCompleted: value.refreshCompleted,
  };
}

function document(value: HistoryCloudDocument, key: string): HistoryCloudDocument {
  const parsed = summary(value);
  if (parsed.accountKey !== key) throw new HistoryCloudError("history_account_mismatch", 409);
  const stored = parseStoredCloudHistory(
    { schema: HISTORY_CLOUD_SCHEMA, histories: value.histories },
    key,
    parsed.server,
  );
  return { ...parsed, ownerId: value.ownerId, histories: stored.histories };
}

/** Account-owned transport; the host keeps its existing local store and retry lifecycle. */
export class HistoryCloudClient {
  constructor(private readonly options: { ownerId: () => string | null; fetcher?: typeof fetch }) {}

  private guard(owner: string | null) {
    if (!owner || owner !== this.options.ownerId()) throw new HistoryCloudError("account_changed", 409);
  }
  private async owned<T>(owner: string, action: () => Promise<T>): Promise<T> {
    this.guard(owner);
    try {
      const value = await action();
      this.guard(owner);
      return value;
    } catch (error) {
      this.guard(owner);
      throw error;
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    accountKey: string | null,
    suffix = "",
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const owner = this.options.ownerId();
    if (!owner) throw new HistoryCloudError("authentication_required", 401);
    if (accountKey !== null && !historyCloudAccountKeyValid(accountKey))
      throw new HistoryCloudError("history_account_key_invalid");
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > HISTORY_CLOUD_BYTES)
      throw new HistoryCloudError("history_too_large", 413);
    const response = await this.owned(owner, () =>
      (this.options.fetcher ?? globalThis.fetch)(
        `/api/v1/gacha-history${accountKey === null ? "" : `/${accountKey}`}${suffix}`,
        {
          method,
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...headers,
            accept: "application/json",
            "x-haneoka-expected-user": owner,
            ...(serialized === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(serialized === undefined ? {} : { body: serialized }),
        },
      ),
    );
    this.guard(owner);
    const result = (await this.owned(owner, () => response.json())) as { ownerId?: string; error?: { code?: string } };
    if (owner !== this.options.ownerId()) throw new HistoryCloudError("account_changed", 409);
    if (!response.ok) throw new HistoryCloudError(result.error?.code ?? `http_${response.status}`, response.status);
    if (result.ownerId !== owner) throw new HistoryCloudError("account_changed", 409);
    return result as T;
  }

  async list(): Promise<HistoryCloudSummary[]> {
    const result = await this.request<{ accounts: HistoryCloudSummary[] }>("GET", null);
    if (!Array.isArray(result.accounts)) throw new HistoryCloudError("invalid_history", 422);
    return result.accounts.map(summary);
  }

  async read(accountKey: string): Promise<HistoryCloudDocument> {
    return document(await this.request("GET", accountKey), accountKey);
  }

  async upload(accountKey: string, history: unknown, completedRequest = 0): Promise<HistoryCloudDocument> {
    const parsed = parseHistory(history);
    if (parsed.source.accountKey && parsed.source.accountKey !== accountKey)
      throw new HistoryCloudError("history_account_mismatch", 409);
    const payload = { ...parsed, source: { ...parsed.source, accountKey } };
    return document(
      await this.request("POST", accountKey, "", cloudHistoryUpload(payload, completedRequest)),
      accountKey,
    );
  }

  async combine(
    accountKey: string,
    histories: unknown[],
    sources: HistoryCombineSource[],
  ): Promise<HistoryCloudDocument> {
    return document(await this.request("POST", accountKey, "/combine", { histories, sources }), accountKey);
  }

  async originals(accountKey: string): Promise<HistoryCloudDocument[]> {
    const result = await this.request<{ sources: Array<{ accountKey: string }> }>("GET", accountKey, "/sources");
    const documents: HistoryCloudDocument[] = [];
    for (const source of result.sources) {
      if (!historyCloudAccountKeyValid(source.accountKey)) throw new HistoryCloudError("invalid_history", 422);
      documents.push(
        document(await this.request("GET", accountKey, `/sources/${source.accountKey}`), source.accountKey),
      );
    }
    return documents;
  }

  async requestRefresh(accountKey: string, cached?: HistoryCloudDocument): Promise<HistoryCloudDocument> {
    const response = await this.request<HistoryCloudSummary & Pick<HistoryCloudDocument, "ownerId"> & Partial<Pick<HistoryCloudDocument, "histories">>>(
      "POST", accountKey, "/refresh", {}, cached ? { "X-Haneoka-History-Projection": "summary" } : undefined,
    );
    if (response.histories) return document({ ...response, histories: response.histories }, accountKey);
    const row = summary(response);
    if (row.accountKey !== accountKey) throw new HistoryCloudError("history_account_mismatch", 409);
    if (
      cached?.ownerId === response.ownerId &&
      cached.accountKey === row.accountKey &&
      row.canonicalAccountKey === undefined &&
      cached.server === row.server &&
      row.revision === cached.revision + 1
    ) return { ...row, ownerId: response.ownerId, histories: cached.histories };
    return this.read(accountKey);
  }

  async fulfillRefresh(accountKey: string, readOfficial: () => Promise<unknown>): Promise<HistoryCloudDocument> {
    const owner = this.options.ownerId();
    const current = await this.read(accountKey);
    if (owner !== this.options.ownerId()) throw new HistoryCloudError("account_changed", 409);
    if (!owner) throw new HistoryCloudError("authentication_required", 401);
    const history = await this.owned(owner, readOfficial);
    if (owner !== this.options.ownerId()) throw new HistoryCloudError("account_changed", 409);
    return this.upload(accountKey, history, current.refreshRequested);
  }
}
