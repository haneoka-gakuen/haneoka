import { isLocale } from "@haneoka/i18n";
import { providerEntityHtmlPath, type ProviderEntityLocator } from "./provider-entity-data.ts";

function entityId(value: string | null): string | undefined {
  return value && value.length <= 768 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}
/** Preserve the original public URL while serving its generated document. */
export function providerEntityFromUrl(url: URL): ProviderEntityLocator | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "community") return;
  const namespace = parts[2];
  if (namespace !== "sekai" && namespace !== "gbp") return;
  const provider = namespace === "gbp" ? "bestdori" : "sekai";
  const tail = parts.slice(3);
  if (tail.length !== 2 && tail.length !== 3) return;
  const song = tail[0] === "songs" && tail[1] === "detail";
  if (song && tail.length === 2) {
    const id = entityId(url.searchParams.get("song"));
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
/** Keep bookmarked GBP addresses while the public namespace follows the game. */
export function legacyProviderRedirectTarget(pathname: string, search = ""): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (!isLocale(parts[0]) || parts[1] !== "community") return;
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
  const song = parts[2] === "songs-bestdori" && (parts.length === 3 || (parts.length === 4 && parts[3] === "detail"));
  const story =
    parts[2] === "stories-bestdori" &&
    parts.length === 4 &&
    ["event", "band", "main", "afterlive", "card"].includes(parts[3]!);
  if (!song && !story) return;
  return `/${parts[0]}/community/gbp/${song ? `songs${parts[3] ? "/detail" : ""}` : `stories/${parts[3]}`}/${search}`;
}
export function providerEntityPhysicalPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, "/");
}
