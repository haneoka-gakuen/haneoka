// L3 — GEB
// Input: Explicit captured entity records and fixed source identity fixtures.
// Output: Twenty-process replay, identity and missing/corrupt-record checks.
// Pos: [Map](L2-2.md); frozen entity reader acceptance without game input.
// Effects/Dependencies: Isolated local files and child Node processes; all graph/network readers throw.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const hash = (body) => createHash("sha256").update(body).digest("hex");
const pin = { server: "jp", sourceId: "source-A", releaseId: "release-A" };
const identity = { schema: "haneoka-base-page-v1", ...pin, resource: "cards", id: "1" };
const payload = {
  schema: "haneoka-entity-payload-v1",
  ...pin,
  resource: "cards",
  id: "1",
  item: { power: 100 },
  aux: {},
};
const key = `base-page:${JSON.stringify(identity)}`;
if (process.argv[2] === "child") {
  const root = process.argv[3];
  process.env.STATIC_BUILD_INPUT_MODE = "frozen";
  process.env.STATIC_BUILD_INPUT_ROOT = root;
  // Failure reports belong to this fixture, never the developer checkout.
  process.chdir(root);
  const forbidden = (names) =>
    names
      .map((name) => `export function ${name}(){throw new Error('Unexpected graph or network read: ${name}');}`)
      .join("\n");
  const mocks = {
    "@haneoka/vega-plugin-haneoka/transcript": forbidden(["projectHaneokaTranscript"]),
    "./song-performer": forbidden(["resolveSongPerformer"]),
    "../server/item-relations": forbidden(["itemRelations"]),
    "./gekisou": forbidden(["gekisouMissionIcons"]),
    "./entity-associations": forbidden([
      "associatedReward",
      "characterRankAssociations",
      "entityReference",
      "skillDisplay",
      "upgradeSteps",
    ]),
    "./static-catalog-source":
      `export async function staticCatalogRelease(){return ${JSON.stringify(pin)}};` +
      forbidden(["asRecord", "fetchOptionalStaticCatalog", "fetchStaticCatalog", "fetchStaticCatalogBatch"]),
    "./searchable-catalog": forbidden(["searchableCatalogPages"]),
    "./searchable-stories": forbidden(["searchableStoryPages"]),
    "./resource-route": 'export const RELEASE_SERVERS=["jp","intl"];',
    "./temporary-public-routing": 'export const PUBLIC_RELEASE_SERVERS=["jp","intl"]; export const isPublicReleaseServer=server=>PUBLIC_RELEASE_SERVERS.includes(server);',
  };
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("/entity-graph.ts")) {
        if (mocks[specifier])
          return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
        if (specifier === "../server/static-input-store")
          return { url: new URL("../../src/server/static-input-store.ts", import.meta.url).href, shortCircuit: true };
      }
      if (context.parentURL?.endsWith("/static-input-store.ts") && specifier === "./static-build-identity.ts")
        return {
          url: "data:text/javascript,export function staticBuildSourceIdentity(){return {fixture:'fixed-source-A'}}",
          shortCircuit: true,
        };
      if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
        const source = new URL(`${specifier}.ts`, context.parentURL);
        if (fs.existsSync(source)) return { url: source.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const { catalogEntityData, entityProjectionMetrics } = await import("../../src/lib/entity-graph.ts");
  assert.deepEqual(await catalogEntityData("jp", "cards", "1"), payload);
  assert.deepEqual(entityProjectionMetrics(), { fullGraphs: 0, coreGraphs: 0, pageMaps: 0 });
  console.log("one frozen record; zero graph/network reads");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haneoka-base-page-"));
  const make = (name, record) => {
    const folder = path.join(root, name);
    fs.mkdirSync(path.join(folder, "content"), { recursive: true });
    const body = Buffer.from(JSON.stringify(record));
    fs.writeFileSync(path.join(folder, "content", hash(body)), body);
    fs.writeFileSync(
      path.join(folder, "capture.json"),
      JSON.stringify({
        schema: "haneoka-static-captured-inputs-v1",
        source: { fixture: "fixed-source-A" },
        capturedAt: "fixture",
        records: [
          { key, role: "entity-projection", format: "json", sha256: hash(body), bytes: body.length },
          { key: "unrequested", role: "entity-projection", format: "json", sha256: "0".repeat(64), bytes: 1 },
        ],
        files: [],
      }),
    );
    return folder;
  };
  const run = (folder) =>
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "child", folder], {
      encoding: "utf8",
      stdio: "pipe",
    });
  const good = make("valid", { ...identity, payload });
  for (let i = 0; i < 20; i++) assert.match(run(good), /zero graph/);
  const wrong = make("wrong", { ...identity, sourceId: "source-B", payload });
  assert.throws(() => run(wrong), /Frozen page identity differs/);
  const wrongPayload = make("wrong-payload", { ...identity, payload: { ...payload, sourceId: "source-B" } });
  assert.throws(() => run(wrongPayload), /Frozen entity source differs/);
  const missing = make("missing", { ...identity, payload });
  const manifest = JSON.parse(fs.readFileSync(path.join(missing, "capture.json")));
  manifest.records = [];
  fs.writeFileSync(path.join(missing, "capture.json"), JSON.stringify(manifest));
  assert.throws(() => run(missing), /Frozen static input is missing/);
  const corrupt = make("corrupt", { ...identity, payload });
  const content = fs.readdirSync(path.join(corrupt, "content"))[0];
  fs.writeFileSync(path.join(corrupt, "content", content), "corrupt");
  assert.throws(() => run(corrupt), /body differs/);
  console.log(
    JSON.stringify({
      processes: 20,
      fullGraphReads: 0,
      networkReads: 0,
      rejected: 4,
      unusedRecordBodyRead: false,
      scope: "real frozen reader with declared source and entity records",
    }),
  );
}
