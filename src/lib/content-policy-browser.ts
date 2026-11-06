import {
  DEFAULT_VISIBILITY_POLICY,
  VISIBILITY_WORKSPACES,
  parseVisibilityPolicy,
  type ContentVisibilityPolicy,
  type ContentVisibilitySettings,
} from "./content-visibility-policy";
import { SPOILER_CONTENT_EVENT } from "./spoiler-content";

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
export const visibilityPolicyKey = (): string => JSON.stringify(currentVisibilityPolicy());
export function applyVisibilitySettings(settings: ContentVisibilitySettings): void {
  document.documentElement.dataset.contentVisibilityPolicy = JSON.stringify(settings.policy);
  document.documentElement.dataset.contentVisibilityVersion = String(settings.version);
  dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}
export function installContentVisibility(): void {
  if (!document.documentElement.dataset.contentVisibilityPolicy)
    void fetch("/api/v1/content-visibility")
      .then(async (response) => {
        if (response.ok) applyVisibilitySettings((await response.json()) as ContentVisibilitySettings);
      })
      .catch(() => undefined);
  document.addEventListener("astro:before-swap", (event) => {
    const next = (event as Event & { newDocument: Document }).newDocument;
    const current = document.documentElement.dataset;
    if (
      Number(current.contentVisibilityVersion || 0) > Number(next.documentElement.dataset.contentVisibilityVersion || 0)
    ) {
      next.documentElement.dataset.contentVisibilityPolicy = current.contentVisibilityPolicy;
      next.documentElement.dataset.contentVisibilityVersion = current.contentVisibilityVersion;
      for (const workspace of next.querySelectorAll(
        VISIBILITY_WORKSPACES.map((tag) => `${tag}[data-prerendered]`).join(","),
      )) {
        const data = [...workspace.querySelectorAll('script[type="application/json"]')];
        workspace.replaceChildren(...data);
        workspace.removeAttribute("data-prerendered");
      }
      const home = next.querySelector("home-dashboard[data-prerendered]");
      if (home) {
        for (const child of [...home.children]) if (child.tagName !== "SCRIPT") child.remove();
        home.removeAttribute("data-prerendered");
      }
    }
  });
}
