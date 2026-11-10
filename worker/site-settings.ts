import { isPublicReleaseServer as isPublicResourceServer } from "../src/lib/temporary-public-routing";
export { isPublicReleaseServer as isPublicResourceServer } from "../src/lib/temporary-public-routing";
import { WEB_BUILD_ATTRIBUTE } from "../src/lib/web-build-id";
import {
  COMMUNITY_VISIBILITY_ATTRIBUTE,
  communityVisibilityCss,
  communityPagesEnabled,
} from "../src/lib/site-community";
import { providerEntityFromUrl } from "../src/lib/provider-entity-routing";
import { requestContentView } from "./content-view";
import { contentVisible, filterContentData, type ContentReference } from "../src/lib/content-view";
import { decodePageData } from "../src/lib/page-data-codec";
import { unrestricted } from "./content-resources";
import { visibilityType } from "../src/lib/content-visibility-policy";
import { contentPublished } from "../src/lib/content-publication";
import { parseHtmlJson } from "../src/lib/html-json";
import { parseResourceRoute } from "../src/lib/resource-route";

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

export interface DocumentContentContext {
  epoch?: string;
  publication?: Record<string, unknown>;
  publications?: Record<string, Record<string, unknown>>;
  unavailable?: boolean;
}
export async function applySiteSettings(
  request: Request,
  response: Response,
  buildId: string,
  env: Env,
  context: DocumentContentContext = {},
): Promise<Response> {
  const visibilityEpoch = context.epoch ?? String(Math.floor(Date.now() / 60_000));
  const currentPublication = context.publication;
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
  const view = await requestContentView(request, env);
  const { settings: visibility, group } = view;
  let resource = parseResourceRoute(new URL(request.url).pathname);
  let kind = resource && visibilityType(resource.kind);
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
  const spoilers = view.override || view.spoilers;
  const completeView = unrestricted(view);
  let usePublicView = false;
  let detailPublication: Record<string, unknown> = currentPublication ?? {};
  let placeholder = "",
    unavailableTitle = "";
  let blockedJson = false;
  let jsonText = "";
  let jsonId = "";
  const hideIdentity = () =>
    Boolean(
      context.unavailable || (resource?.id && kind && !contentVisible(view, kind, detailPublication, resource.id)),
    );
  const etag = assetEtag?.replace(
    /"$/u,
    `${providerId ? `:entity-${encodeURIComponent(providerId)}` : ""}:web-${buildId}:canonical-self-v1:${view.key}:content-${visibilityEpoch}:community-${community ? 1 : 0}"`,
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
    .on('meta[name="haneoka-content-route"]', {
      element(element) {
        if (!resource?.id) {
          resource = parseResourceRoute(element.getAttribute("content") || "");
          kind = resource && visibilityType(resource.kind);
        }
        element.remove();
      },
    })
    .on('meta[name="haneoka-content-placeholder"]', {
      element(element) {
        placeholder = parseHtmlJson<string>(element.getAttribute("content") || '""');
        unavailableTitle = parseHtmlJson<string>(element.getAttribute("data-title") || '""');
        element.remove();
      },
    })
    .on('meta[name="robots"]', {
      element(element) {
        if (
          hideIdentity() ||
          (element.hasAttribute("data-content-index") && !contentPublished(detailPublication, view.now))
        )
          element.setAttribute("content", "noindex, follow");
        element.removeAttribute("data-content-index");
      },
    })
    .on("main#main-content", {
      element(element) {
        if (hideIdentity()) {
          element.setAttribute("data-content-unavailable", "");
          if (placeholder) element.setInnerContent(placeholder, { html: true });
        }
      },
    })
    .on("[data-content-view]", {
      element(element) {
        const full = element.getAttribute("data-content-view") === "full";
        if (full) {
          const refs = parseHtmlJson<ContentReference[]>(element.getAttribute("data-content-references") || "[]");
          if (
            refs.some(
              (ref) =>
                !contentVisible(
                  view,
                  ref.kind,
                  context.publications?.[`${ref.kind}:${ref.id}`] ?? ref.publication,
                  ref.id,
                ),
            )
          )
            usePublicView = true;
        }
        if (full === usePublicView) element.remove();
        else element.removeAndKeepContent();
      },
    })
    .on('script[type="application/json"]:not(#haneoka-i18n-seed)', {
      element(element) {
        jsonText = "";
        jsonId = element.getAttribute("id") || "";
        blockedJson = hideIdentity() && jsonId !== "haneoka-birthdays";
        if (blockedJson) element.remove();
      },
      text(chunk) {
        if (blockedJson) {
          chunk.remove();
          return;
        }
        if (completeView) return;
        jsonText += chunk.text;
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        const input = decodePageData(JSON.parse(jsonText));
        const filtered = filterContentData(input, view, resource?.kind, true, context.publications);
        if (filtered.changed) usePublicView = true;
        chunk.replace(filtered.changed
          ? JSON.stringify(filtered.value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029")
          : jsonText, { html: true });
        jsonText = "";
      },
    })
    .on(
      'script[type="application/ld+json"], meta[name="description"], meta[name="keywords"], meta[property^="og:"], meta[name^="twitter:"], meta[data-pagefind-meta]',
      {
        element(element) {
          if (hideIdentity()) element.remove();
        },
      },
    )
    .on("html", {
      element(element) {
        element.setAttribute(WEB_BUILD_ATTRIBUTE, buildId);
        element.setAttribute(COMMUNITY_VISIBILITY_ATTRIBUTE, community ? "1" : "0");
        element.removeAttribute("data-show-test-server-content");
        for (const attribute of [
          "data-content-access",
          "data-content-sources",
          "data-content-source-families",
          "data-site-settings-version",
        ])
          element.removeAttribute(attribute);
        element.setAttribute("data-spoiler-content", spoilers ? "1" : "0");
        element.setAttribute("data-content-visibility-policy", JSON.stringify(visibility.policy));
        element.setAttribute("data-content-visibility-version", String(visibility.version));
        element.setAttribute("data-content-visibility-at", String(Date.now()));
        element.setAttribute("data-content-group", group);
        element.setAttribute("data-content-response-key", view.key);
      },
    })
    .on("img[src], audio[src], video[src], source[src], video[poster], a[href]", {
      element(element) {
        const attribute = element.tagName === "a" ? "href" : element.hasAttribute("poster") ? "poster" : "src";
        const source = element.getAttribute(attribute);
        if (!source) return;
        const target = new URL(source, request.url);
        if (target.origin !== new URL(request.url).origin) return;
        const kind = /^\/api\/v1\/([^/]+)/u.exec(target.pathname)?.[1];
        if (
          !/^\/(?:assets|runtime|objects|downloads\/stories|api\/v1\/(?:servers|team-builder|meta-reference))(?:\/|$)/u.test(
            target.pathname,
          ) &&
          !(kind && visibilityType(kind))
        )
          return;
        target.searchParams.set("__content", "1");
        if (view.override && !target.searchParams.has("spoiler"))
          target.searchParams.set("spoiler", new URL(request.url).searchParams.get("spoiler")!);
        element.setAttribute(attribute, target.pathname + target.search + target.hash);
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
    .on('meta[name="haneoka-content-publication"]', {
      element(element) {
        const value = element.getAttribute("content");
        if (value && !currentPublication) {
          detailPublication = parseHtmlJson(value);
        }
      },
    })
    .on("[data-entity-navigation]", {
      element(element) {
        const label = element.getAttribute("aria-label");
        if (label) element.setAttribute("aria-label", label.split(":")[0]!);
      },
    })
    .on("h1", {
      element(element) {
        if (hideIdentity()) element.setInnerContent(unavailableTitle);
      },
    })
    .on("[data-app-bar-static]", {
      element(element) {
        if (hideIdentity() || usePublicView) element.remove();
      },
    })
    .on("title", {
      element(element) {
        if (hideIdentity()) element.setInnerContent(`${unavailableTitle} / haneoka`);
      },
    })
    .on("story-workspace[data-provider-entity-shell]", {
      element(element) {
        if (providerId) element.setAttribute("entity-id", providerId);
      },
    })
    .transform(output);
}
