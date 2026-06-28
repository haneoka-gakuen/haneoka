import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runWrangler } from "./wrangler.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const exportDirectory = resolve(repositoryRoot, "worker/database/exports");
const mode = process.argv[2];

if (mode !== "--local" && mode !== "--remote") {
  throw new Error("Choose exactly one snapshot source: --local or --remote");
}

mkdirSync(exportDirectory, { recursive: true });
const location = mode.slice(2);
const outputPath = resolve(exportDirectory, `${location}-schema.sql`);

runWrangler(
  ["d1", "export", "haneoka-community", mode, "--no-data", `--output=${outputPath}`, "--skip-confirmation"],
  repositoryRoot,
);

console.log(`Read-only ${location} D1 schema snapshot: ${outputPath}`);
