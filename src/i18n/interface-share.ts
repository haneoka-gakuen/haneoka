// L3 — GEB
// Input: A document URL and the interface language.
// Output: The canonical public interface URL and its social image group.
// Pos: [Map](L2-2.md); sharing for interface languages that reuse English documents.
// Effects/Dependencies: Legacy previews continue to link to the canonical language URL.
import { type InterfaceLanguageId } from "./interface-language-options";
import { interfacePath } from "./interface-route.ts";

const englishPage = /^\/(?:(?:jp|intl)\/)?en(?:\/|$)/u;

function sharedPagePath(value: string | null, origin: string): string {
  if (!value || !englishPage.test(value) || /(?:[\\?#]|%2f|%5c)/iu.test(value)) return "";
  const target = new URL(value, origin);
  return target.origin === origin && englishPage.test(target.pathname) ? target.pathname : "";
}

export function interfaceShareUrl(current: URL, locale: InterfaceLanguageId): URL {
  const target = new URL(current);
  target.pathname = interfacePath(current.pathname, locale);
  target.search = "";
  target.hash = "";
  return target;
}

export function openInterfaceShare(locale: InterfaceLanguageId): void {
  const url = new URL(location.href);
  const target = sharedPagePath(url.searchParams.get("to"), url.origin);
  if (target) location.replace(interfacePath(target, locale));
}
