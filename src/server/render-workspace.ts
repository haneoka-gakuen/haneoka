// L3 — GEB
// Input: 工作区实例、locale 和文档地址。
// Output: Lit SSR HTML、受控的图鉴预览及应用栏状态。
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
import { appBarOwnerKind as kind, captureAppBar } from "../lib/app-bar";
import { unpublishedState } from "../lit/ui/unpublished-state";
import { withPrerenderView } from "../lib/content-prerender";
import { withDocumentUrl } from "../lib/document-url";
import { staticContentMarkup, staticPreview, staticVisibilityTime } from "./static-visibility";
import type { ContentReference } from "../lib/content-view";

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
type Workspace = { render(): unknown; renderStaticChrome?(): void };
type Preview = { value: Workspace; version: number; next?: number };

export function renderCatalogueCollection<T>(
  payload: T,
  resource: string,
  locale: Locale,
  route: string,
  create: (data: T) => Workspace,
): StaticWorkspacePage {
  return renderWorkspacePage(create(payload), locale, route, (refs) => {
    const preview = staticPreview(payload, resource, refs);
    return preview && { ...preview, value: create(preview.value) };
  });
}

function markup(value: unknown): string {
  const fragment = parseFragment(collectResultSync(render(value, { deferHydration: true, elementRenderers: [MaterialStyleRenderer, LitElementRenderer] })));
  lightDom(fragment);
  return serialize(fragment);
}
export function renderWorkspacePage(workspace: Workspace, locale: Locale, route: string, previewFor?: (refs: ContentReference[]) => Preview | undefined): StaticWorkspacePage {
  useStaticLocale(locale, route);
  const now = staticVisibilityTime();
  return withDocumentUrl(new URL(route, "https://haneoka.org"), () => {
  const { result: body, bar } = captureAppBar(locale, () => {
    workspace.renderStaticChrome?.();
    return withPrerenderView(false, () => markup(workspace.render()), now);
  });
  const { result: publicBody, bar: publicBar } = captureAppBar(locale, () =>
    withPrerenderView(true, () => {
      workspace.renderStaticChrome?.();
      return markup(workspace.render());
    }, now).result);
  const preview = previewFor?.(body.references);
  const rendered = staticContentMarkup(body, publicBody, preview && {
    ...preview,
    value: captureAppBar(locale, () => withPrerenderView(true, () => markup(preview.value.render()), now, true).result).result,
  });
  const view = (full: string, published: string) => full === published ? full
    : staticContentMarkup({ result: full, references: body.references }, published);
  return { body: rendered, appBar: {
    actions: view(markup([...bar.actions].map(([owner, content]) => html`<div class="top-app-bar__group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`)), markup([...publicBar.actions].map(([owner, content]) => html`<div class="top-app-bar__group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`))),
    identity: view(markup([...bar.identity].map(([owner, content]) => html`<div class="top-app-bar__identity-group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`)), markup([...publicBar.identity].map(([owner, content]) => html`<div class="top-app-bar__identity-group" data-app-bar-owner=${owner} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${content}</div>`))),
    search: view(markup([...bar.search].map(([owner, search]) => html`<div class="top-app-bar__search-group" data-app-bar-search="true" data-app-bar-search-owner=${owner} data-search-expanded=${String(search.expanded)} data-search-input-id=${search.inputId} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${search.content}</div>`)), markup([...publicBar.search].map(([owner, search]) => html`<div class="top-app-bar__search-group" data-app-bar-search="true" data-app-bar-search-owner=${owner} data-search-expanded=${String(search.expanded)} data-search-input-id=${search.inputId} data-app-bar-static data-app-bar-owner-kind=${kind(owner)}>${search.content}</div>`))),
  } };
  });
}
export function renderWorkspace(workspace: { render(): unknown; renderStaticChrome?(): void }, locale: Locale, route: string): string {
  return renderWorkspacePage(workspace, locale, route).body;
}

const unavailableMarkup = new Map<Locale, string>();
export function renderUnavailableContent(locale: Locale): string {
  let body = unavailableMarkup.get(locale);
  if (!body) { useStaticLocale(locale, "/"); body = markup(unpublishedState(locale)); unavailableMarkup.set(locale, body); }
  return body;
}
