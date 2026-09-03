import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const proxyTarget = String(process.env.LOCAL_WORKER_ORIGIN || process.env.LOCAL_RELEASE_ORIGIN || "").trim();

export default defineConfig({
  site: "https://haneoka.org",
  output: "static",
  outDir: path.join(root, ".output/public"),
  publicDir: path.join(root, ".generated-public"),
  compressHTML: true,
  build: { inlineStylesheets: "auto" },
  vite: {
    build: {
      cssMinify: "lightningcss",
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/node_modules/three/") || id.includes("/node_modules/.pnpm/three@")) return "three-core";
            if (id.includes("/.dependencies/vega/")) return "vega-engine";
            if (id.includes("/.dependencies/vega-renderer-three/")) return "vega-three-renderer";
            if (id.includes("/.dependencies/vega-")) return "vega-runtime-plugins";
          },
        },
      },
    },
    resolve: { dedupe: ["lit"] },
    server: proxyTarget
      ? {
          proxy: {
            "/api": { target: proxyTarget, changeOrigin: true },
            "/assets": { target: proxyTarget, changeOrigin: true },
            "/objects": { target: proxyTarget, changeOrigin: true },
            "/runtime": { target: proxyTarget, changeOrigin: true },
            "/sonolus": { target: proxyTarget, changeOrigin: true },
          },
        }
      : undefined,
  },
});
