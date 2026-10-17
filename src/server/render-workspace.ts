// L3 — GEB
// Input: 工作区实例、locale 和文档地址。
// Output: Lit SSR HTML、应用栏状态及静态工作区页面。
// Pos: [Map](L2-2.md)；构建期复用 Lit 工作区的渲染桥。
// Effects/Dependencies: 安装全局 DOM shim，设置国际化／文档上下文并序列化 light DOM。
import "@lit-labs/ssr/lib/install-global-dom-shim.js";
import { render, LitElementRenderer } from "@lit-labs/ssr";
import { createMaterialStyleRenderer } from "./material-ssr-styles";
import { collectResultSync } from "@lit-labs/ssr/lib/render-result.js";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { createServerI18nContext } from "../i18n/server";
import { initializeI18nClient } from "../i18n/client";
import type { Locale } from "../i18n/locales";
import { html } from "lit";
import { captureAppBar } from "../lib/app-bar";
import { withDocumentUrl } from "../lib/document-url";

type Node = DefaultTreeAdapterMap["node"];
const MaterialStyleRenderer = createMaterialStyleRenderer(import.meta.env?.DEV === true);
function materialBooleanProperties(node: Node): void {
  if ("tagName" in node && node.tagName === "input")
    node.attrs = node.attrs.filter((attr) => !(attr.name === "checked" && attr.value === "false"));
  if ("tagName" in node && node.tagName === "template")
    materialBooleanProperties((node as DefaultTreeAdapterMap["template"]).content);
  if ("childNodes" in node) for (const child of node.childNodes) materialBooleanProperties(child);
}
function lightDom(node: Node): void {
  if ("tagName" in node && node.tagName.startsWith("md-")) {
    materialBooleanProperties(node);
    return;
  }
  if ("tagName" in node && node.tagName === "img") {
    const source = node.attrs.find(attr => attr.name === "data-src");
    if (source && !node.attrs.some(attr => attr.name === "src")) node.attrs.push({ name: "src", value: source.value });
    if (source) node.attrs = node.attrs.filter(attr => attr !== source);
    if (!node.attrs.some(attr => attr.name === "loading")) node.attrs.push({ name: "loading", value: "lazy" });
  }
  if (!("childNodes" in node)) return;
  const children = [];
  for (const child of node.childNodes) {
    if (
      "tagName" in child &&
      child.tagName === "template" &&
      child.attrs.some((attr) => attr.name === "shadowrootmode")
    ) {
      const content = (child as DefaultTreeAdapterMap["template"]).content;
      lightDom(content);
      for (const entry of content.childNodes) {
        entry.parentNode = node;
        children.push(entry);
      }
      if ("attrs" in node) node.attrs.push({ name: "data-prerendered", value: "" });
    } else {
      lightDom(child);
      children.push(child);
    }
  }
  node.childNodes = children;
}

type Seed = ReturnType<ReturnType<typeof createServerI18nContext>["seed"]>;
let activeSeed: Seed | undefined;
let activeCatalog: unknown;
export function useStaticLocale(locale: Locale, route: string): Seed {
  const seed = createServerI18nContext(locale, route).seed();
  const client = initializeI18nClient({ seed });
  if (activeSeed !== seed || activeCatalog !== client.current()) {
    client.adoptSeed(seed);
    activeSeed = seed;
    activeCatalog = client.current();
  }
  return seed;
}

export interface StaticWorkspacePage {
  body: string;
  appBar: { actions: string; identity: string; search: string };
}
function markup(value: unknown): string {
  const fragment = parseFragment(collectResultSync(render(value, { deferHydration: true, elementRenderers: [MaterialStyleRenderer, LitElementRenderer] })));
  lightDom(fragment);
  return serialize(fragment);
}
export function renderWorkspacePage(workspace: { render(): unknown; renderStaticChrome?(): void }, locale: Locale, route: string): StaticWorkspacePage {
  useStaticLocale(locale, route);
  return withDocumentUrl(new URL(route, "https://haneoka.org"), () => {
  const { result: body, bar } = captureAppBar(locale, () => {
    workspace.renderStaticChrome?.();
    return markup(workspace.render());
  });
  const kind = (owner: string) => owner.replace(/-\d+$/u, "");
  return { body, appBar: {
    actions: markup([...bar.actions].map(([owner, content]) => html`<div class="top-app-bar__group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`)),
    identity: markup([...bar.identity].map(([owner, content]) => html`<div class="top-app-bar__identity-group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`)),
    search: markup([...bar.search].map(([owner, search]) => html`<div class="top-app-bar__search-group" data-app-bar-search="true" data-app-bar-search-owner=${owner} data-search-expanded=${String(search.expanded)} data-search-input-id=${search.inputId} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${search.content}</div>`)),
  } };
  });
}
export function renderWorkspace(workspace: { render(): unknown; renderStaticChrome?(): void }, locale: Locale, route: string): string {
  return renderWorkspacePage(workspace, locale, route).body;
}
