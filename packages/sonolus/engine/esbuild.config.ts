import type { SonolusCLIConfig } from "@sonolus/sonolus.js";

type EsbuildHook = NonNullable<SonolusCLIConfig["esbuild"]>;

export const engineEsbuild: EsbuildHook = (options) => ({
  ...options,
  tsconfig: "./tsconfig.base.json",
});

/**
 * Per-build output directories. sonolus-cli writes its compiler outfile to
 * `<dev>/index.mjs` and the engine artifacts to `<dist>/`. Both default to
 * shared paths, so concurrent facet builds clobber each other (the tutorial
 * worker would import another facet's outfile and crash on the missing
 * `tutorialData`). The parallel orchestrator overrides these via env to give
 * each facet an isolated workspace; standalone builds keep the defaults.
 */
export const engineOutputPaths = {
  dev: process.env.SONOLUS_ENGINE_DEV ?? "./.dev",
  dist: process.env.SONOLUS_ENGINE_DIST ?? "./dist",
};
