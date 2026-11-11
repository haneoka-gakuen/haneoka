import { currentContentGroup, visibilityPolicyKey } from "./content-policy-browser";
import { showUnreleasedContent } from "./content-release";
import { spoilerContentEnabled } from "./spoiler-content";
import { decodePageData } from "./page-data-codec";
export { decodePageData, serializePageData } from "./page-data-codec";

const parsedPages = new WeakMap<Element, Map<string, { scope: string; value: unknown }>>();
const externalReads = new Map<string, Promise<string | undefined>>();
const externalOwners = new WeakSet<Element>();
function externalPageText(source: string): Promise<string | undefined> {
  let pending = externalReads.get(source);
  if (!pending) {
    pending = fetch(source, { cache: "force-cache" })
      .then((response) => response.ok ? response.text() : undefined)
      .catch(() => undefined)
      .finally(() => externalReads.delete(source));
    externalReads.set(source, pending);
  }
  return pending;
}
type Owner = HTMLElement & { adoptPageData?: () => boolean | void | Promise<boolean | void> };
const OWNERS = "main#main-content [data-page-data]";
const SEED_ATTRIBUTES = ["data-page-data", "data-view-data", "data-collection-data"] as const;
const displayAttribute = (name: string): boolean => name.startsWith("data-content-") || name === "data-spoiler-content" || name === "data-web-build-id";

/** Public pages with a private payload let the full data replace the public seed before it is fetched. */
function privatePreparation(document: Document): Promise<unknown> {
  const content = document.head?.querySelector('meta[name="haneoka-public-static"]')?.getAttribute("content");
  try {
    if (!content) return Promise.resolve();
    const descriptor = JSON.parse(content) as { private?: unknown; functional?: unknown };
    if (descriptor.private !== true && descriptor.functional !== true) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  return import("./public-static-browser").then((view) => view.preparePageData()).catch(() => undefined);
}

export function waitForPageData(owner: HTMLElement, connect: () => void): boolean {
  const id = owner.getAttribute("data-page-data");
  const document = owner.ownerDocument;
  if (!id || !document.getElementById(id)?.getAttribute("data-src")) return false;
  if (externalOwners.has(owner)) return true;
  externalOwners.add(owner);
  owner.inert = true;
  void privatePreparation(document).then(async () => {
    const seed = document.getElementById(id);
    const source = seed?.getAttribute("data-src");
    if (seed && source) {
      const text = await externalPageText(source);
      // Full data installed while the public file loaded takes precedence.
      if (seed.getAttribute("data-src") === source) {
        if (text !== undefined) seed.textContent = text;
        seed.removeAttribute("data-src");
      }
    }
    externalOwners.delete(owner);
    owner.inert = false;
    if (owner.isConnected) connect();
  });
  return true;
}

/** Replaces the root display attributes with those of the view the page data belongs to. */
export function applyDisplayAttributes(attributes: Iterable<readonly [string, string]>): void {
  const root = document.documentElement;
  for (const attribute of [...root.attributes]) if (displayAttribute(attribute.name)) root.removeAttribute(attribute.name);
  for (const [name, value] of attributes) if (displayAttribute(name)) root.setAttribute(name, value);
}
const attributesOf = (element: Element): [string, string][] =>
  [...element.attributes].map((attribute) => [attribute.name, attribute.value]);

/**
 * Writes the seeds of `next` into the current document when no owner has read
 * its page data yet, so owners hydrate once with it. False when one already has.
 */
export function installPageData(next: Document): boolean {
  const owners = [...document.querySelectorAll<Owner>(OWNERS)];
  if (!owners.length || owners.some((owner) => parsedPages.has(owner))) return false;
  const seeds: [HTMLElement, string][] = [];
  for (const owner of owners)
    for (const attribute of SEED_ATTRIBUTES) {
      const id = owner.getAttribute(attribute);
      if (!id) continue;
      const current = document.getElementById(id);
      const source = next.getElementById(id);
      if (!current || !source) return false;
      seeds.push([current, source.textContent ?? ""]);
    }
  applyDisplayAttributes(attributesOf(next.documentElement));
  for (const [seed, text] of seeds) {
    seed.textContent = text;
    seed.removeAttribute("data-src");
  }
  return true;
}

export async function adoptPageData(next: Document): Promise<boolean> {
  const body = document.body;
  const owners = [...document.querySelectorAll<Owner>(OWNERS)];
  if (!owners.length || owners.some((owner) => !owner.adoptPageData)) return false;
  const seeds = new Map<string, HTMLElement>();
  for (const owner of owners) {
    for (const attribute of SEED_ATTRIBUTES) {
      const id = owner.getAttribute(attribute);
      if (!id) continue;
      const seed = next.getElementById(id);
      if (!seed) return false;
      if (seed.getAttribute("data-src")) {
        const text = await externalPageText(seed.getAttribute("data-src")!);
        if (text === undefined) return false;
        seed.textContent = text;
        seed.removeAttribute("data-src");
      }
      seeds.set(id, seed);
    }
  }
  if (document.body !== body || owners.some((owner) => !owner.isConnected)) return false;
  applyDisplayAttributes(attributesOf(next.documentElement));
  for (const [id, seed] of seeds) {
    const copy = document.importNode(seed, true);
    const previous = document.getElementById(id);
    if (previous) previous.replaceWith(copy);
    else document.body.append(copy);
  }
  for (const owner of owners) parsedPages.delete(owner);
  const adopted = await Promise.all(owners.map((owner) => owner.adoptPageData!()));
  return adopted.every((result) => result !== false);
}

export function pageDataViewCurrent(owner: Element): boolean {
  const data = owner.ownerDocument?.documentElement?.dataset;
  if (!data) return false;
  const currentKey = `view-v1-${data.contentVisibilityVersion}-${currentContentGroup()}-${Number(spoilerContentEnabled())}-${Number(showUnreleasedContent())}`;
  return !data.contentResponseKey || data.contentResponseKey === currentKey;
}
export function readPageData<T>(owner: Element, attribute = "data-page-data"): T | undefined {
  if (!pageDataViewCurrent(owner)) return undefined;
  const scope = JSON.stringify([visibilityPolicyKey(), showUnreleasedContent()]);
  const cached = parsedPages.get(owner)?.get(attribute);
  if (cached?.scope === scope) return cached.value as T;
  const id = owner.getAttribute(attribute);
  const element = id ? owner.ownerDocument.getElementById(id) : null;
  if (!element?.textContent) return undefined;
  try {
    const data = decodePageData(JSON.parse(element.textContent)) as T;
    const pages = parsedPages.get(owner) || new Map<string, { scope: string; value: unknown }>();
    pages.set(attribute, { scope, value: data });
    parsedPages.set(owner, pages);
    if (owner.isConnected) element.remove();
    return data;
  } catch {
    return undefined;
  }
}
