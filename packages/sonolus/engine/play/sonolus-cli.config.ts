import { hash } from "@sonolus/core";
import type { SonolusCLIConfig } from "@sonolus/sonolus.js";
import { error, log } from "node:console";
import { copyFileSync, readFileSync } from "node:fs";
import { engineEsbuild } from "../esbuild.config.ts";

export default {
  type: "play",
  esbuild: engineEsbuild,

  devServer(sonolus) {
    try {
      copyFileSync("./shared/src/level/bgm.mp3", "./.dev/bgm.mp3");

      const level = sonolus.level.items[0];
      if (!level) throw new Error("No level is available for BGM setup");

      level.bgm = {
        hash: hash(readFileSync("./.dev/bgm.mp3")),
        url: "/bgm.mp3",
      };
    } catch {
      error("Error: failed to setup bgm, using fallback");
      log();
    }
  },
} satisfies SonolusCLIConfig;
