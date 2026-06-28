import type { SonolusCLIConfig } from "@sonolus/sonolus.js";
import { engineEsbuild } from "../esbuild.config.ts";

export default {
  type: "preview",
  esbuild: engineEsbuild,
} satisfies SonolusCLIConfig;
