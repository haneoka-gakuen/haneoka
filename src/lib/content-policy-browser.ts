import {
  DEFAULT_VISIBILITY_POLICY,
  parseVisibilityPolicy,
  type ContentVisibilityPolicy,
  type ContentVisibilitySettings,
} from "./content-visibility-policy";
import { SPOILER_CONTENT_EVENT, spoilerContentEnabled } from "./spoiler-content";
import { RequestScope } from "./request-scope";
import { isUserGroup, type UserGroup } from "./user-roles";
import { publishContentCacheScope } from "./content-request";

const requests = new RequestScope();
let installed = false;
let activeRefresh: AbortSignal | undefined;
let refreshPromise: Promise<void> | undefined;
let parsed = "",
  policy = DEFAULT_VISIBILITY_POLICY;
export function currentVisibilityPolicy(): ContentVisibilityPolicy {
  if (typeof document === "undefined" || !document.documentElement) return DEFAULT_VISIBILITY_POLICY;
  const source = document.documentElement.dataset.contentVisibilityPolicy || "";
  if (source !== parsed) {
    parsed = source;
    try {
      policy = parseVisibilityPolicy(JSON.parse(source)) ?? DEFAULT_VISIBILITY_POLICY;
    } catch {
      policy = DEFAULT_VISIBILITY_POLICY;
    }
  }
  return policy;
}
export function currentContentGroup(): UserGroup {
  const group = typeof document === "undefined" ? undefined : document.documentElement?.dataset.contentGroup;
  return isUserGroup(group) ? group : "guest";
}
export const visibilityPolicyKey = (): string =>
  JSON.stringify([currentContentGroup(), spoilerContentEnabled(), currentVisibilityPolicy()]);
export function applyVisibilitySettings(settings: ContentVisibilitySettings & { group?: UserGroup }): void {
  const previous = visibilityPolicyKey();
  const pending = document.documentElement.dataset.contentVisibilityPending === "1";
  document.documentElement.dataset.contentVisibilityPolicy = JSON.stringify(settings.policy);
  document.documentElement.dataset.contentVisibilityVersion = String(settings.version);
  document.documentElement.dataset.contentVisibilityAt = String(Date.now());
  delete document.documentElement.dataset.contentVisibilityPending;
  if (settings.group) document.documentElement.dataset.contentGroup = settings.group;
  publishContentCacheScope();
  if (pending || previous !== visibilityPolicyKey()) dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}
function refreshVisibility(): Promise<void> {
  if (activeRefresh && !activeRefresh.aborted && refreshPromise) return refreshPromise;
  const signal = requests.begin();
  activeRefresh = signal;
  refreshPromise = fetch("/api/v1/content-visibility", { credentials: "same-origin", cache: "no-store", signal })
    .then(async (response) => {
      if (response.ok) {
        const settings = (await response.json()) as ContentVisibilitySettings & { group: UserGroup };
        if (requests.current(signal)) applyVisibilitySettings(settings);
      }
    })
    .catch(() => undefined)
    .finally(() => { if (activeRefresh === signal) activeRefresh = undefined; });
  return refreshPromise;
}
export const ensureContentVisibility = (fresh = false): Promise<void> =>
  !fresh && document.documentElement.dataset.contentVisibilityPolicy ? Promise.resolve() : refreshVisibility();
/** Display metadata last returned by the public-static view endpoint. */
export const PUBLIC_STATIC_METADATA_KEY = "haneoka:content-view-meta:v1";
type PublicStaticView = typeof import("./public-static-browser");
let publicStatic: Promise<PublicStaticView> | undefined;
/** Served by the static host in its public view, or replaced by the full document of such a page. */
const publicStaticDocument = (): boolean =>
  Boolean(
    document.documentElement.hasAttribute("data-public-static-view") ||
      document.head?.querySelector('meta[name="haneoka-public-static"]'),
  );
function withPublicStatic(run: (view: PublicStaticView) => void): void {
  publicStatic ??= import("./public-static-browser").then((view) => {
    view.installPublicStaticView();
    return view;
  });
  void publicStatic.then(run).catch(() => undefined);
}
/** The document response already selects the current display policy; public static pages decide on their own. */
function refreshDocumentVisibility(): void {
  if (publicStaticDocument()) withPublicStatic(() => undefined);
  else if (!document.documentElement.dataset.contentVisibilityPolicy) refreshVisibility();
}
function refreshCurrentVisibility(): void {
  if (!publicStaticDocument()) refreshVisibility();
  else if (publicStatic) void publicStatic.then((view) => view.refreshPublicStaticView());
}
export function installContentVisibility(): void {
  if (installed) return;
  installed = true;
  publishContentCacheScope();
  navigator.serviceWorker?.addEventListener("controllerchange", publishContentCacheScope);
  addEventListener(SPOILER_CONTENT_EVENT, publishContentCacheScope);
  addEventListener(SPOILER_CONTENT_EVENT, () => { if (document.querySelector("[data-content-unavailable]")) location.reload(); });
  refreshDocumentVisibility();
  addEventListener("haneoka:session-changed", () => {
    requests.cancel();
    activeRefresh = undefined;
    navigator.serviceWorker?.controller?.postMessage({ type: "haneoka:content-view-reset" });
    try {
      localStorage.removeItem(PUBLIC_STATIC_METADATA_KEY);
    } catch {}
    if (publicStaticDocument()) withPublicStatic((view) => view.resetPublicStaticView());
    else refreshVisibility();
  });
  addEventListener("focus", refreshCurrentVisibility);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCurrentVisibility(); });
  document.addEventListener("astro:page-load", () => { publishContentCacheScope(); refreshDocumentVisibility(); });
  document.addEventListener("astro:before-swap", (event) => {
    requests.cancel();
    activeRefresh = undefined;
    const next = (event as Event & { newDocument: Document }).newDocument;
    const current = document.documentElement.dataset;
    if (
      Number(current.contentVisibilityVersion || 0) > Number(next.documentElement.dataset.contentVisibilityVersion || 0)
    ) {
      next.documentElement.dataset.contentVisibilityPolicy = current.contentVisibilityPolicy;
      next.documentElement.dataset.contentVisibilityVersion = current.contentVisibilityVersion;
      next.documentElement.dataset.contentVisibilityAt = current.contentVisibilityAt;
    }
  });
}
