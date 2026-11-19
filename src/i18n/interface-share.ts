// L3 — GEB
// Input: An English page URL, an interface language, and the preview route table.
// Output: A locale-specific static social-preview URL for the same public page.
// Pos: [Map](L2-2.md); sharing for interface languages that reuse English documents.
// Effects/Dependencies: The preview optionally selects the language for this browser tab.
import groups from "../config/interface-share.json";
import { type InterfaceLanguageId, SHARE_LANGUAGE_STORAGE_KEY } from "./interface-language-options";

const englishPage = /^\/(?:(?:jp|intl)\/)?en(?:\/|$)/u;

function sharedPagePath(value: string | null, origin: string): string {
  if (!value || !englishPage.test(value) || /(?:[\\?#]|%2f|%5c)/iu.test(value)) return "";
  const target = new URL(value, origin);
  return target.origin === origin && englishPage.test(target.pathname) ? target.pathname : "";
}

export function interfaceShareUrl(current: URL, locale: InterfaceLanguageId): URL | undefined {
  const target = sharedPagePath(current.pathname, current.origin);
  if (!target) return;
  const logical = target.replace(englishPage, "/").replace(/\/$/u, "");
  let selected = "home";
  let length = 0;
  for (const [id, { paths }] of Object.entries(groups)) {
    for (const prefix of paths) {
      if (prefix.length > length && (logical === prefix || logical.startsWith(`${prefix}/`))) {
        length = prefix.length;
        selected = id;
      }
    }
  }
  const share = new URL(`/share-preview/${locale}/p-${selected}/`, current.origin);
  share.searchParams.set("to", target);
  return share;
}

export function openInterfaceShare(locale: InterfaceLanguageId): void {
  const url = new URL(location.href);
  const target = sharedPagePath(url.searchParams.get("to"), url.origin);
  try {
    sessionStorage.setItem(SHARE_LANGUAGE_STORAGE_KEY, locale);
  } catch {}
  if (target) location.replace(target);
}
