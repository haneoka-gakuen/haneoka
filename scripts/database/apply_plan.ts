import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { runWrangler } from "./wrangler.ts";

const databaseName = "haneoka-community";
const repositoryRoot = resolve(import.meta.dirname, "../..");
const databaseDirectory = resolve(repositoryRoot, "worker/database");
const planDirectory = resolve(databaseDirectory, "plans");
const schemaPath = resolve(databaseDirectory, "schema.sql");

const mode = process.argv[2];
const requestedPlan = process.argv[3];

if (mode !== "--local") throw new Error("Manual plans may only be applied to local D1");
if (!requestedPlan) {
  throw new Error("Pass a plan file under worker/database/plans/ to the local apply command");
}
if (process.argv.length > 4) throw new Error("Unexpected apply arguments");

const planPath = resolve(repositoryRoot, requestedPlan);
const planRelativePath = relative(planDirectory, planPath);
if (
  planRelativePath === "" ||
  planRelativePath === ".." ||
  planRelativePath.startsWith(`..${sep}`) ||
  isAbsolute(planRelativePath) ||
  extname(planPath) !== ".sql"
) {
  throw new Error("Plan must be a .sql file under worker/database/plans/");
}
if (!lstatSync(planPath).isFile() || realpathSync(planPath) !== planPath) {
  throw new Error("Plan must be a regular file, not a symlink");
}

const planSql = readFileSync(planPath, "utf8");
const withoutCommentsAndPragmas = planSql
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--.*$/gm, "")
  .replace(/\bPRAGMA\s+[A-Za-z_]+\s*=\s*[^;]+;/gi, "")
  .trim();
if (!/\b(?:ALTER|CREATE|DELETE|DROP|INSERT|REINDEX|REPLACE|UPDATE)\b/i.test(withoutCommentsAndPragmas)) {
  throw new Error("Plan contains no DDL or data transformation statements");
}

const targetDigest = createHash("sha256").update(readFileSync(schemaPath, "utf8")).digest("hex");
const planDigest = /^-- target-schema-sha256: ([0-9a-f]{64})$/m.exec(planSql)?.[1];
if (planDigest !== targetDigest) {
  throw new Error("Plan was not created for the current worker/database/schema.sql; create and review a new plan");
}

runWrangler(["d1", "execute", databaseName, "--local", `--file=${planPath}`], repositoryRoot);

console.log(`Applied ${planRelativePath} to local D1; export and compare the schema now.`);
