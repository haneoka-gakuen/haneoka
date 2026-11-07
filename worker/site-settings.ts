import { isPublicReleaseServer as isPublicResourceServer } from "../src/lib/temporary-public-routing";
export { isPublicReleaseServer as isPublicResourceServer } from "../src/lib/temporary-public-routing";
import { withPrimaryD1 } from "./d1-session";
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { USER_ROLES, isUserRole, type UserRole } from "../src/lib/user-roles";
import { WEB_BUILD_ATTRIBUTE } from "../src/lib/web-build-id";
import {
  COMMUNITY_VISIBILITY_ATTRIBUTE,
  communityVisibilityCss,
  communityPagesEnabled,
} from "../src/lib/site-community";
import { providerEntityFromUrl } from "../src/lib/provider-entity-routing";
import { contentUserGroup, readContentVisibility } from "./content-visibility";
import { DEFAULT_VISIBILITY_RULE, VISIBILITY_WORKSPACES, visibilityType } from "../src/lib/content-visibility-policy";
import { contentPublished } from "../src/lib/content-publication";
import { parseHtmlJson } from "../src/lib/html-json";
import { spoilerCookieEnabled } from "../src/lib/spoiler-cookie";
import { parseResourceRoute } from "../src/lib/resource-route";

export type SiteSettings = {
  showRestrictedContent: boolean;
  contentAccessRoles: UserRole[];
  version: number;
  updatedAt: number;
};

/** Read current administrative policy, without a stale per-isolate flag cache. */
export async function readSiteSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.withSession("first-primary")
    .prepare(
      `SELECT show_test_server_content AS enabled, test_content_roles AS roles, version, updated_at AS updatedAt
     FROM site_setting WHERE id = 1`,
    )
    .first<{ enabled: number; roles: string; version: number; updatedAt: number }>();
  let roles: unknown;
  try {
    roles = JSON.parse(row?.roles ?? '["admin"]');
  } catch {
    roles = [];
  }
  return {
    showRestrictedContent: row?.enabled === 1,
    contentAccessRoles: Array.isArray(roles) ? USER_ROLES.filter((role) => roles.includes(role)) : [],
    version: row?.version ?? 1,
    updatedAt: row?.updatedAt ?? 0,
  };
}

/** Only the two public sources can be read without an account grant. */
export function requestedResourceServers(request: Request): string[] {
  const url = new URL(request.url);
  const matches = [
    /^\/(?:assets|runtime|objects|artifacts|game-client|static-views)\/([^/]+)/u.exec(url.pathname),
    /^\/api\/v1\/(?:servers|team-builder(?!\/image\.png$)|meta-reference)\/([^/]+)/u.exec(url.pathname),
    /^\/([^/]*(?:-test|-cbt)[^/]*)\/(?:.*)?$/u.exec(url.pathname),
    /^\/([^/]+)\/(?:ja|en|ko|zh-CN|zh-TW)(?:\/|$)/u.exec(url.pathname),
  ];
  const values = matches.flatMap((match) => (match?.[1] ? [match[1]] : []));
  if (!/^\/api\/v1\/(?:garupa|sekai|bestdori|community)(?:\/|$)/u.test(url.pathname))
    values.push(...url.searchParams.getAll("server"));
  return [
    ...new Set(
      values.map((value) => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }),
    ),
  ];
}
export const restrictedResourceRequest = (request: Request): boolean =>
  requestedResourceServers(request).some((server) => !isPublicResourceServer(server));

export async function contentSourceScope(
  env: Env,
): Promise<{ sources: string[]; sourceFamilies: Record<string, "jp" | "intl"> }> {
  const result = await env.DB.withSession("first-primary")
    .prepare(
      "SELECT slug, region FROM resource_server WHERE status = 'active' AND slug NOT IN ('jp', 'intl') AND slug NOT LIKE '%-cbt' ORDER BY slug",
    )
    .all<{ slug: string; region: string }>();
  return {
    sources: result.results.map((row) => row.slug),
    sourceFamilies: Object.fromEntries(result.results.map((row) => [row.slug, row.region === "jp" ? "jp" : "intl"])),
  };
}

const permissions = new WeakMap<Request, Promise<boolean>>();
export async function testContentAllowed(request: Request, env: Env, settings?: SiteSettings): Promise<boolean> {
  let pending = permissions.get(request);
  if (!pending) {
    pending = withPrimaryD1(env, async (primaryEnv) => {
      if (!request.headers.has("Cookie") && !request.headers.has("Authorization")) return false;
      const policy = settings ?? (await readSiteSettings(primaryEnv));
      if (!policy.showRestrictedContent || !policy.contentAccessRoles.some(isUserRole)) return false;
      const session = await getAuthSession(request, primaryEnv, { authoritative: true });
      if (!session?.user?.id || !session.user.emailVerified) return false;
      const state = await communityAccessState(primaryEnv, session.user.id, ["sign_in"]);
      return state?.status === "active" && !state.restriction && policy.contentAccessRoles.includes(state.role);
    });
    permissions.set(request, pending);
  }
  return pending;
}

export function privateResourceResponse(response: Response): Response {
  const setPolicy = (headers: Headers) => {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Cookie, Authorization, Accept-Encoding");
    headers.delete("Access-Control-Allow-Origin");
  };
  try {
    setPolicy(response.headers);
    return response;
  } catch {
    // Network responses have immutable headers and an already encoded body.
    const headers = new Headers(response.headers);
    setPolicy(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
      encodeBody: headers.has("Content-Encoding") ? "manual" : "automatic",
    });
  }
}

export async function applySiteSettings(
  request: Request,
  response: Response,
  settings: SiteSettings | undefined,
  buildId: string,
  env: Env,
): Promise<Response> {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
  const [visibility, group] = await Promise.all([readContentVisibility(env), contentUserGroup(request, env)]);
  const rules = visibility.policy;
  const preference = spoilerCookieEnabled(request.headers.get("Cookie"));
  const customVisibility = !preference || Object.keys(rules.types).length > 0;
  const resource = parseResourceRoute(new URL(request.url).pathname);
  const kind = resource && visibilityType(resource.kind);
  const rule = kind ? (rules.types[kind] ?? DEFAULT_VISIBILITY_RULE) : undefined;
  const allowed = settings ? await testContentAllowed(request, env, settings) : false;
  const scope = allowed ? await contentSourceScope(env) : undefined;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  const vary = new Set(
    (headers.get("Vary") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  vary.add("Cookie");
  vary.add("Authorization");
  vary.add("Accept-Encoding");
  headers.set("Vary", [...vary].join(", "));
  headers.delete("Content-Length");
  const assetEtag = headers.get("ETag");
  const community = communityPagesEnabled(new URL(request.url).hostname, env.COMMUNITY_HIDDEN_HOSTS);
  const provider = providerEntityFromUrl(new URL(request.url));
  const providerId = provider && provider.resource !== "songs" ? provider.id : undefined;
  const spoilerValue = new URL(request.url).searchParams.get("spoiler");
  const override = Number.isFinite(Number(spoilerValue)) && Number(spoilerValue) !== 0 && (rule?.allowOverride ?? true);
  const spoilers = override || preference;
  let published = true;
  const hideIdentity = () =>
    Boolean(
      !published &&
      !override &&
      resource?.id &&
      rule &&
      (!rule.groups.includes(group) ||
        rule.hide.includes(resource.id) ||
        (!rule.show.includes(resource.id) && rule.mode === "spoiler" && !preference)),
    );
  const etag = assetEtag?.replace(
    /"$/u,
    `${providerId ? `:entity-${encodeURIComponent(providerId)}` : ""}:web-${buildId}:canonical-org:visibility-v4-${visibility.version}-${group}:spoilers-${spoilers ? 1 : 0}:community-${community ? 1 : 0}${settings ? `:site-${settings.version}:access-${allowed ? 1 : 0}` : ""}"`,
  );
  if (etag) {
    headers.set("ETag", etag);
    if (request.headers.get("If-None-Match") === etag) {
      await response.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
  }
  const output = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (request.method === "HEAD") {
    await output.body?.cancel();
    return new Response(null, { status: output.status, headers });
  }
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute(WEB_BUILD_ATTRIBUTE, buildId);
        element.setAttribute(COMMUNITY_VISIBILITY_ATTRIBUTE, community ? "1" : "0");
        element.removeAttribute("data-show-test-server-content");
        element.setAttribute("data-content-access", allowed ? "1" : "0");
        if (scope) {
          element.setAttribute("data-content-sources", JSON.stringify(scope.sources));
          element.setAttribute("data-content-source-families", JSON.stringify(scope.sourceFamilies));
        } else {
          element.removeAttribute("data-content-sources");
          element.removeAttribute("data-content-source-families");
        }
        if (settings) element.setAttribute("data-site-settings-version", String(settings.version));
        else element.removeAttribute("data-site-settings-version");
        element.setAttribute("data-spoiler-content", spoilers ? "1" : "0");
        element.setAttribute("data-content-visibility-policy", JSON.stringify(visibility.policy));
        element.setAttribute("data-content-visibility-version", String(visibility.version));
        element.setAttribute("data-content-group", group);
      },
    })
    .on("head", {
      element(element) {
        element.append(
          `<style data-community-visibility>${communityVisibilityCss(new URL(request.url).origin)}</style>`,
          { html: true },
        );
      },
    })
    .on(VISIBILITY_WORKSPACES.map((tag) => `${tag}[data-prerendered]`).join(", "), {
      element(element) {
        if (customVisibility) element.removeAttribute("data-prerendered");
      },
    })
    .on(VISIBILITY_WORKSPACES.map((tag) => `${tag} > *`).join(", "), {
      element(element) {
        if (customVisibility && element.tagName !== "script") element.remove();
      },
    })
    .on("home-dashboard[data-prerendered]", {
      element(element) {
        if (customVisibility) element.removeAttribute("data-prerendered");
      },
    })
    .on("home-dashboard > *", {
      element(element) {
        if (customVisibility && element.tagName !== "script") element.remove();
      },
    })
    .on('meta[name="haneoka-content-publication"]', {
      element(element) {
        const value = element.getAttribute("content");
        if (value) published = contentPublished(parseHtmlJson(value));
      },
    })
    .on("h1", {
      element(element) {
        if (hideIdentity()) element.setInnerContent("");
      },
    })
    .on("[data-app-bar-static]", {
      element(element) {
        if (hideIdentity()) element.remove();
      },
    })
    .on("title", {
      element(element) {
        if (hideIdentity()) element.setInnerContent("haneoka");
      },
    })
    .on("story-workspace[data-provider-entity-shell]", {
      element(element) {
        if (providerId) element.setAttribute("entity-id", providerId);
      },
    })
    .transform(output);
}
