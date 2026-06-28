import type { SonolusCLIConfig } from "@sonolus/sonolus.js";

type EsbuildHook = NonNullable<SonolusCLIConfig["esbuild"]>;

export const engineEsbuild: EsbuildHook = (options) => ({
  ...options,
  tsconfig: "./tsconfig.base.json",
});
