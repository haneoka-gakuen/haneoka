// L3 — GEB
// Input: Resource request and current account and display policy.
// Output: Shared visibility decision and a cache identity for equivalent views.
// Pos: [Map](L2.md); request boundary for published and restricted resources.
// Effects/Dependencies: Reads account authorization and the current D1 policy; never caches credentials.
import { contentUserGroup, readContentVisibility } from "./content-visibility";
import { authenticate } from "./account-api-tokens";
import { spoilerCookieEnabled } from "../src/lib/spoiler-cookie";
import { explicitContentOverride, type ContentView } from "../src/lib/content-view";
import type { ContentVisibilitySettings } from "../src/lib/content-visibility-policy";

export interface RequestContentView extends ContentView {
  settings: ContentVisibilitySettings;
  key: string;
}
const requests = new WeakMap<Request, Promise<RequestContentView>>();
export function requestContentView(request: Request, env: Env): Promise<RequestContentView> {
  let pending = requests.get(request);
  if (!pending) {
    pending = (async () => {
      const [settings, group] = await Promise.all([
        readContentVisibility(env),
        /^Bearer hnk_/u.test(request.headers.get("Authorization") || "")
          ? authenticate(request, env, "resources:read").then(async (owner) => {
              if (owner instanceof Response) throw owner;
              return owner.group;
            })
          : contentUserGroup(request, env),
      ]);
      const spoilers = spoilerCookieEnabled(request.headers.get("Cookie"));
      const override = explicitContentOverride(new URL(request.url));
      return {
        settings,
        policy: settings.policy,
        group,
        spoilers,
        override,
        now: Date.now(),
        key: `view-v1-${settings.version}-${group}-${Number(spoilers)}-${Number(override)}`,
      };
    })();
    requests.set(request, pending);
  }
  return pending;
}
export function inheritContentView(target: Request, source: Request): void {
  const view = requests.get(source);
  if (view) requests.set(target, view);
}
export function privateContentResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  headers.set("Vary", "Cookie, Authorization, Accept-Encoding");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: headers.has("Content-Encoding") ? "manual" : "automatic",
  });
}

export async function isContentBuildRequest(request: Request, env: Env): Promise<boolean> {
  const value = request.headers.get("x-haneoka-build-token");
  if (!value || !env.CONTENT_BUILD_TOKEN) return false;
  const hashes = await Promise.all(
    [value, env.CONTENT_BUILD_TOKEN].map(
      async (token) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    ),
  );
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= hashes[0]![index]! ^ hashes[1]![index]!;
  return difference === 0;
}
