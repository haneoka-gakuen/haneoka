// Bundle the TS Sonolus server (src/server/serve.ts) into a single runnable
// ESM file (dist/serve.mjs). Uses the esbuild API in-process (the esbuild
// CLI shim is not linked in this pnpm layout, but the JS API works). External
// packages resolve from the workspace's node_modules at runtime.
import * as esbuild from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");

await esbuild.build({
  entryPoints: [resolve(pkg, "src/server/serve.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: resolve(pkg, "dist/serve.mjs"),
  logLevel: "info",
});
console.log("built packages/sonolus/dist/serve.mjs");
