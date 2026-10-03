import { clientText, getI18nClient } from "../../i18n/client";
import { resolveLocalizedText } from "../../lib/localized-text";
import { readReleaseServer } from "../../lib/release-server";

export type JsonRecord = Record<string, unknown>;
export const UI_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

export function preferredLocale(fallback = "ja"): string {
  const committed = getI18nClient()?.committed;
  if (committed) return committed;
  let stored = "";
  try {
    stored = localStorage.getItem("haneoka.locale") || "";
  } catch {
    // The document bootstrap remains authoritative when storage is unavailable.
  }
  const value = (typeof document === "undefined" ? "" : document.documentElement.dataset.locale) || stored || fallback;
  return (UI_LOCALES as readonly string[]).includes(value) ? value : fallback;
}

/** Compatibility signature; resolution is owned by the central public catalog. */
export function uiText(locale: string, key: string): string {
  return clientText(locale, key, key);
}

export function formatList(
  values: unknown[],
  locale: string,
  type: Intl.ListFormatOptions["type"] = "conjunction",
): string {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (items.length < 2) return items[0] || "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}

export function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as JsonRecord)[key] : undefined), value);
}

export function recordValues(value: unknown): JsonRecord[] {
  return value && typeof value === "object"
    ? Object.values(value as JsonRecord).filter((item): item is JsonRecord => !!item && typeof item === "object")
    : [];
}

export function localizedText(value: unknown, locale: string): string {
  return resolveLocalizedText(value, locale).text;
}

export function currentReleaseServer(): string {
  return readReleaseServer();
}

export function catalogUrl(resource: string, id = "", server = currentReleaseServer()): string {
  const path = resource.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/v1/servers/${encodeURIComponent(server)}/${path}${id ? `/${encodeURIComponent(id)}` : ""}${!id && ["stories", "songs"].includes(resource) ? "?projection=4" : ""}`;
}

export class JsonResponseError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message = `HTTP ${status}`) {
    super(message);
    this.name = "JsonResponseError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const controller = new AbortController();
  const source = init?.signal;
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  else source?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException(uiText(preferredLocale(), "requestTimedOut"), "TimeoutError")),
      30_000,
    );
  };
  resetDeadline();
  let failedStatus: number | undefined;
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!response.ok) failedStatus = response.status;
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    if (reader)
      try {
        while (true) {
          resetDeadline();
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    else text = await response.text();
    let value: unknown;
    try {
      value = text || response.status !== 204 ? JSON.parse(text) : null;
    } catch (error) {
      if (!response.ok) throw new JsonResponseError(response.status, null);
      throw error;
    }
    if (!response.ok) {
      const data = value && typeof value === "object" ? (value as JsonRecord) : {};
      const error = data.error && typeof data.error === "object" ? (data.error as JsonRecord) : {};
      throw new JsonResponseError(
        response.status,
        value,
        String(error.message || data.message || `HTTP ${response.status}`),
      );
    }
    return value as T;
  } catch (error) {
    // Caller cancellation belongs to the obsolete request, not a new permission failure.
    if (source?.aborted) throw source.reason;
    // The received HTTP failure remains authoritative if its body or deadline fails.
    if (failedStatus !== undefined)
      throw error instanceof JsonResponseError && error.status === failedStatus
        ? error : new JsonResponseError(failedStatus, null);
    // WebKit may replace the supplied abort reason with a generic fetch error.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    source?.removeEventListener("abort", abort);
  }
}

/** One game-side instant, minute precision, in the viewer's own timezone.
 *  Master dates are JST-authored and stored as UTC milliseconds; the
 *  browser converts them to local time. */
export function gameDateTime(locale: string, value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

/** A game-side window, rendered in the viewer's own timezone. */
export function gameDateTimeRange(locale: string, start: number, end: number): string {
  const from = gameDateTime(locale, start);
  const to = gameDateTime(locale, end);
  if (!from) return to;
  return `${from} - ${to || "\u2014"}`;
}
