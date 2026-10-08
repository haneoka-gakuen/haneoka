import { DEFAULT_LOCALE, isLocale } from "@haneoka/i18n";
import { navigationDocumentUrl } from "./document-url";
import { homePath, isReleaseServer, releaseServerFromPath, type ReleaseServer } from "./resource-route";
import { formalServerForHidden, PUBLIC_RELEASE_SERVERS, temporaryPublicRedirectTarget } from "./temporary-public-routing";
import { isTestContentServer, showTestServerContent } from "./test-server-visibility";
export { isReleaseServer, releaseServerFromPath, type ReleaseServer } from "./resource-route";
export { isPublicReleaseServer } from "./temporary-public-routing";
export const RELEASE_SERVERS: readonly ReleaseServer[] = PUBLIC_RELEASE_SERVERS;
const KEY = "haneoka.release-server";

export function normalizeReleaseServer(value: unknown): ReleaseServer {
  const current = value === "gl-cbt" ? "intl-cbt" : value;
  if (typeof current === "string" && isTestContentServer(current)) return "intl";
  return formalServerForHidden(current) ?? (isReleaseServer(current) ? current : "intl");
}

/** The global selection always points at a formal server, including on preview details. */
export function readSelectedReleaseServer(): ReleaseServer {
  const routeServer =
    typeof location === "undefined" ? undefined : releaseServerFromPath(navigationDocumentUrl().pathname);
  if (routeServer) return writeReleaseServer(routeServer);
  try {
    const queryServer =
      typeof location === "undefined" ? undefined : navigationDocumentUrl().searchParams.get("server");
    if (isReleaseServer(queryServer) || queryServer === "gl-cbt") return writeReleaseServer(queryServer);
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

/** A preview detail keeps its own data source without becoming a global selection. */
export function readReleaseServer(): ReleaseServer {
  const source = typeof location === "undefined" ? undefined : releaseServerFromPath(navigationDocumentUrl().pathname);
  const selected = readSelectedReleaseServer();
  return source === "intl-test" && showTestServerContent() ? source : selected;
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
  const sourceSearch = query.toString();
  query.delete("server");
  const search = query.size ? `?${query}` : "";
  const redirected = temporaryPublicRedirectTarget(path, sourceSearch, hash);
  if (redirected) {
    const target = new URL(redirected, "https://route.invalid");
    const safeParts = target.pathname.split("/").filter(Boolean);
    if (isReleaseServer(safeParts[0])) safeParts[0] = server;
    return `/${safeParts.join("/")}/${target.search}${target.hash}`;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 0 && isReleaseServer(parts[0])) {
    return `/${[server, ...parts.slice(1)].join("/")}/${search}${hash}`;
  }
  const locale = parts.length > 0 && isLocale(parts[0]) ? parts[0] : DEFAULT_LOCALE;
  return `${homePath(server, locale)}${search}${hash}`;
}
