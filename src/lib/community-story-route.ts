// L3 — GEB
// Input: Locale, story identity, editor parameters and legacy or canonical URLs.
// Output: Cross-server story, reader and editor paths, redirects and entity metadata.
// Pos: [Map](L2-2.md); shared by navigation, editors, static rendering and servers.
// Effects/Dependencies: Pure URL and HTML transformations; keeps draft access queries.
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";
import { rewriteCommunityDocument } from "./community-document-meta.ts";
import { editorDocumentPath } from "./editor-document-route.ts";
const LOCALE = "(?:ja|en|zh-TW|zh-CN|ko)";
const ID = "[0-9a-f-]{36}";
const DOCUMENT = new RegExp(`^/(${LOCALE})/community/stories/(${ID})(?:/revisions/([1-9]\\d*))?(/story)?/?$`, "u");
const LEGACY = new RegExp(`^/(?:(?:jp|intl)/)?(${LOCALE})/community-stories(?:/(${ID})(/story)?)?/?$`, "u");
const EDITOR = new RegExp(`^/(?:(?:jp|intl)/)?(${LOCALE})/story-creation/?$`, "u");
export function communityStoryPath(_server: string, locale: string, id = "", revision?: number): string {
  return `/${locale}/community/stories/${id ? `${encodeURIComponent(id)}/${revision ? `revisions/${revision}/` : ""}` : ""}`;
}
export function communityStoryReaderPath(server: string, locale: string, id: string, revision?: number): string {
  return `${communityStoryPath(server, locale, id, revision)}story/`;
}
export function storyCreationPath(locale: string, id?: string, revision?: number, remix = false): string {
  const params = new URLSearchParams();
  if (id) params.set("community", id);
  if (revision) params.set("revision", String(revision));
  if (remix) params.set("remix", "1");
  return editorDocumentPath(locale, "story-editor", params);
}
export function parseCommunityStoryDocument(pathname: string) {
  pathname = englishInterfacePath(pathname);
  const match = DOCUMENT.exec(pathname);
  if (!match) return undefined;
  const revision = match[3] ? Number(match[3]) : undefined;
  if (revision !== undefined && !Number.isSafeInteger(revision)) return undefined;
  return { locale: match[1]!, id: match[2]!, revision, reader: !!match[4] };
}
export function legacyCommunityStoryRedirectTarget(pathname: string, search = ""): string | undefined {
  const legacy = LEGACY.exec(pathname);
  const document = parseCommunityStoryDocument(pathname);
  const query = new URLSearchParams(search);
  const revisionValue = query.get("revision");
  const revision = revisionValue && /^[1-9]\d*$/u.test(revisionValue) && Number.isSafeInteger(Number(revisionValue)) ? Number(revisionValue) : undefined;
  if (legacy || document && revision) {
    const route = document ?? { locale: legacy![1]!, id: legacy![2]!, reader: !!legacy![3], revision: undefined };
    if (revision && route.id) query.delete("revision");
    const target = communityStoryDocumentPath({ ...route, revision: route.revision ?? revision });
    const language = interfaceLanguageFromPath(pathname);
    return (language ? interfacePath(target, language.value) : target) + (query.size ? `?${query}` : "");
  }
  const editor = EDITOR.exec(pathname);
  if (!editor) return;
  if (query.has("story") && !query.has("community")) query.set("community", query.get("story")!);
  query.delete("story");
  return editorDocumentPath(editor[1]!, "story-editor", query);
}
export function communityStoryShellPath(pathname: string): string | undefined {
  const route = parseCommunityStoryDocument(pathname);
  return route ? `/${route.locale}/community/stories/_/` : undefined;
}
export function communityStoryDocumentEtag(etag: string, pathname: string): string {
  const route = parseCommunityStoryDocument(pathname);
  return route
    ? etag.replace(/"$/u, `:story-${route.locale}-${route.id}-${route.revision || 0}-${route.reader ? "reader" : "detail"}"`)
    : etag;
}
export function communityStoryDocumentPath(
  route: NonNullable<ReturnType<typeof parseCommunityStoryDocument>>,
  locale = route.locale,
): string {
  return route.reader ? communityStoryReaderPath("", locale, route.id, route.revision) : communityStoryPath("", locale, route.id, route.revision);
}
export function rewriteCommunityStoryDocument(html: string, pathname: string, origin: string): string {
  const route = parseCommunityStoryDocument(pathname);
  return route
    ? rewriteCommunityDocument(html, route.locale, (locale) => communityStoryDocumentPath(route, locale), origin)
    : html;
}
