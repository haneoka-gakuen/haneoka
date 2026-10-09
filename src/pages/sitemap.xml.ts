import type { APIRoute } from "astro";
import { LOCALES, localePath } from "../i18n/locales";
import { announcementPath } from "../lib/announcements";
import { ROUTES } from "../config/routes";
import { canonicalPath, shouldNoindex } from "../lib/seo";
import { searchableCatalogUrls } from "../lib/searchable-catalog";
import { searchableHelpUrls } from "../lib/searchable-help";
import { searchableModelUrls } from "../lib/searchable-models";
import { searchableStoryUrls } from "../lib/searchable-stories";
import {
  legacyEntityRedirectTarget,
  resourceCollectionHref,
  homePath,
  isReleaseServer,
  type ReleaseServer,
} from "../lib/resource-route";

import { isPublicReleaseServer } from "../lib/release-server";

const XML_ROUTES = ROUTES.filter(({ route, staticRedirect }) => !staticRedirect && !shouldNoindex(route));

export const GET: APIRoute = async () => {
  const configured = process.env.STATIC_RESOURCE_SERVERS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const servers = [...new Set(configured?.length ? configured : ["intl"])];
  if (!servers.every(isReleaseServer)) throw new Error("Unsupported static resource server");
  const urls = new Set<string>();
  for (const selected of servers.filter(isPublicReleaseServer)) {
    const server = selected as ReleaseServer;
    for (const locale of LOCALES) urls.add(`https://haneoka.org${announcementPath(server, locale)}`);
    const [catalogUrls, storyUrls, modelUrls, helpUrls] = await Promise.all([
      searchableCatalogUrls(server),
      searchableStoryUrls(server),
      searchableModelUrls(server),
      searchableHelpUrls(server),
    ]);
    for (const { route } of XML_ROUTES) {
      for (const locale of LOCALES) {
        const canonical =
          route === "/"
            ? homePath(server, locale)
            : (resourceCollectionHref(route, server, locale) ?? localePath(route, locale));
        urls.add(`https://haneoka.org${canonicalPath(canonical)}`);
      }
    }
    for (const route of [...catalogUrls, ...storyUrls, ...modelUrls, ...helpUrls]) {
      for (const locale of LOCALES) {
        const target = legacyEntityRedirectTarget(`/${locale}${route}`, `?server=${server}`);
        if (target) urls.add(`https://haneoka.org${target}`);
      }
    }
  }
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...urls].map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
};
