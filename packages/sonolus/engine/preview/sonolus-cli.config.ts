import type { SonolusCLIConfig } from "@sonolus/sonolus.js";
import { engineEsbuild, engineOutputPaths } from "../esbuild.config.ts";

export default {
  type: "preview",
  esbuild: engineEsbuild,
  ...engineOutputPaths,
} satisfies SonolusCLIConfig;
