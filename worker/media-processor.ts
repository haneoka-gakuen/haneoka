// L3 — GEB
// Input: Media job requests from the community upload queue and screenshot recognition.
// Output: The same requests answered by the media service on the collector host.
// Pos: [Map](L2.md); the Worker's way to the self-hosted media service.
// Effects/Dependencies: HTTPS to COMMUNITY_MEDIA_ORIGIN with COMMUNITY_MEDIA_TOKEN; streams request and response bodies.

export interface MediaProcessor {
  fetch(request: Request): Promise<Response>;
}

/** The media service, or `null` when it is not configured. */
export function mediaProcessor(env: { COMMUNITY_MEDIA_ORIGIN?: string; COMMUNITY_MEDIA_TOKEN?: string }): MediaProcessor | null {
  const origin = env.COMMUNITY_MEDIA_ORIGIN, token = env.COMMUNITY_MEDIA_TOKEN;
  if (!origin || !token || token.length < 32) return null;
  return {
    fetch(request: Request) {
      const source = new URL(request.url);
      const forwarded = new Request(new URL(source.pathname + source.search, origin), request);
      forwarded.headers.set("Authorization", `Bearer ${token}`);
      return fetch(forwarded, { redirect: "manual" });
    },
  };
}
