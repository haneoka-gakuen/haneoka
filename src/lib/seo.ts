import { localePath, localeTag, type Locale } from "../i18n/locales";
import { CATALOG_HUB, PRIMARY_DESTINATIONS, isDestinationActive } from "../config/navigation";
import { t } from "../i18n/messages";
import { serverText } from "../i18n/server";
import {
  isReleaseServer,
  parseResourceRoute,
  resourceCollectionHref,
  resourceKindForCollection,
  resourcePath,
} from "./resource-route";

import { isTemporarilyHiddenRoute } from "./temporary-public-routing";

const PRIVATE_ROUTES = new Set([
  "/account",
  "/account/reset-password",
  "/settings",
  "/community",
  "/community/mine",
  "/community/bookmarks",
  "/community/notifications",
  "/community/activity",
  "/community/posts/new",
]);

export function canonicalPath(route: string): string {
  const clean = `/${route.replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/" : `${clean}/`;
}

export function shouldNoindex(route: string): boolean {
  const path = canonicalPath(route).replace(/\/$/, "") || "/";
  return (
    isTemporarilyHiddenRoute(path) ||
    PRIVATE_ROUTES.has(path) ||
    path === "/catalog/assets" ||
    path.startsWith("/catalog/assets/") ||
    path === "/admin" ||
    path.startsWith("/admin/")
  );
}

const withoutSiteSuffix = (title: string): string =>
  title.replace(/\s*·\s*haneoka(?:\s*-\s*BanG Dream! Our Notes.*)?$/u, "").trim();

export function pageTitle(locale: Locale, route: string, title: string): string {
  if (route === "/") return `haneoka - ${serverText(locale, "seo.homeTitle", undefined, title)}`;
  const name = withoutSiteSuffix(title);
  const site = serverText(locale, "seo.siteTitle", undefined, "BanG Dream! Our Notes Archive");
  return `${name && name !== "haneoka" ? `${name} · ` : ""}haneoka - ${site}`;
}

/** Small, page-specific vocabulary for clients that consume keyword metadata. */
export function pageKeywords(locale: Locale, route: string, title: string): string {
  const kind =
    parseResourceRoute(route)?.kind ?? (route.startsWith("/catalog/") ? route.slice(9).split("/")[0] : undefined);
  const category = kind
    ? serverText(locale, `seo.keywords.resources.${kind}`, undefined, "")
    : route === "/stamp-maker" || route === "/tools/stamp-maker"
      ? serverText(locale, "seo.keywords.stampMaker", undefined, "")
      : route.startsWith("/chart-editor")
        ? serverText(locale, "seo.keywords.chartEditor", undefined, "")
        : "";
  return [
    ...new Set(
      [withoutSiteSuffix(title), serverText(locale, "seo.keywords.base", undefined, ""), category]
        .flatMap((value) => value.split(",").map((term) => term.trim()))
        .filter(Boolean),
    ),
  ].join(", ");
}

export function pageSummary(locale: Locale, route: string, title: string, description?: string): string {
  const context = pageDescription(locale, route, title);
  const supplied = description?.trim();
  if (!supplied || supplied === title.trim() || context.includes(supplied)) return context;
  return supplied.length >= context.length ? supplied : `${supplied} ${context}`;
}

export function pageStructuredData(
  origin: string,
  route: string,
  locale: Locale,
  name: string,
  description: string,
  localized = false,
  canonicalRoute = route,
) {
  const serverPrefix = canonicalRoute.split("/")[1];
  const server = isReleaseServer(serverPrefix) ? serverPrefix : undefined;
  const address = (logicalRoute: string) =>
    `${origin}${canonicalPath(
      logicalRoute === "/"
        ? `/${server ?? "intl"}/${locale}/`
        : ((server ? resourceCollectionHref(logicalRoute, server, locale) : undefined) ??
            (localized ? localePath(logicalRoute, locale) : logicalRoute)),
    )}`;
  const home = address("/");
  const url = `${origin}${canonicalPath(canonicalRoute)}`;
  const website = {
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    url: `${origin}/`,
    name: "haneoka",
    alternateName: "Haneoka",
  };
  const page = {
    "@type": "WebPage",
    "@id": `${url}#page`,
    url,
    name,
    description,
    inLanguage: localeTag(locale),
    isPartOf: { "@id": website["@id"] },
  };
  if (route === "/") return { "@context": "https://schema.org", "@graph": [website, page] };
  const parent = PRIMARY_DESTINATIONS.find((destination) => isDestinationActive(destination, route));
  const canonicalResource = parseResourceRoute(canonicalRoute);
  const collectionUrl = canonicalResource?.id
    ? `${origin}${
        canonicalResource.kind === "stories" && route.startsWith("/catalog/stories/")
          ? resourceCollectionHref(route, canonicalResource.server, locale)
          : resourcePath({ ...canonicalResource, id: undefined })
      }`
    : undefined;
  const collection = canonicalResource
    ? CATALOG_HUB.find((entry) => resourceKindForCollection(entry.resource || "") === canonicalResource.kind)
    : undefined;
  const trail = [
    { name: "haneoka", item: home },
    ...(collectionUrl && canonicalResource
      ? [
          { name: t(locale, "catalog", "Catalog"), item: address("/catalog") },
          { name: t(locale, collection?.label || canonicalResource.kind, canonicalResource.kind), item: collectionUrl },
        ]
      : parent && parent.route !== "/" && canonicalPath(parent.route) !== canonicalPath(route)
        ? [{ name: t(locale, parent.label, parent.id), item: address(parent.route) }]
        : []),
    { name: withoutSiteSuffix(name), item: url },
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      page,
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: trail.map((item, index) => ({ "@type": "ListItem", position: index + 1, ...item })),
      },
    ],
  };
}

export function pageDescription(locale: Locale, route: string, title: string): string {
  const kind =
    parseResourceRoute(route)?.kind ?? (route.startsWith("/catalog/") ? route.slice(9).split("/")[0] : undefined);
  const resource = kind ? serverText(locale, `seo.resources.${kind}`, undefined, "") : "";
  if (resource) return resource;
  const key =
    route === "/"
      ? "home"
      : route === "/stamp-maker" || route === "/tools/stamp-maker"
        ? "stampMaker"
        : route.startsWith("/chart-editor")
          ? "chartEditor"
          : /\/announcements(?:\/|$)/u.test(route)
            ? "announcements"
            : route === "/catalog"
              ? "catalog"
              : route.startsWith("/catalog/")
                ? "catalogItem"
                : route === "/about"
                  ? "about"
                  : route === "/community/tags"
                    ? "communityTags"
                    : route === "/community/playlists"
                      ? "communityPlaylists"
                      : route === "/community/songs-bestdori"
                        ? "communitySongs"
                        : route.startsWith("/community/stories-bestdori/")
                          ? "communityStories"
                          : route.startsWith("/community")
                            ? "community"
                            : route === "/terms"
                              ? "terms"
                              : route === "/privacy"
                                ? "privacy"
                                : "general";
  return serverText(locale, `seo.descriptions.${key}`, { title }, title).trim();
}
