import { isLocale, type Locale } from "@haneoka/i18n";
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../../i18n/interface-route.ts";

const uuid = /^[0-9a-f-]{36}$/iu;
const validId = (value: string) => Boolean(value) && value.length <= 512 && ![".", "..", "_", "new"].includes(value) && !/[\\/\u0000-\u001f\u007f]/u.test(value);

export function playlistPath(locale: string, id = "", edit = false): string {
  const root = `/${locale}/community/playlists/`;
  if (!id) return root;
  if (edit && id === "new") return `${root}new/`;
  return `${root}${encodeURIComponent(id)}/${edit ? "edit/" : ""}`;
}

export function parsePlaylistDocument(pathname: string) {
  if (pathname.endsWith("/index.html")) return;
  const [locale, community, playlists, value, action, ...extra] = englishInterfacePath(pathname).split("/").filter(Boolean);
  if (!isLocale(locale) || community !== "community" || playlists !== "playlists" || !value || extra.length) return;
  if (value === "new" && !action) return { locale, id: "new", edit: true };
  try {
    const id = decodeURIComponent(value);
    if (validId(id) && (!action || action === "edit" && uuid.test(id))) return { locale, id, edit: Boolean(action) };
  } catch { return; }
  return undefined;
}

export function legacyPlaylistRedirectTarget(pathname: string, search: string): string | undefined {
  const [locale, community, playlists, ...extra] = englishInterfacePath(pathname).split("/").filter(Boolean);
  if (!isLocale(locale) || community !== "community" || playlists !== "playlists" || extra.length) return;
  const query = new URLSearchParams(search);
  const edit = query.get("edit") || "";
  const id = edit || query.get("playlist") || "";
  if (edit ? edit !== "new" && !uuid.test(edit) : !validId(id)) return;
  query.delete("edit");
  query.delete("playlist");
  const href = playlistPath(locale, id, Boolean(edit));
  const language = interfaceLanguageFromPath(pathname);
  return (language ? interfacePath(href, language.value) : href) + (query.size ? `?${query}` : "");
}

export function playlistShellPath(pathname: string): string | undefined {
  const route = parsePlaylistDocument(pathname);
  return route && playlistPath(route.locale, "_");
}

export function playlistStaticId(id: string): string {
  if (!validId(id) || uuid.test(id)) throw new TypeError("Invalid public playlist id");
  return btoa(String.fromCharCode(...new TextEncoder().encode(id))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function playlistStaticLocation(locale: unknown, id: string): { locale: Locale; id: string } | undefined {
  if (!isLocale(locale) || !/^[A-Za-z0-9_-]+$/u.test(id)) return;
  try {
    const binary = atob(id.replaceAll("-", "+").replaceAll("_", "/"));
    const value = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    if (playlistStaticId(value) !== id) return;
    return { locale, id: value };
  } catch { return; }
}
export function playlistStaticDocumentPath(locale: Locale, id: string): string {
  return `/playlist-static/${locale}/${playlistStaticId(id)}.html`;
}
export function playlistStaticLookupPath(pathname: string): string | undefined {
  const match = /^\/playlist-static\/(ja|en|ko|zh-CN|zh-TW)\/([A-Za-z0-9_-]+)\.html$/u.exec(pathname);
  if (!match) return;
  const location = playlistStaticLocation(match[1], match[2]!);
  return location && playlistStaticDocumentPath(location.locale, location.id);
}
export function playlistStaticDocumentFromUrl(url: URL): string | undefined {
  const route = parsePlaylistDocument(url.pathname);
  if (route && !route.edit && !uuid.test(route.id)) return playlistStaticDocumentPath(route.locale, route.id);
  return undefined;
}
