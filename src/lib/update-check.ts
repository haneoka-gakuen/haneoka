/** Offers a reload when a newer deployment is live, so an open tab never runs stale chunks. */
import { snackbar } from "./snackbar";
import { clientText } from "../i18n/client";
import { publishedWebBuildId, WEB_BUILD_ATTRIBUTE } from "./web-build-id";

declare const __WEB_BUILD_ID__: string;

const CHECK_MS = 10 * 60 * 1000;
let last = 0;
let offered = false;
let initialBuildId = "";

async function check() {
  if (offered || document.visibilityState !== "visible" || Date.now() - last < CHECK_MS) return;
  last = Date.now();
  try {
    const response = await fetch("/build.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return;
    const build = (await response.json()) as { id?: string; web?: string };
    if (!build.id || publishedWebBuildId(build) === initialBuildId) return;
    offered = true;
    const locale = document.documentElement.lang || "ja";
    snackbar(clientText(locale, "common.states.updateAvailable", "A new version is available"), {
      durationMs: 0,
      action: { label: clientText(locale, "common.actions.reload", "Reload"), run: () => location.reload() },
    });
  } catch {
    return;
  }
}

export function installUpdateCheck() {
  if (import.meta.env.DEV) return;
  // Capture the loaded document, before subsequent Astro navigations can replace its attributes.
  initialBuildId = document.documentElement.getAttribute(WEB_BUILD_ATTRIBUTE) || __WEB_BUILD_ID__;
  if (!initialBuildId) return;
  last = Date.now();
  setInterval(() => void check(), CHECK_MS);
}
