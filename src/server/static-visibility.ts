// L3 — GEB
// Input: The current visibility settings and the build's publication cutoff.
// Output: A frozen visibility snapshot shared by the front-end render jobs.
// Pos: [Map](L2-2.md); visibility input for static preparation and rendering.
// Effects/Dependencies: Reads the existing policy endpoint once and records a verified build input.
import fs from "node:fs";
import path from "node:path";
import { parseVisibilityPolicy, type ContentVisibilitySettings } from "../lib/content-visibility-policy.ts";
import { captureStaticBuildFile, staticBuildJson } from "./static-input-store.ts";

const file = ".output/static-inputs/visibility.json";
type StaticVisibilitySnapshot = { now: number; settings: ContentVisibilitySettings };
let frozen: StaticVisibilitySnapshot | undefined;

export function readStaticVisibility(): StaticVisibilitySnapshot | undefined {
  const mode = process.env.STATIC_BUILD_INPUT_MODE;
  if (!frozen && mode !== "frozen" && (mode !== "capture" || !fs.existsSync(file))) return;
  return (frozen ??= JSON.parse(fs.readFileSync(file, "utf8")) as StaticVisibilitySnapshot);
}

export function staticVisibilityTime(): number {
  return readStaticVisibility()?.now ?? Date.now();
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
