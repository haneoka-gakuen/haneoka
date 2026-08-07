import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(engineRoot, "dist");
/** Local dev: parallel facets stage here before merging into `dist/`. */
const stagingRoot = resolve(engineRoot, ".build-parallel");
/** CI matrix: a single facet's output lands here for caching + artifact upload. */
const matrixRoot = resolve(engineRoot, ".build-matrix");

/**
 * Each facet produces its own `Engine<Facet>Data` plus a shared
 * `EngineConfiguration`. The compiler also writes a `LevelData` intermediate we
 * discard.
 */
const FACETS = [
  { name: "play", artifact: "EnginePlayData" },
  { name: "watch", artifact: "EngineWatchData" },
  { name: "preview", artifact: "EnginePreviewData" },
  { name: "tutorial", artifact: "EngineTutorialData" },
] as const;

/** Resolves the local `sonolus-cli` bin explicitly (children don't inherit `.bin`). */
function sonolusCli(): string {
  const candidate = resolve(engineRoot, "node_modules/.bin/sonolus-cli");
  return existsSync(candidate) ? candidate : "sonolus-cli";
}

function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: engineRoot, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`\`${bin} ${args.join(" ")}\` exited with status ${code}`));
    });
  });
}

/** Compile one facet into an isolated `dev`/`dist` workspace. */
function buildFacet(name: string, dev: string, dist: string): Promise<void> {
  return run(
    sonolusCli(),
    ["--build", `./${name}/sonolus-cli.config.ts`],
    { SONOLUS_ENGINE_DEV: dev, SONOLUS_ENGINE_DIST: dist },
  );
}

/**
 * CI matrix entry point: compile a single facet into
 * `.build-matrix/<facet>/dist/` (EngineConfiguration + Engine<Facet>Data), skipping
 * the merge and license stamp that the fan-in job owns. This path is what the
 * per-facet cache stores and the workflow artifact uploads.
 */
async function buildSingleFacet(name: string): Promise<void> {
  const facet = FACETS.find((value) => value.name === name);
  if (!facet) {
    throw new Error(
      `Unknown facet ${JSON.stringify(name)}. Expected one of: ${FACETS.map((f) => f.name).join(", ")}`,
    );
  }
  const facetRoot = resolve(matrixRoot, facet.name);
  rmSync(facetRoot, { recursive: true, force: true });
  await buildFacet(facet.name, resolve(facetRoot, "dev"), resolve(facetRoot, "dist"));
}

/**
 * Local build: compile the four facets concurrently, merge their artifacts into
 * `dist/`, and stamp the distribution with licenses + the source pointer.
 */
async function buildAll(): Promise<void> {
  rmSync(stagingRoot, { recursive: true, force: true });

  // Build the four facets concurrently, each in its own isolated `dev`/`dist`
  // workspace so their compiler outfiles (`<dev>/index.mjs`) and artifacts
  // cannot clobber each other.
  await Promise.all(
    FACETS.map(({ name }) =>
      buildFacet(name, resolve(stagingRoot, name, "dev"), resolve(stagingRoot, name, "dist")),
    ),
  );

  // Merge the per-facet artifacts into the real dist/. EngineConfiguration is
  // identical across facets, so copy it once from the first.
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });
  const first = FACETS[0];
  if (!first) throw new Error("No engine facets are configured");
  copyFileSync(resolve(stagingRoot, first.name, "dist", "EngineConfiguration"), resolve(distRoot, "EngineConfiguration"));
  for (const { name, artifact } of FACETS) {
    copyFileSync(resolve(stagingRoot, name, "dist", artifact), resolve(distRoot, artifact));
  }
  rmSync(stagingRoot, { recursive: true, force: true });

  // Stamp the distribution with licenses + source pointer (idempotent, standalone script).
  await run("node", ["./scripts/copy-upstream-license.ts"], {});
}

// `node build.ts <facet>` compiles one facet for the CI matrix; no argument runs the
// full local build.
const requestedFacet = process.argv[2];
if (requestedFacet) {
  await buildSingleFacet(requestedFacet);
} else {
  await buildAll();
}
