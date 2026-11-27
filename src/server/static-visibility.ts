// L3 — GEB
// Input: The current visibility settings and the build's publication cutoff.
// Output: A frozen visibility snapshot shared by the front-end render jobs.
// Pos: [Map](L2-2.md); visibility input for static preparation and rendering.
// Effects/Dependencies: Reads the existing policy endpoint once and records a verified build input.
import fs from "node:fs";
import path from "node:path";
import { parseVisibilityPolicy, type ContentVisibilitySettings } from "../lib/content-visibility-policy.ts";
import { contentListing, filterContentData, type ContentPublicationsByServer, type ContentReference, type ContentView } from "../lib/content-view.ts";
import { publicationBoundary } from "./public-static-documents.ts";
import { captureStaticBuildFile, staticBuildJson } from "./static-input-store.ts";

const file = ".output/static-inputs/visibility.json";
type StaticVisibilitySnapshot = { now: number; settings: ContentVisibilitySettings };
let frozen: StaticVisibilitySnapshot | undefined;
let publications: ContentPublicationsByServer | undefined;

export function readStaticVisibility(): StaticVisibilitySnapshot | undefined {
  const mode = process.env.STATIC_BUILD_INPUT_MODE;
  if (!frozen && mode !== "frozen" && (mode !== "capture" || !fs.existsSync(file))) return;
  return (frozen ??= JSON.parse(fs.readFileSync(file, "utf8")) as StaticVisibilitySnapshot);
}

export function staticVisibilityTime(): number {
  return readStaticVisibility()?.now ?? Date.now();
}

function readStaticPublicationRegistry(): ContentPublicationsByServer {
  return (publications ??= JSON.parse(fs.readFileSync(".output/static-inputs/publications.json", "utf8")) as ContentPublicationsByServer);
}

type Preview<T> = { value: T; version: number; next?: number };

export function staticPreview<T>(payload: T, resource: string | undefined, refs: readonly ContentReference[]): Preview<T> | undefined {
  const snapshot = readStaticVisibility();
  if (!snapshot || !refs.length) return;
  const view: ContentView = {
    policy: snapshot.settings.policy, group: "guest", spoilers: true, override: false, previewOnly: true, now: snapshot.now,
  };
  if (!refs.some((ref) => contentListing(view, ref.kind, ref.publication, ref.id) === "preview")) return;
  const filtered = filterContentData(payload, view, resource, true, {}, readStaticPublicationRegistry());
  if (!filtered.changed || !filtered.value) return;
  const next = refs.reduce((boundary, ref) => {
    const at = publicationBoundary(ref.publication, view.now);
    return at !== undefined && at > view.now ? Math.min(at, boundary) : boundary;
  }, Infinity);
  return { value: filtered.value as T, version: snapshot.settings.version, ...(Number.isFinite(next) ? { next } : {}) };
}

export function staticContentMarkup(
  full: { result: string; references: readonly ContentReference[] },
  published: string,
  preview?: Preview<string>,
): string {
  if (!full.references.length && full.result === published) return full.result;
  const refs = JSON.stringify(full.references).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
  const scoped = preview?.value !== published ? preview : undefined;
  const attributes = scoped
    ? ` data-content-preview-version="${scoped.version}"${scoped.next === undefined ? "" : ` data-content-preview-until="${scoped.next}"`}`
    : "";
  const previewBody = scoped ? `<div data-content-view="preview"${attributes} style="display:contents">${scoped.value}</div>` : "";
  return `<div data-content-view="full" data-content-references="${refs}" style="display:contents">${full.result}</div><div data-content-view="public"${attributes} style="display:contents">${published}</div>${previewBody}`;
}

async function currentStaticVisibility(): Promise<StaticVisibilitySnapshot> {
  const origin = process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
  const response = await fetch(new URL("/api/v1/content-visibility", origin), {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Static visibility settings returned HTTP ${response.status}`);
  const { policy: raw, version, updatedAt } = (await response.json()) as ContentVisibilitySettings;
  const policy = parseVisibilityPolicy(raw);
  if (!policy || !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(updatedAt))
    throw new Error("Invalid static visibility settings");
  return { now: Date.now(), settings: { policy, version, updatedAt } };
}

export async function captureStaticVisibility(): Promise<void> {
  frozen = await staticBuildJson("content-visibility", "visibility-settings", currentStaticVisibility);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(frozen));
  captureStaticBuildFile(file, "visibility-settings");
  console.log(`Captured visibility revision ${frozen.settings.version} at ${new Date(frozen.now).toISOString()}`);
}
