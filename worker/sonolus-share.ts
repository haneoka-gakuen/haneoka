/**
 * Sonolus share links.
 *
 * The Sonolus app addresses this server as `https://haneoka.org` and calls its
 * API under `/sonolus/...`. Its "Share" action therefore produces browser links
 * of the form `{address}/{type}/{name}` (for example
 * `https://haneoka.org/levels/haneoka-intl-100076-expert`), outside the API
 * prefix. Sonolus servers answer those addresses with a redirect to the
 * official `open.sonolus.com` landing page, which opens the item in the app or
 * offers to install it. This mirrors `SonolusRedirectShare` from
 * `@sonolus/express` so the site's own locale negotiation never claims them.
 */
const SONOLUS_SHARE_ITEM_TYPES = new Set([
  "posts",
  "playlists",
  "levels",
  "skins",
  "backgrounds",
  "effects",
  "particles",
  "engines",
  "replays",
  "rooms",
]);

/** Item names are path segments; reject anything that is not one segment. */
const SONOLUS_SHARE_NAME = /^[^/\s]{1,255}$/u;

/**
 * Returns the `open.sonolus.com` landing URL for a Sonolus share path, or
 * `undefined` when the path is not a share link. `address` is the server
 * address without protocol, e.g. `haneoka.org`.
 */
export function sonolusShareRedirectTarget(pathname: string, search: string, address: string): string | undefined {
  const match = /^\/([a-z]+)(?:\/([^/]+))?\/?$/u.exec(pathname);
  const type = match?.[1];
  if (!type || !SONOLUS_SHARE_ITEM_TYPES.has(type)) return undefined;
  const rawName = match[2];
  if (rawName === undefined) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return undefined;
  }
  if (!SONOLUS_SHARE_NAME.test(name)) return undefined;
  const root = `https://open.sonolus.com/${address}/${type}`;
  if (name === "info") return `${root}/info`;
  if (name === "list") return `${root}/list${search.startsWith("?") && search.length > 1 ? search : ""}`;
  return `${root}/${encodeURIComponent(name)}`;
}
