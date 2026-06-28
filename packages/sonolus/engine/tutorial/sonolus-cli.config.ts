import type { SonolusCLIConfig } from "@sonolus/sonolus.js";
import { engineEsbuild } from "../esbuild.config.ts";

export default {
  type: "tutorial",
  esbuild: engineEsbuild,
} satisfies SonolusCLIConfig;
