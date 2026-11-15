import { DEFAULT_LOCALE, isLocale } from "@haneoka/i18n";
import { navigationDocumentUrl } from "./document-url";
import { homePath, isReleaseServer, releaseServerFromPath, releaseServerFromCookie, RELEASE_SERVER_COOKIE, type ReleaseServer } from "./resource-route";
import { PUBLIC_RELEASE_SERVERS } from "./temporary-public-routing";
export { isReleaseServer, releaseServerFromPath, type ReleaseServer } from "./resource-route";
export { isPublicReleaseServer } from "./temporary-public-routing";
export const RELEASE_SERVERS: readonly ReleaseServer[] = PUBLIC_RELEASE_SERVERS;
const KEY = RELEASE_SERVER_COOKIE;
let synchronizedServer: ReleaseServer | undefined;

function savedServerCookie(): ReleaseServer | undefined {
  try { return import.meta.env?.SSR || typeof document === "undefined" ? undefined : releaseServerFromCookie(document.cookie); }
  catch { return undefined; }
}

function syncServerCookie(server: ReleaseServer): void {
  if (import.meta.env?.SSR || typeof document === "undefined" || synchronizedServer === server) return;
  try {
    if (releaseServerFromCookie(document.cookie) !== server)
      document.cookie = `${RELEASE_SERVER_COOKIE}=${server}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    synchronizedServer = server;
  } catch {}
}

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
    const current = normalizeReleaseServer(stored ?? synchronizedServer ?? savedServerCookie());
    if (stored && stored !== current) localStorage.setItem(KEY, current);
    syncServerCookie(current);
    return current;
  } catch {
    const current = synchronizedServer ?? savedServerCookie() ?? "intl";
    syncServerCookie(current);
    return current;
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
  syncServerCookie(server);
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
