// L3 — GEB
// Input: Haneoka 已完成镜像的应用发布清单及内置快照。
// Output: 网页安装入口所用的固定版本下载地址。
// Pos: [Map](L2-2.md)；构建期应用发布读取器。
// Effects/Dependencies: 构建输入捕获与 Haneoka HTTP 读取，失败使用已验证内置快照。
import fallback from "../config/app-release.json";
import { staticBuildJson } from "./static-input-store";

export interface AppRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string | null;
  }[];
}

/** Stable public release data; asset names retain platform, architecture and format. */
export function normalizeAppRelease(value: AppRelease): AppRelease {
  return {
    tag_name: value.tag_name,
    html_url: value.html_url,
    published_at: value.published_at,
    assets: value.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      browser_download_url: asset.browser_download_url,
      ...(asset.digest !== undefined ? { digest: asset.digest } : {}),
    })),
  };
}
let release: Promise<AppRelease> | undefined;
/** Resolve once per build; a verified release keeps downloads available offline. */
export function appRelease(): Promise<AppRelease> {
  return (release ??= staticBuildJson("app-release:latest", "public-data", () =>
    fetch("https://haneoka.org/downloads/app/latest.json", {
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
              asset.browser_download_url.startsWith("https://haneoka.org/downloads/app/"),
          )
        ) {
          throw new Error("Invalid app release");
        }
        return normalizeAppRelease(data);
      })
      .catch((error) => {
        console.warn("Using bundled Haneoka app release:", error.message);
        return normalizeAppRelease(fallback);
      }),
  ));
}
