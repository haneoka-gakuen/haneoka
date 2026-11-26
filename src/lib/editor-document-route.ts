// L3 — GEB
// Input: Editor entry URLs, document IDs and import sources.
// Output: Public editor paths, legacy redirects and shared editor shell lookup.
// Pos: [Map](L2-2.md); route contract for browser editors and document servers.
// Effects/Dependencies: Pure path and query transformations.
import { isLocale } from "@haneoka/i18n";
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";

type Editor = "chart-editor" | "story-editor";
const isEditor = (value: unknown): value is Editor => value === "chart-editor" || value === "story-editor";
const uuid = /^[0-9a-f-]{36}$/iu;
const safeId = (value: string | null | undefined): value is string =>
  !!value && value.length <= 768 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value);
const positive = (value?: string | null): value is string => !!value && /^[1-9]\d*$/u.test(value);

function editorAddress(pathname: string) {
  const [locale, editor, create, ...path] = englishInterfacePath(pathname).split("/").filter(Boolean);
  if (!isLocale(locale) || !isEditor(editor) || create !== "create") return undefined;
  return { locale, editor, path };
}

function editorSegments(editor: Editor, params: URLSearchParams): string[] {
  const community = params.get("community") || (editor === "story-editor" ? params.get("story") : null);
  if (community && uuid.test(community)) {
    const revision = params.get("revision");
    return ["community", community, ...(positive(revision) ? ["revisions", revision] : []),
      ...(editor === "story-editor" && params.get("remix") === "1" ? ["remix"] : [])];
  }
  if (editor === "chart-editor") {
    const region = params.get("region") || "jp", song = params.get("songId"), difficulty = params.get("difficulty");
    if (params.get("provider") === "bestdori" && safeId(region) && positive(song) && safeId(difficulty))
      return ["import", "bestdori", region, song, difficulty];
  } else {
    const story = params.get("importStory"), server = params.get("importServer") || "intl",
      provider = params.get("importProvider") || "haneoka";
    if (safeId(story) && safeId(server) && ["haneoka", "bestdori", "sekai"].includes(provider))
      return ["import", provider, server, story];
    const project = params.get("project");
    if (safeId(project)) return ["projects", project];
  }
  return [];
}

const editorKeys = (editor: Editor) => editor === "chart-editor"
  ? ["community", "revision", "provider", "region", "songId", "difficulty"]
  : ["community", "story", "revision", "remix", "importStory", "importServer", "importProvider", "project"];

export function editorDocumentPath(locale: string, editor: Editor, params = new URLSearchParams()): string {
  const segments = editorSegments(editor, params);
  const root = `/${locale}/${editor}/create/`;
  const query = new URLSearchParams(params);
  if (segments.length) for (const key of editorKeys(editor)) query.delete(key);
  return root + (segments.length ? segments.map(encodeURIComponent).join("/") + "/" : "") + (query.size ? `?${query}` : "");
}

function editorPathParams(editor: Editor, path: string[]): URLSearchParams | undefined {
  try {
    const [kind, first, second, third, fourth, ...extra] = path.map(decodeURIComponent);
    const params = new URLSearchParams();
    if (kind === "community" && first && uuid.test(first)) {
      params.set("community", first);
      const parts = path.slice(2);
      if (parts[0] === "revisions" && positive(parts[1])) params.set("revision", parts.splice(0, 2)[1]!);
      if (editor === "story-editor" && parts[0] === "remix") {
        parts.shift();
        params.set("remix", "1");
      }
      if (parts.length) return undefined;
    } else if (kind === "projects" && editor === "story-editor" && safeId(first) && path.length === 2) {
      params.set("project", first);
    } else if (kind === "import" && editor === "chart-editor" && first === "bestdori" && safeId(second) && positive(third) && safeId(fourth) && !extra.length) {
      for (const [key, value] of [["provider", first], ["region", second], ["songId", third], ["difficulty", fourth]])
        params.set(key!, value!);
    } else if (kind === "import" && editor === "story-editor" && first && ["haneoka", "bestdori", "sekai"].includes(first) && safeId(second) && safeId(third) && path.length === 4) {
      params.set("importProvider", first);
      params.set("importServer", second);
      params.set("importStory", third);
    } else return undefined;
    return params;
  } catch { return undefined; }
}

export function editorDocumentParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search);
  const address = editorAddress(url.pathname);
  const selected = address && editorPathParams(address.editor, address.path);
  if (selected && address) {
    for (const key of editorKeys(address.editor)) params.delete(key);
    for (const [key, value] of selected) params.set(key, value);
  }
  return params;
}

export function editorDocumentAddress(url: URL, params: URLSearchParams): string {
  const address = editorAddress(url.pathname);
  if (!address) return url.pathname + url.search + url.hash;
  const target = editorDocumentPath(address.locale, address.editor, params);
  const language = interfaceLanguageFromPath(url.pathname);
  return (language ? interfacePath(target, language.value) : target) + url.hash;
}

export function editorShellPath(pathname: string): string | undefined {
  const address = editorAddress(pathname);
  if (address && editorPathParams(address.editor, address.path))
    return editorDocumentPath(address.locale, address.editor);
  return undefined;
}

export function legacyEditorRedirectTarget(pathname: string, search: string): string | undefined {
  if (!search) return undefined;
  const address = editorAddress(pathname);
  if (!address || address.path.length) return undefined;
  const url = new URL(pathname + search, "https://route.invalid");
  const target = editorDocumentAddress(url, url.searchParams);
  return target !== pathname + search && editorShellPath(new URL(target, url).pathname) ? target : undefined;
}
