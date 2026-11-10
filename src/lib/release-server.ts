import { DEFAULT_LOCALE, isLocale } from "@haneoka/i18n";
import { navigationDocumentUrl } from "./document-url";
import { homePath, isReleaseServer, releaseServerFromPath, type ReleaseServer } from "./resource-route";
import { PUBLIC_RELEASE_SERVERS } from "./temporary-public-routing";
export { isReleaseServer, releaseServerFromPath, type ReleaseServer } from "./resource-route";
export { isPublicReleaseServer } from "./temporary-public-routing";
export const RELEASE_SERVERS: readonly ReleaseServer[] = PUBLIC_RELEASE_SERVERS;
const KEY = "haneoka.release-server";

export function normalizeReleaseServer(value: unknown): ReleaseServer {
  return value === "jp" ? "jp" : "intl";
}

/** The global selection stays formal while an entity keeps its own source. */
export function readSelectedReleaseServer(): ReleaseServer {
  const routeServer =
    typeof location === "undefined" ? undefined : releaseServerFromPath(navigationDocumentUrl().pathname);
  if (routeServer) return writeReleaseServer(routeServer);
  try {
    const queryServer =
      typeof location === "undefined" ? undefined : navigationDocumentUrl().searchParams.get("server");
    if (isReleaseServer(queryServer)) return writeReleaseServer(queryServer);
  } catch {}
  try {
    const stored = localStorage.getItem(KEY);
    const current = normalizeReleaseServer(stored);
    if (stored && stored !== current) localStorage.setItem(KEY, current);
    return current;
  } catch {
    return "intl";
  }
}

/** An entity keeps its own data source without becoming a global selection. */
export function readReleaseServer(): ReleaseServer {
  return readSelectedReleaseServer();
}

export function writeReleaseServer(value: unknown): ReleaseServer {
  const server = normalizeReleaseServer(value);
  try {
    localStorage.setItem(KEY, server);
  } catch {}
  return server;
}

/**
 * The URL prefix is the release server's address, so a change of server is a
 * change of page: rewrite the addressed server while retaining the rest of the
 * address. Pages without a server prefix (settings, legal, …) have no
 * per-server copy; their switch lands on the new server's home.
 */
export function releaseServerPath(route: string, server: ReleaseServer): string {
  if (!isReleaseServer(server)) throw new TypeError("Invalid release server");
  server = normalizeReleaseServer(server);
  const path = route.split(/[?#]/u, 1)[0] || "/";
  const suffix = route.slice(path.length);
  const hash = suffix.includes("#") ? suffix.slice(suffix.indexOf("#")) : "";
  const query = new URLSearchParams(suffix.slice(0, suffix.length - hash.length).replace(/^\?/u, ""));
  query.delete("server");
  const search = query.size ? `?${query}` : "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 0 && isReleaseServer(parts[0])) {
    return `/${[server, ...parts.slice(1)].join("/")}/${search}${hash}`;
  }
  const locale = parts.length > 0 && isLocale(parts[0]) ? parts[0] : DEFAULT_LOCALE;
  return `${homePath(server, locale)}${search}${hash}`;
}
