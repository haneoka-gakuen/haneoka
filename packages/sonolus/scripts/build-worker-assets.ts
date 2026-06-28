// Bundle and run the TypeScript Sonolus Worker asset generator. Keeping this
// generator in TS lets it reuse the chart converter without publishing a package.
import * as esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const outfile = resolve(pkg, "dist/build-worker-assets.mjs");

await esbuild.build({
  entryPoints: [resolve(pkg, "src/server/buildWorkerAssets.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile,
  logLevel: "info",
});

await import(pathToFileURL(outfile).href);
