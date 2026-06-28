import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => resolve(packageRoot, "src", file);
const legalBanner = `/*!
 * Includes modified Live2D Cubism Web Framework code.
 * Copyright(c) Live2D Inc. All rights reserved.
 * Governed by the Live2D Open Software License in CUBISM-LICENSE.md.
 * Other package licensing and redistribution limits are described in LICENSE.
 */`;

export default defineConfig({
  // This package is consumed from other applications. Asset URLs must remain
  // relative to the emitted module instead of resolving against a host's root.
  base: "./",
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("md-") } } })],
  build: {
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: source("index.ts"),
        runtime: source("runtime-entry.ts"),
        viewer: source("viewer-entry.ts"),
        vue: source("vue-entry.ts"),
        "vue-controls": source("vue-controls-entry.ts"),
        "vue-player": source("vue-player-entry.ts"),
        "vue-text": source("vue-text-entry.ts"),
      },
      external: [/^@material\/web(?:\/|$)/, "howler", "three", "vue"],
      preserveEntrySignatures: "strict",
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css")) ? "styles.css" : "assets/[name]-[hash][extname]",
        banner: legalBanner,
        entryFileNames: "[name].js",
        format: "es",
        preserveModules: true,
        preserveModulesRoot: resolve(packageRoot, "src"),
      },
    },
    minify: false,
    sourcemap: true,
    target: "es2022",
  },
});
