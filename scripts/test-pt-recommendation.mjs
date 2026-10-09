// Synthetic data only. Bundles TypeScript without changing the project's compiler settings.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const directory = path.resolve(".local-dev/pt-tests");
await mkdir(directory, { recursive: true });
for (const suite of [
  "pt-recommendation",
  "solo-cycle",
  "search-memory",
  "gekiso-rewards",
  "engine-performance",
  "song-scheduler",
  "live-score-cache",
  "gekiso-context-cache",
  "order-equivalence",
  "gekiso-local-bound",
  "boosts",
]) {
  const outfile = path.join(directory, `${suite}.mjs`);
  await build({
    entryPoints: [`tests/team-builder/${suite}.test.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { verify } = await import(pathToFileURL(outfile).href);
  const receipt = await verify();
  await writeFile(path.join(directory, `${suite}-receipt.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ suite, ...receipt }, null, 2));
}
