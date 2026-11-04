// L3 — GEB
// Input: 当前浏览器会话和账号能力接口。
// Output: 文档能力状态、策略版本及工作区更新事件。
// Pos: [Map](L2-2.md)；浏览器账号能力刷新边界。
// Effects/Dependencies: 取消旧请求、无缓存读取、更新 DOM 状态并派发事件；失败时关闭能力。
import { RequestScope } from "./request-scope";
import { SPOILER_CONTENT_EVENT } from "./spoiler-content";
import {
  clearContentSources,
  replaceContentSources,
  CONTENT_SOURCE_IDS,
  isContentSourceId,
  contentSourceFamily,
  isContentSourceFamily,
  type ContentSourceFamily,
} from "./content-access-state";

const requests = new RequestScope();
if (typeof window !== "undefined" && window === globalThis)
  document.addEventListener("astro:before-swap", () => requests.cancel());

function publish(allowed: boolean, version?: number, sources: readonly string[] = [], families: Readonly<Record<string, ContentSourceFamily>> = {}): void {
  const sourceScope = () => CONTENT_SOURCE_IDS.map((source) => [source, contentSourceFamily(source)]);
  const previousScope = JSON.stringify([document.documentElement.dataset.contentAccess === "1", sourceScope()]);
  clearContentSources();
  delete document.documentElement.dataset.contentSources;
  delete document.documentElement.dataset.contentSourceFamilies;
  document.documentElement.dataset.contentAccess = allowed ? "1" : "0";
  if (allowed) {
    replaceContentSources(sources, families);
    document.documentElement.dataset.contentSources = JSON.stringify(CONTENT_SOURCE_IDS);
    document.documentElement.dataset.contentSourceFamilies = JSON.stringify(families);
  }
  if (version !== undefined) document.documentElement.dataset.siteSettingsVersion = String(version);
  if (previousScope !== JSON.stringify([allowed, sourceScope()]))
    dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}

export function clearContentAccess(): void {
  requests.cancel();
  if (typeof document !== "undefined" && document.documentElement) publish(false);
}

export async function refreshContentAccess(): Promise<void> {
  if (typeof document === "undefined" || !document.documentElement) return;
  const signal = requests.begin();
  const deadline = setTimeout(() => {
    if (requests.current(signal)) {
      publish(false);
      requests.cancel();
    }
  }, 10_000);
  try {
    const response = await fetch("/api/v1/account/content-access", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
    if (!requests.current(signal)) return;
    if (!response.ok) {
      publish(false);
      await response.body?.cancel();
      return;
    }
    const value: unknown = await response.json();
    if (!requests.current(signal)) return;
    if (!value || typeof value !== "object") {
      publish(false);
      return;
    }
    const { allowed, version, sources, sourceFamilies } = value as { allowed?: unknown; version?: unknown; sources?: unknown; sourceFamilies?: unknown };
    if (typeof allowed !== "boolean" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      publish(false);
      return;
    }
    if (version < Number(document.documentElement.dataset.siteSettingsVersion || 0)) return;
    if (allowed && (!Array.isArray(sources) || !sources.every(isContentSourceId))) {
      publish(false, version);
      return;
    }
    const families = sourceFamilies ?? {};
    if (allowed && (!families || typeof families !== "object" || Array.isArray(families) ||
      !Object.entries(families).every(([source, family]) => (sources as string[]).includes(source) && isContentSourceFamily(family)))) {
      publish(false, version);
      return;
    }
    publish(allowed, version, allowed ? (sources as string[]) : [], families as Record<string, ContentSourceFamily>);
  } catch {
    if (requests.current(signal)) publish(false);
  } finally {
    clearTimeout(deadline);
  }
}
