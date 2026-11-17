// L3 — GEB
// Input: Locked data producers, compiled package identity and pinned resource releases.
// Output: Complete captured inputs, a publication registry and immutable entity projection cache entries.
// Pos: [Map](L2-2.md); production data preparation before locale render workers.
// Effects/Dependencies: Bundles producers, validates cache recipes and runs the normal captured readers.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { staticBuildSourceIdentity } from "../../src/server/static-build-identity.ts";
import { resetStaticBuildInputErrors } from "../../src/server/static-input-store.ts";

const root = process.cwd();
const started = performance.now();
staticBuildSourceIdentity(root);
resetStaticBuildInputErrors();
if (process.env.STATIC_BUILD_INPUT_MODE !== "capture" || !process.env.STATIC_BUILD_INPUT_ROOT)
  throw new Error("Set STATIC_BUILD_INPUT_MODE=capture and STATIC_BUILD_INPUT_ROOT");
const output = path.resolve(".astro/static-inputs/prepare.mjs");
await build({
  entryPoints: [path.resolve("src/server/prepare-static-inputs.ts")],
  absWorkingDir: root,
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { "import.meta.env": JSON.stringify({ PROD: true, DEV: false, SSR: true, BASE_URL: "/" }) },
  logLevel: "warning",
});
const digest = (body) => createHash("sha256").update(body).digest("hex");
const cacheEnabled = process.argv[2] === "cache-key" || process.env.STATIC_BUILD_PROJECTION_CACHE_ROOT;
const recipe =
  cacheEnabled &&
  digest(
    JSON.stringify({
      schema: "haneoka-entity-projection-cache-v1",
      producer: digest(fs.readFileSync(output)),
      packages: digest(fs.readFileSync(".output/compiled-packages/manifest.json")),
      lock: digest(fs.readFileSync("pnpm-lock.yaml")),
      pins: JSON.parse(fs.readFileSync(".output/static-native-pins.json", "utf8")),
      node: process.versions,
      configuration: staticBuildSourceIdentity(root).configuration,
    }),
  );
try {
  if (process.argv[2] === "cache-key") console.log(recipe);
  else {
    if (process.env.STATIC_BUILD_PROJECTION_RECIPE && process.env.STATIC_BUILD_PROJECTION_RECIPE !== recipe)
      throw new Error("Entity projection cache recipe changed after restore");
    if (recipe) process.env.STATIC_BUILD_PROJECTION_RECIPE = recipe;
    const { prepareStaticInputs } = await import(pathToFileURL(output).href);
    await prepareStaticInputs();
    console.log(
      JSON.stringify({
        stage: "prepare-static-inputs",
        elapsedMs: performance.now() - started,
        peakRssKb: process.resourceUsage().maxRSS,
      }),
    );
  }
} finally {
  fs.rmSync(output, { force: true });
  fs.rmSync(output.replace(/\.mjs$/u, ".css"), { force: true });
}
