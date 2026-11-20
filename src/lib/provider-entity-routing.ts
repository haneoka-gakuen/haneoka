import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";
import { isLocale } from "@haneoka/i18n";
import { providerEntityHtmlPath, providerEntityRoute, providerSongRoute, type ProviderEntityLocator } from "./provider-entity-data.ts";
import { PROVIDER_STORY_SECTIONS } from "./provider-page-data.ts";

const songId = (value: string | null | undefined) => value && /^[1-9]\d{0,15}$/u.test(value) ? value : undefined;

function entityId(value: string | null): string | undefined {
  return value && value.length <= 768 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
/** Preserve the original public URL while serving its generated document. */
export function providerEntityFromUrl(url: URL): ProviderEntityLocator | undefined {
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
  const tail = parts.slice(3);
  if (tail.length !== 2 && tail.length !== 3) return;
  if (tail[0] === "songs" && tail.length === 2) {
    const id = songId(tail[1]);
    return id ? { provider, locale, resource: "songs", id } : undefined;
  }
  if (tail[0] !== "stories" || !/^[a-z]+$/u.test(tail[1]!)) return;
  if (tail.length === 3) {
    let id: string | undefined;
    try {
      id = entityId(decodeURIComponent(tail[2]!));
    } catch {
      return;
    }
    if (!id) return;
    return provider === "bestdori" && tail[1] === "card" && /^\d+$/u.test(id)
      ? { provider, locale, resource: "cards", id }
      : { provider, locale, resource: "stories", section: tail[1]!, id };
  }
  const section = tail[1]!,
    story = entityId(url.searchParams.get("story"));
  const cardId = provider === "bestdori" && section === "card" ? entityId(url.searchParams.get("card")) : undefined;
  if (story) return { provider, locale, resource: "stories", section, id: story, ...(cardId ? { cardId } : {}) };
  if (cardId) return { provider, locale, resource: "cards", id: cardId };
  return;
}
/** Redirect bookmarked provider addresses to their current public paths. */
export function legacyProviderRedirectTarget(pathname: string, search = ""): string | undefined {
  if (!pathname.includes("/community/")) return;
  const songRedirect = providerSongRedirectTarget(pathname, search);
  if (songRedirect) return songRedirect;
  const parts = pathname.split("/").filter(Boolean);
  if (!isLocale(parts[0]) || parts[1] !== "community") return;
  if (parts.length === 6 && parts[3] === "stories" && !pathname.endsWith("/")) {
    const entry = providerEntityFromUrl(new URL(pathname, "https://haneoka.org"));
    if (entry) return `${providerEntityRoute(entry)}${search}`;
  }
  if ((parts[2] === "gbp" || parts[2] === "sekai") && parts[3] === "stories" && parts.length === 5) {
    const query = new URLSearchParams(search);
    const story = entityId(query.get("story"));
    const card = parts[2] === "gbp" && parts[4] === "card" ? entityId(query.get("card")) : undefined;
    const id = story || card;
    if (!id) return;
    query.delete("story");
    query.delete("card");
    return `${pathname.replace(/\/+$/u, "")}/${encodeURIComponent(id)}/${query.size ? `?${query}` : ""}`;
  }
  const story =
    parts[2] === "stories-bestdori" &&
    parts.length === 4 &&
    ["event", "band", "main", "afterlive", "card"].includes(parts[3]!);
  if (!story) return;
  return `/${parts[0]}/community/gbp/stories/${parts[3]}/${search}`;
}

function providerSongRedirectTarget(pathname: string, search: string): string | undefined {
  const parts = englishInterfacePath(pathname).replace(/\/index\.html$/u, "/").split("/").filter(Boolean);
  const [locale, community, namespace] = parts;
  if (!isLocale(locale) || community !== "community") return;
  const oldNamespace = namespace === "songs-bestdori";
  const legacy = oldNamespace && (parts.length === 3 || parts.length === 4 && parts[3] === "detail");
  if (!legacy && ((namespace !== "gbp" && namespace !== "sekai") || parts[3] !== "songs" || parts.length > 5)) return;
  const provider = namespace === "sekai" ? "sekai" : "bestdori";
  const selection = legacy ? parts[3] : parts[4];
  const query = new URLSearchParams(search);
  const id = songId(selection) || ((!selection || selection === "detail") ? songId(query.get("song")) : undefined);
  if (!id && !legacy && selection !== "detail") return;
  const language = interfaceLanguageFromPath(pathname);
  const target = id
    ? providerSongRoute(provider, locale, id)
    : `/${locale}/community/${provider === "bestdori" ? "gbp" : "sekai"}/songs/`;
  const route = language ? interfacePath(target, language.value) : target;
  if (route === pathname && !query.has("song")) return;
  query.delete("song");
  return `${route}${query.size ? `?${query}` : ""}`;
}
export function providerEntityPhysicalPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, "/");
}
export function providerEntityShellPath(pathname: string): string | undefined {
  const entry = providerEntityFromUrl(new URL(pathname, "https://haneoka.org"));
  if (!entry || entry.id === "_") return;
  if (entry.resource === "songs") return providerSongRoute(entry.provider, entry.locale, "_");
  const section = entry.resource === "cards" ? "card" : entry.section!;
  if (!(PROVIDER_STORY_SECTIONS[entry.provider] as readonly string[]).includes(section)) return;
  return `/${entry.locale}/community/${entry.provider === "bestdori" ? "gbp" : "sekai"}/stories/${section}/_/`;
}
