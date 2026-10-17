import fallback from "../config/app-release.json";
import { staticBuildJson } from "./static-input-store";

export type AppRelease = typeof fallback;
let release: Promise<AppRelease> | undefined;
/** Resolve once per build; a verified release keeps downloads available offline. */
export function appRelease(): Promise<AppRelease> {
  return (release ??= staticBuildJson("app-release:latest", "public-data", () =>
    fetch("https://api.github.com/repos/haneoka-gakuen/haneoka-app/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub release: ${response.status}`);
        const data = (await response.json()) as AppRelease;
        if (
          !data.tag_name ||
          !Array.isArray(data.assets) ||
          !data.assets.length ||
          !data.html_url.startsWith("https://github.com/haneoka-gakuen/haneoka-app/releases/") ||
          !data.assets.every(
            (asset) =>
              typeof asset.name === "string" &&
              typeof asset.size === "number" &&
              asset.browser_download_url.startsWith("https://github.com/haneoka-gakuen/haneoka-app/releases/download/"),
          )
        ) {
          throw new Error("Invalid app release");
        }
        return data;
      })
      .catch((error) => {
        console.warn("Using bundled Haneoka app release:", error.message);
        return fallback;
      }),
  ));
}
