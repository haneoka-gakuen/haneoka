// L3 — GEB
// Input: The app bridge's advertised version (or the HaneokaApp user agent).
// Output: A once-per-session update notice guiding old app builds to the download page.
// Pos: [Map](L2-2.md); app update guidance boundary.
// Effects/Dependencies: Shows a snackbar with a link; never blocks requests or pages.
import { clientText } from "../i18n/client";
import { snackbar } from "./snackbar";

/** The oldest app whose save automation works without a site page driving it. */
const MINIMUM_APP_VERSION = [0, 4, 0] as const;
const DISMISS_KEY = "haneoka:app-update-notice:v1";

function appVersion(): readonly number[] | undefined {
  const raw =
    (window as Window & { haneokaApp?: { version?: string } }).haneokaApp?.version ??
    navigator.userAgent.match(/HaneokaApp\/([\d.]+)/u)?.[1];
  if (!raw) return undefined;
  const parts = String(raw).split(".").map(Number);
  return parts.length && parts.every(Number.isFinite) ? parts : undefined;
}

function atLeast(version: readonly number[], minimum: readonly number[]) {
  for (let index = 0; index < Math.max(version.length, minimum.length); index++) {
    const left = version[index] ?? 0,
      right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Old app builds keep working; this only points at the download page. */
export function installAppUpdateNotice() {
  if (!("haneokaApp" in window) && !/HaneokaApp\//u.test(navigator.userAgent)) return;
  const version = appVersion();
  if (!version || atLeast(version, MINIMUM_APP_VERSION)) return;
  try {
    if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage unavailable; the notice may repeat across navigations.
  }
  const locale = document.documentElement.lang || "ja";
  snackbar(clientText(locale, "common.states.appUpdateAvailable", "A new app version is available"), {
    durationMs: 10_000,
    action: {
      label: clientText(locale, "common.actions.download", "Download"),
      run: () => {
        location.assign(`/${locale}/download/`);
      },
    },
  });
}
