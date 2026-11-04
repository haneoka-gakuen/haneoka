import type { AstroIntegration } from "astro";
import { communityStoryShellPath, legacyCommunityStoryRedirectTarget } from "../lib/community-story-route";
import { communityChartShellPath, legacyCommunityChartRedirectTarget } from "../lib/community-chart-route";
import fs from "node:fs";
import path from "node:path";
import {
  legacyProviderRedirectTarget,
  providerEntityFromUrl,
  providerEntityPhysicalPath,
  providerStoryShellPath,
} from "../lib/provider-entity-routing";
import { providerEntityHtmlPath } from "../lib/provider-entity-data";
import { providerEntityManifestEntry, providerEntityRoot } from "./provider-entity-manifest";
import { staticViewFromUrl } from "../lib/static-view-routing";
import { assetStaticDocumentFromUrl } from "../lib/asset-static-routing";
import { playlistStaticDocumentFromUrl } from "../lib/playlists/static-routing";

type Setup = NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>;
type DevServer = Parameters<Setup>[0]["server"];

/** Capture query selection before Astro strips it from prerendered requests. */
export function installProviderDevRouting(server: DevServer): void {
  server.middlewares.use((request, response, next) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const chartShell = communityChartShellPath(url.pathname);
      if (chartShell) {
        request.headers["x-haneoka-chart-path"] = url.pathname;
        request.url = `${chartShell}${url.search}`;
      }
      const storyShell = communityStoryShellPath(url.pathname);
      if (storyShell) {
        request.headers["x-haneoka-story-path"] = url.pathname;
        request.url = `${storyShell}${url.search}`;
      }
      const legacy =
        legacyCommunityStoryRedirectTarget(url.pathname, url.search) ??
        legacyCommunityChartRedirectTarget(url.pathname, url.search) ??
        legacyProviderRedirectTarget(url.pathname, url.search);
      if (legacy && (request.method === "GET" || request.method === "HEAD")) {
        response.writeHead(308, { Location: legacy, "Cache-Control": "public, max-age=86400" });
        response.end();
        return;
      }
      const selected = providerEntityFromUrl(url);
      if (selected) {
        const entry = fs.existsSync(path.join(providerEntityRoot(), "manifest.json"))
          ? providerEntityManifestEntry(providerEntityHtmlPath(selected), true)
          : undefined;
        if (entry) request.url = `${providerEntityPhysicalPath(entry)}${url.search}`;
        else {
          const shell = providerStoryShellPath(url.pathname);
          if (shell) request.url = `${shell}${url.search}`;
        }
      } else {
        const view = assetStaticDocumentFromUrl(url) || playlistStaticDocumentFromUrl(url) || staticViewFromUrl(url);
        if (view) request.url = `${view}${url.search}`;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}
