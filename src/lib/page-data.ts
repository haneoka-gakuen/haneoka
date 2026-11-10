import { currentContentGroup, visibilityPolicyKey } from "./content-policy-browser";
import { showUnreleasedContent } from "./content-release";
import { spoilerContentEnabled } from "./spoiler-content";
import { decodePageData } from "./page-data-codec";
export { decodePageData, serializePageData } from "./page-data-codec";

const parsedPages = new WeakMap<Element, Map<string, { scope: string; value: unknown }>>();
export function pageDataViewCurrent(owner: Element): boolean {
  const data = owner.ownerDocument.documentElement.dataset;
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
