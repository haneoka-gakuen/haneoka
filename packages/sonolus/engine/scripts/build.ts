import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(engineRoot, "dist");
const stagingRoot = resolve(engineRoot, ".build-parallel");

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

async function main(): Promise<void> {
  rmSync(stagingRoot, { recursive: true, force: true });
  const cli = sonolusCli();

  // Build the four facets concurrently, each in its own isolated `dev`/`dist`
  // workspace so their compiler outfiles (`<dev>/index.mjs`) and artifacts
  // cannot clobber each other.
  await Promise.all(
    FACETS.map(({ name }) => {
      const facetEnv = {
        SONOLUS_ENGINE_DEV: resolve(stagingRoot, name, "dev"),
        SONOLUS_ENGINE_DIST: resolve(stagingRoot, name, "dist"),
      };
      return run(cli, ["--build", `./${name}/sonolus-cli.config.ts`], facetEnv);
    }),
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

await main();
