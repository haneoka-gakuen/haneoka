import "@lit-labs/ssr/lib/install-global-dom-shim.js";
import { render } from "@lit-labs/ssr";
import { collectResultSync } from "@lit-labs/ssr/lib/render-result.js";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { HomeDashboard, type HomeSeed } from "../lit/home-dashboard";
import { localizedAssetUrl } from "../lit/ui/lazy-images";
import { createServerI18nContext } from "../i18n/server";
import { initializeI18nClient } from "../i18n/client";
import type { Locale } from "../i18n/locales";
import type { ReleaseServer } from "../lib/release-server";
import { homePageData } from "./home-page-data";

const snapshots = new Map<string, Promise<HomeSeed>>();

export async function renderHome(server: ReleaseServer, locale: Locale) {
  const key = `${server}:${locale}`;
  let pending = snapshots.get(key);
  if (!pending) {
    pending = homePageData(server, locale);
    snapshots.set(key, pending);
  }
  let seed: HomeSeed | undefined;
  try {
    seed = await pending;
  } catch (error) {
    console.warn(`Home snapshot unavailable for ${server}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const i18nSeed = createServerI18nContext(locale, "/").seed();
  initializeI18nClient({ seed: i18nSeed }).adoptSeed(i18nSeed);
  const dashboard = new HomeDashboard();
  dashboard.locale = locale;
  dashboard.server = server;
  if (seed) dashboard.prepareHome(seed, locale);
  const fragment = parseFragment(collectResultSync(render(dashboard.render())));
  const promote = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "img") {
      const source = node.attrs.find((attribute) => attribute.name === "data-src");
      if (source && !node.attrs.some((attribute) => attribute.name === "src")) {
        // The client's lazy loader asks for the locale-tagged variant first;
        // prerender the same URL so hydration reuses the request.
        node.attrs.push({ name: "src", value: localizedAssetUrl(source.value, locale) });
        if (!node.attrs.some((attribute) => attribute.name === "loading"))
          node.attrs.push({ name: "loading", value: "lazy" });
      }
      // SSR has a real source: deferred-media CSS must not wait for client load hooks.
      if (node.attrs.some((attribute) => attribute.name === "src" && attribute.value))
        node.attrs = node.attrs.filter((attribute) => !["data-src", "data-loading"].includes(attribute.name));
    }
    if ("childNodes" in node) for (const child of node.childNodes) promote(child);
  };
  promote(fragment);
  return {
    html: serialize(fragment),
    seed: seed ? JSON.stringify(seed).replace(/</gu, "\\u003c") : "",
  };
}
