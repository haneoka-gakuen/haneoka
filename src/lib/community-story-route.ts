// L3 — GEB
// Input: Locale, story identity, editor parameters and legacy or canonical URLs.
// Output: Cross-server story, reader and editor paths, redirects and entity metadata.
// Pos: [Map](L2-2.md); shared by navigation, editors, static rendering and servers.
// Effects/Dependencies: Pure URL and HTML transformations; preserves revision and draft queries.
import { rewriteCommunityDocument } from "./community-document-meta.ts";
const LOCALE = "(?:ja|en|zh-TW|zh-CN|ko)";
const ID = "[0-9a-f-]{36}";
const DOCUMENT = new RegExp(`^/(${LOCALE})/community/stories/(${ID})(/story)?/?$`, "u");
const LEGACY = new RegExp(`^/(?:(?:jp|intl)/)?(${LOCALE})/community-stories(?:/(${ID})(/story)?)?/?$`, "u");
const EDITOR = new RegExp(`^/(?:(?:jp|intl)/)?(${LOCALE})/story-creation/?$`, "u");
export function communityStoryPath(_server: string, locale: string, id = ""): string {
  return `/${locale}/community/stories/${id ? `${encodeURIComponent(id)}/` : ""}`;
}
export function communityStoryReaderPath(server: string, locale: string, id: string): string {
  return `${communityStoryPath(server, locale, id)}story/`;
}
export function storyCreationPath(locale: string, id?: string): string {
  return `/${locale}/story-editor/create/${id ? `?community=${encodeURIComponent(id)}` : ""}`;
}
export function parseCommunityStoryDocument(pathname: string) {
  const match = DOCUMENT.exec(pathname);
  return match ? { locale: match[1]!, id: match[2]!, reader: !!match[3] } : undefined;
}
export function legacyCommunityStoryRedirectTarget(pathname: string, search = ""): string | undefined {
  const legacy = LEGACY.exec(pathname);
  if (legacy) return `${communityStoryPath("", legacy[1]!, legacy[2])}${legacy[3] ? "story/" : ""}${search}`;
  const editor = EDITOR.exec(pathname);
  if (!editor) return;
  const query = new URLSearchParams(search);
  if (query.has("story") && !query.has("community")) query.set("community", query.get("story")!);
  query.delete("story");
  return storyCreationPath(editor[1]!) + (query.size ? `?${query}` : "");
}
export function communityStoryShellPath(pathname: string): string | undefined {
  const route = parseCommunityStoryDocument(pathname);
  return route ? `/${route.locale}/community/stories/_/` : undefined;
}
export function communityStoryDocumentEtag(etag: string, pathname: string): string {
  const route = parseCommunityStoryDocument(pathname);
  return route
    ? etag.replace(/"$/u, `:story-${route.locale}-${route.id}-${route.reader ? "reader" : "detail"}"`)
    : etag;
}
export function communityStoryDocumentPath(
  route: NonNullable<ReturnType<typeof parseCommunityStoryDocument>>,
  locale = route.locale,
): string {
  return route.reader ? communityStoryReaderPath("", locale, route.id) : communityStoryPath("", locale, route.id);
}
export function rewriteCommunityStoryDocument(html: string, pathname: string, origin: string): string {
  const route = parseCommunityStoryDocument(pathname);
  return route
    ? rewriteCommunityDocument(html, route.locale, (locale) => communityStoryDocumentPath(route, locale), origin)
    : html;
}
