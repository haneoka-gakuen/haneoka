import type { SonolusCLIConfig } from "@sonolus/sonolus.js";
import { engineEsbuild, engineOutputPaths } from "../esbuild.config.ts";

export default {
  type: "tutorial",
  esbuild: engineEsbuild,
  ...engineOutputPaths,
} satisfies SonolusCLIConfig;
