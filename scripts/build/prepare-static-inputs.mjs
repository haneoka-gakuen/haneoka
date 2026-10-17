import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
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
try {
  const { prepareStaticInputs } = await import(pathToFileURL(output).href);
  await prepareStaticInputs();
  console.log(
    JSON.stringify({
      stage: "prepare-static-inputs",
      elapsedMs: performance.now() - started,
      peakRssKb: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  fs.rmSync(output, { force: true });
  fs.rmSync(output.replace(/\.mjs$/u, ".css"), { force: true });
}
