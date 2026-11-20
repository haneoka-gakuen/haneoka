// L3 — GEB
// Input: A document URL or a media link presented to the visitor.
// Output: A document address without publication selectors or a bare first-party media path.
// Pos: [Map](L2-2.md); shared browser, Worker and build-time document addresses.
// Effects/Dependencies: Uses the site-origin contract; independent of publication lookups.
import { CANONICAL_ORIGIN, isSiteOrigin, siteOrigin } from "./site-origin.ts";

const NON_DOCUMENT_ROOT = /^\/(?:api|auth|artifacts|asset-static|assets|catalog\/assets|downloads|embed|entity-data|game-client|objects|pagefind|playlist-static|provider-static|public-media|runtime|sonolus|stamp-maker-fonts|static-views)(?:\/|$)/u;
const MEDIA_PATH = /^\/(?:assets|runtime|objects)\/(?:jp|intl)\/.+/u;
const PUBLICATION_PARAMETERS = [
  "release", "releaseId", "release-id", "release_id",
  "build", "buildId", "build-id", "build_id",
  "sourceId", "source-id", "source_id",
  "importRelease", "importSource",
];

export function stripDocumentVersion(url: URL): boolean {
  if (!/(?:release|build|source|%)/iu.test(url.search) || NON_DOCUMENT_ROOT.test(url.pathname)) return false;
  if (/\.[a-z0-9]+$/iu.test(url.pathname) && !/\.(?:html|md)$/iu.test(url.pathname)) return false;
  const query = url.searchParams;
  let changed = false;
  for (const key of PUBLICATION_PARAMETERS) {
    if (!query.has(key)) continue;
    query.delete(key);
    changed = true;
  }
  return changed;
}

export function publicMediaPath(source: string): string | undefined {
  if (MEDIA_PATH.test(source)) {
    const suffix = source.search(/[?#]/u);
    return suffix < 0 ? source : source.slice(0, suffix);
  }
  if (!/^(?:https?:)?\/\//iu.test(source)) return;
  try {
    const url = new URL(source, CANONICAL_ORIGIN);
    if (MEDIA_PATH.test(url.pathname) && (isSiteOrigin(url.origin) || url.origin === siteOrigin()))
      return url.pathname;
  } catch {}
  return undefined;
}

export function publicMediaAddress(source: string): string {
  return publicMediaPath(source) ?? source;
}
