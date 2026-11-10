// L3 — GEB
// Input: Resource request paths and a declared client identity.
// Output: Denial for a disallowed automation client.
// Pos: [Map](L2.md); early resource-client restriction before caches and storage.
// Effects/Dependencies: No I/O or credential state.
export function rejectedResourceClient(request: Request): boolean {
  return (
    /^ournotes-auto\//iu.test(request.headers.get("User-Agent") || "") &&
    /^\/(?:api\/v1\/(?:servers|team-builder|meta-reference|search|live2d|spine)|assets|runtime|objects|artifacts|game-client|sonolus|downloads\/stories)(?:\/|$)/u.test(
      new URL(request.url).pathname,
    )
  );
}
