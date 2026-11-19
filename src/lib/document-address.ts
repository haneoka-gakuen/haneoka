// L3 — GEB
// Input: A document URL and its query parameters.
// Output: The same address with obsolete publication selectors removed.
// Pos: [Map](L2-2.md); shared browser, Worker and build-time document addresses.
// Effects/Dependencies: Mutates only the supplied URL; independent of publication lookups.
const NON_DOCUMENT_ROOT = /^\/(?:api|auth|artifacts|asset-static|assets|catalog\/assets|downloads|embed|entity-data|game-client|objects|pagefind|playlist-static|provider-static|public-media|runtime|sonolus|stamp-maker-fonts|static-views)(?:\/|$)/u;
const PUBLICATION_PARAMETERS = [
  "release", "releaseId", "release-id", "release_id",
  "build", "buildId", "build-id", "build_id",
  "importRelease", "importSource",
];

export function stripDocumentVersion(url: URL): boolean {
  if (!/(?:release|build|importSource|%)/iu.test(url.search) || NON_DOCUMENT_ROOT.test(url.pathname)) return false;
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
