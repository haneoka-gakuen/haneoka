// L3 — GEB
// Input: Public provider document URLs, including legacy query selections.
// Output: Entity or player addresses, canonical redirects and core shell lookups.
// Pos: [Map](L2-2.md); shared provider routing for the browser and document servers.
// Effects/Dependencies: Pure URL and metadata transformations.
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";
import { isLocale } from "@haneoka/i18n";
import { providerEntityHtmlPath, providerEntityRoute, type ProviderEntityAddress, type ProviderEntityLocator } from "./provider-entity-data.ts";
import { PROVIDER_STORY_SECTIONS } from "./provider-page-data.ts";
import { rewriteCommunityDocument } from "./community-document-meta.ts";

const songId = (value: string | null | undefined) => value && /^[1-9]\d{0,15}$/u.test(value) ? value : undefined;

function entityId(value: string | null): string | undefined {
  return value && value.length <= 768 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
/** Preserve the original public URL while serving its generated document. */
export function providerEntityFromUrl(url: URL): ProviderEntityAddress | undefined {
  if (!url.pathname.includes("/community/")) return;
  const parts = englishInterfacePath(url.pathname)
    .replace(/\/index\.html$/u, "/")
    .split("/")
    .filter(Boolean);
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "community") return;
  const namespace = parts[2];
  if (namespace !== "sekai" && namespace !== "gbp") return;
  const provider = namespace === "gbp" ? "bestdori" : "sekai";
  const [collection, first, second, third] = parts.slice(3);
  if (collection === "songs") {
    const id = songId(first);
    if (!id || parts.length !== (second === "chart" ? 6 : 5)) return;
    return { provider, locale, resource: "songs", id, ...(second === "chart" ? { view: "chart" } : {}) };
  }
  const section = first!;
  if (collection !== "stories" || !(PROVIDER_STORY_SECTIONS[provider] as readonly string[]).includes(section)) return;
  if (parts.length === (third === "story" ? 7 : 6)) {
    let id: string | undefined;
    try {
      id = entityId(decodeURIComponent(second!));
    } catch {
      return;
    }
    if (!id) return;
    if (provider === "bestdori" && section === "card" && /^\d+$/u.test(id))
      return third ? undefined : { provider, locale, resource: "cards", id };
    return { provider, locale, resource: "stories", section, id, ...(third === "story" ? { view: "story" } : {}) };
  }
  if (parts.length !== 5) return;
  const story = entityId(url.searchParams.get("story"));
  const cardId = provider === "bestdori" && section === "card" ? entityId(url.searchParams.get("card")) : undefined;
  if (story) return { provider, locale, resource: "stories", section, id: story, ...(cardId ? { cardId } : {}) };
  if (cardId) return { provider, locale, resource: "cards", id: cardId };
  return;
}
/** Redirect bookmarked provider addresses to their current public paths. */
export function legacyProviderRedirectTarget(pathname: string, search = ""): string | undefined {
  if (!pathname.includes("/community/")) return;
  const english = englishInterfacePath(pathname);
  const parts = english.replace(/\/index\.html$/u, "/").split("/").filter(Boolean);
  const [locale, community, namespace] = parts;
  if (!isLocale(locale) || community !== "community") return;
  const query = new URLSearchParams(search);
  let entry = providerEntityFromUrl(new URL(pathname + search, "https://haneoka.org"));
  let collection: string | undefined;
  if (!entry) {
    const legacySongs = namespace === "songs-bestdori" && (parts.length === 3 || parts.length === 4 && parts[3] === "detail");
    const songs = (namespace === "gbp" || namespace === "sekai") && parts[3] === "songs" &&
      (parts.length === 4 || parts.length === 5 && parts[4] === "detail");
    if (legacySongs || songs) {
      const provider = namespace === "sekai" ? "sekai" : "bestdori";
      const id = songId(query.get("song"));
      if (id) entry = { provider, locale, resource: "songs", id };
      else if (legacySongs || parts[4] === "detail")
        collection = `/${locale}/community/${provider === "sekai" ? "sekai" : "gbp"}/songs/`;
    } else if (namespace === "stories-bestdori" && parts.length === 4 &&
        (PROVIDER_STORY_SECTIONS.bestdori as readonly string[]).includes(parts[3]!)) {
      collection = `/${locale}/community/gbp/stories/${parts[3]}/`;
      entry = providerEntityFromUrl(new URL(collection + search, "https://haneoka.org"));
    }
  }
  if (!entry && !collection) return;
  if (entry?.resource === "songs" || collection?.endsWith("/songs/")) {
    query.delete("song");
    if (entry && (entry.view === "chart" || query.get("chart") === "1")) {
      entry.view = "chart";
      query.delete("chart");
    }
  } else if (entry) {
    query.delete("story");
    query.delete("card");
    if (entry.resource === "stories" && (entry.view === "story" || query.get("playback") === "play")) {
      entry.view = "story";
      query.delete("playback");
    }
  }
  const language = interfaceLanguageFromPath(pathname);
  const target = entry ? providerEntityRoute(entry) : collection!;
  const route = language ? interfacePath(target, language.value) : target;
  if (route === pathname && query.toString() === new URLSearchParams(search).toString()) return;
  return `${route}${query.size ? `?${query}` : ""}`;
}
export function providerEntityPhysicalPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, "/");
}
export function providerEntityShellPath(pathname: string): string | undefined {
  const entry = providerEntityFromUrl(new URL(pathname, "https://haneoka.org"));
  if (!entry || entry.id === "_") return;
  return providerEntityRoute({ ...entry, id: "_" });
}

export function rewriteProviderPlayerDocument(html: string, entry: ProviderEntityAddress, origin: string): string {
  return rewriteCommunityDocument(html, entry.locale, (locale) => providerEntityRoute({ ...entry, locale: locale as typeof entry.locale }), origin);
}
