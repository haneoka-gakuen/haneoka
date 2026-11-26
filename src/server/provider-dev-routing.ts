import type { AstroIntegration } from "astro";
import { communityStoryShellPath, legacyCommunityStoryRedirectTarget } from "../lib/community-story-route";
import { communityChartShellPath, legacyCommunityChartRedirectTarget } from "../lib/community-chart-route";
import fs from "node:fs";
import path from "node:path";
import {
  legacyProviderRedirectTarget,
  providerEntityFromUrl,
  providerEntityPhysicalPath,
  providerEntityShellPath,
} from "../lib/provider-entity-routing";
import { providerEntityHtmlPath } from "../lib/provider-entity-data";
import { providerEntityManifestEntry, providerEntityRoot } from "./provider-entity-manifest";
import { legacyStaticViewRedirectTarget, staticViewFromUrl } from "../lib/static-view-routing";
import { assetStaticDocumentFromUrl, legacyAssetRedirectTarget } from "../lib/asset-static-routing";
import { legacyPlaylistRedirectTarget, playlistShellPath, playlistStaticDocumentFromUrl } from "../lib/playlists/static-routing";
import { editorShellPath, legacyEditorRedirectTarget } from "../lib/editor-document-route";
import { documentPrefixRedirectTarget, documentPrefixResponse, legacyEntityRedirectTarget, releaseServerFromCookie } from "../lib/resource-route";
import { negotiateRequestLocale } from "../i18n/negotiation";
import { sonolusShareRedirectTarget } from "../../worker/sonolus-share";
import { isRemovedCatalogPagePath } from "../lib/temporary-public-routing";

type Setup = NonNullable<AstroIntegration["hooks"]["astro:server:setup"]>;
type DevServer = Parameters<Setup>[0]["server"];

/** Preserve preferences and query selection before Astro strips prerender request state. */
export function installProviderDevRouting(server: DevServer): void {
  server.middlewares.use(async (request, response, next) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (isRemovedCatalogPagePath(url.pathname)) {
        response.writeHead(404, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
        response.end(request.method === "HEAD" ? undefined : "Not found");
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        let savedServer: ReturnType<typeof releaseServerFromCookie>;
        const prefix = documentPrefixRedirectTarget(url.pathname, url.search,
          () => negotiateRequestLocale(request.headers.cookie || "", request.headers["accept-language"] || ""),
          () => savedServer = releaseServerFromCookie(request.headers.cookie || ""));
        if (prefix && !sonolusShareRedirectTarget(url.pathname, url.search, "haneoka.org")) {
          const redirect = documentPrefixResponse(prefix, savedServer, request.method === "GET" && request.headers.accept?.includes("text/html") === true);
          response.writeHead(redirect.status, Object.fromEntries(redirect.headers));
          response.end(request.method === "HEAD" ? undefined : await redirect.text());
          return;
        }
      }
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
        legacyPlaylistRedirectTarget(url.pathname, url.search) ??
        legacyStaticViewRedirectTarget(url.pathname, url.search) ??
        legacyAssetRedirectTarget(url.pathname, url.search) ??
        legacyEditorRedirectTarget(url.pathname, url.search) ??
        legacyProviderRedirectTarget(url.pathname, url.search) ??
        legacyEntityRedirectTarget(url.pathname, url.search);
      if (legacy && (request.method === "GET" || request.method === "HEAD")) {
        response.writeHead(308, { Location: legacy, "Cache-Control": "public, max-age=86400" });
        response.end();
        return;
      }
      const selected = providerEntityFromUrl(url);
      if (selected) {
        const entry = !selected.view && fs.existsSync(path.join(providerEntityRoot(), "manifest.json"))
          ? providerEntityManifestEntry(providerEntityHtmlPath(selected), true)
          : undefined;
        if (entry) request.url = `${providerEntityPhysicalPath(entry)}${url.search}`;
        else {
          const shell = providerEntityShellPath(url.pathname);
          if (shell) request.url = `${shell}${url.search}`;
        }
      } else {
        const view = assetStaticDocumentFromUrl(url) || playlistStaticDocumentFromUrl(url) || playlistShellPath(url.pathname) || editorShellPath(url.pathname) || staticViewFromUrl(url);
        if (view) request.url = `${view}${url.search}`;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}
