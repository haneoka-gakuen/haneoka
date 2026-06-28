import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const databaseDirectory = resolve(repositoryRoot, "worker/database");
const planDirectory = resolve(databaseDirectory, "plans");
const schemaPath = resolve(databaseDirectory, "schema.sql");

const requestedName = process.argv[2]?.trim().toLocaleLowerCase("en-US") ?? "";
const slug = requestedName.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
if (!slug || slug.length > 64) {
  throw new Error("Pass a short plan name, for example: pnpm db:plan:create add_saved_views");
}

const schemaSql = readFileSync(schemaPath, "utf8");
const schemaDigest = createHash("sha256").update(schemaSql).digest("hex");
const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const outputPath = resolve(planDirectory, `${timestamp}_${slug}.sql`);

mkdirSync(planDirectory, { recursive: true });
const template = [
  "-- Haneoka D1 manual change plan. This local operational file is intentionally ignored by Git.",
  "-- target-schema: worker/database/schema.sql",
  `-- target-schema-sha256: ${schemaDigest}`,
  "-- Review the current no-data snapshot, data compatibility, forward recovery, and post-apply checks.",
  "-- Use defer_foreign_keys for table rebuilds; never put secrets or production rows in this file.",
  "",
  "PRAGMA defer_foreign_keys = ON;",
  "PRAGMA foreign_keys = ON;",
  "",
  "-- Write the reviewed DDL and any required data transformations below.",
  "",
].join("\n");

writeFileSync(outputPath, template, { encoding: "utf8", flag: "wx" });
console.log(`Created ignored manual D1 plan: ${outputPath}`);
