import { isLocale, type Locale } from "@haneoka/i18n";
import { isPublicReleaseServer } from "./temporary-public-routing.ts";

export interface AssetStaticLocation {
  server: "jp" | "intl";
  locale: Locale;
  path: string[];
  selected: string;
}
const safePath = (parts: readonly string[]) =>
  parts.every((part) => part && part !== "." && part !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(part));
export function assetStaticId(parts: readonly string[], selected = ""): string {
  if (!safePath(parts) || /[\u0000-\u001f\u007f]/u.test(selected)) throw new TypeError("Invalid asset document path");
  const bytes = new TextEncoder().encode(JSON.stringify([parts, selected]));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
    .match(/.{1,160}/gu)!
    .join("/");
}
export function assetStaticLocation(server: unknown, locale: unknown, id: string): AssetStaticLocation | undefined {
  if (!isPublicReleaseServer(server) || !isLocale(locale) || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(id)) return;
  try {
    const binary = atob(id.replaceAll("/", "").replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Array.isArray(value[0]) ||
      !value[0].every((part) => typeof part === "string") ||
      typeof value[1] !== "string"
    )
      return;
    if (assetStaticId(value[0], value[1]) !== id) return;
    return { server, locale, path: value[0], selected: value[1] };
  } catch {
    return;
  }
}
export function assetStaticDocumentPath(
  server: string,
  locale: Locale,
  parts: readonly string[],
  selected = "",
): string {
  if (!isPublicReleaseServer(server)) throw new TypeError("Invalid asset document server");
  return `/asset-static/${server}/${locale}/${assetStaticId(parts, selected)}.html`;
}
export function assetStaticLookupPath(pathname: string): string | undefined {
  const match = /^\/asset-static\/(jp|intl)\/(ja|en|ko|zh-CN|zh-TW)\/([A-Za-z0-9_/-]+)\.html$/u.exec(pathname);
  if (!match) return;
  const location = assetStaticLocation(match[1], match[2], match[3]!);
  return location && assetStaticDocumentPath(location.server, location.locale, location.path, location.selected);
}
export function assetStaticDocumentFromUrl(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const canonical = isPublicReleaseServer(parts[0]) && isLocale(parts[1]) && parts[2] === "assets";
  const legacy = isLocale(parts[0]) && parts[1] === "catalog" && parts[2] === "assets";
  if (!canonical && !legacy) return;
  const server = canonical ? parts[0] : url.searchParams.get("server") || "intl";
  const locale = (canonical ? parts[1] : parts[0]) as Locale;
  if (!isPublicReleaseServer(server)) return;
  try {
    const source = parts.slice(3).map(decodeURIComponent);
    const path = source.length ? source : (url.searchParams.get("path") || "").split("/").filter(Boolean);
    return assetStaticDocumentPath(server, locale, path, url.searchParams.get("file") || "");
  } catch {
    return;
  }
}
export function isAssetBrowserDocument(url: URL): boolean {
  return Boolean(assetStaticDocumentFromUrl(url) || assetStaticLookupPath(url.pathname));
}
export function assetPublicDocumentUrl(location: AssetStaticLocation): string {
  const pathname = `/${location.server}/${location.locale}/assets/${location.path.map(encodeURIComponent).join("/")}${location.path.length ? "/" : ""}`;
  return pathname + (location.selected ? `?${new URLSearchParams({ file: location.selected })}` : "");
}
