import {
  DEFAULT_VISIBILITY_POLICY,
  parseVisibilityPolicy,
  type ContentVisibilityPolicy,
  type ContentVisibilitySettings,
} from "./content-visibility-policy";
import { SPOILER_CONTENT_EVENT, spoilerContentEnabled } from "./spoiler-content";
import { RequestScope } from "./request-scope";
import { isUserGroup, type UserGroup } from "./user-roles";

const requests = new RequestScope();
let installed = false;
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
  document.documentElement.dataset.contentVisibilityPolicy = JSON.stringify(settings.policy);
  document.documentElement.dataset.contentVisibilityVersion = String(settings.version);
  document.documentElement.dataset.contentVisibilityAt = String(Date.now());
  if (settings.group) document.documentElement.dataset.contentGroup = settings.group;
  if (previous !== visibilityPolicyKey()) dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}
function refreshVisibility(): void {
  const signal = requests.begin();
  void fetch("/api/v1/content-visibility", { credentials: "same-origin", cache: "no-store", signal })
    .then(async (response) => {
      if (response.ok) {
        const settings = (await response.json()) as ContentVisibilitySettings & { group: UserGroup };
        if (requests.current(signal)) applyVisibilitySettings(settings);
      }
    })
    .catch(() => undefined);
}
/** A document whose policy the Worker wrote within the last minute needs no second read. */
const POLICY_FRESHNESS = 60_000;
function refreshStaleVisibility(): void {
  const data = document.documentElement.dataset;
  const age = Math.abs(Date.now() - Number(data.contentVisibilityAt));
  if (!data.contentVisibilityPolicy || !(age <= POLICY_FRESHNESS)) refreshVisibility();
}
export function installContentVisibility(): void {
  if (installed) return;
  installed = true;
  refreshStaleVisibility();
  addEventListener("haneoka:session-changed", refreshVisibility);
  document.addEventListener("astro:page-load", refreshStaleVisibility);
  document.addEventListener("astro:before-swap", (event) => {
    requests.cancel();
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
