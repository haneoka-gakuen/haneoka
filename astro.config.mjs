// L3 — GEB
// Input: 构建／开发环境、工作区路径及静态输入身份。
// Output: Astro 静态输出、Vite、代理和构建 hooks 配置。
// Pos: [Map](L1.md)；前端构建组合入口。
// Effects/Dependencies: 写 build.json；冻结发布由响应注入更新基准，独立构建保留脚本基准；配置开发代理。
import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { finishStaticBuildInputs, resetStaticBuildInputErrors } from "./src/server/static-input-store.ts";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";
import { beginStaticDocumentsBuild } from "./src/server/static-documents.ts";
import { installProviderDevRouting } from "./src/server/provider-dev-routing.ts";
import { modelRenderCachePlugin } from "./scripts/build/model-render-cache.mjs";
import { staticBuildSourceIdentity } from "./src/server/static-build-identity.ts";
import { webBuildIdentity } from "./src/server/web-build-identity.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { searchForWorkspaceRoot } = await import(
  pathToFileURL(require.resolve("vite", { paths: [require.resolve("astro/package.json")] })).href
);
const linkedDirectories = ["node_modules", ".dependencies"]
  .map((name) => path.join(root, name))
  .filter(existsSync)
  .map((directory) => realpathSync(directory));
const workspaceFiles = [
  ...new Set([
    searchForWorkspaceRoot(root),
    ...linkedDirectories,
    ...linkedDirectories.map((directory) => searchForWorkspaceRoot(directory)),
  ]),
];
/** The deployment remains bound to its source commit; clients compare the Web input identity. */
const buildId = String(
  process.env.GITHUB_SHA || (process.env.STATIC_BUILD_INPUT_MODE ? staticBuildSourceIdentity(root).sha : Date.now()),
).slice(0, 12);
const webBuildId = webBuildIdentity(root, buildId);
const proxyTarget = String(process.env.LOCAL_WORKER_ORIGIN || process.env.LOCAL_RELEASE_ORIGIN || "").trim();
const providerTarget = String(process.env.BESTDORI_PROVIDER_ORIGIN || process.env.LOCAL_WORKER_ORIGIN || "").trim();
const localWorkerTarget = proxyTarget && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(proxyTarget).hostname);
const resourceProxy = {
  target: proxyTarget,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (request) => {
      const allowed = new Set(["host", "accept", "if-none-match", "if-range", "range", "cookie", "authorization"]);
      for (const name of Object.keys(request.getHeaders())) {
        if (!allowed.has(name.toLowerCase())) request.removeHeader(name);
      }
    });
  },
};
let devAssetRoutes = false;
let buildStarted = 0;

export default defineConfig({
  site: "https://haneoka.org",
  output: "static",
  outDir: path.join(root, ".output/public"),
  publicDir: path.join(root, ".generated-public"),
  compressHTML: true,
  // View-transition navigations prefetch the next document while the pointer
  // is still on the link — on a high-latency link that head start is most of
  // the perceived page load.
  prefetch: true,
  build: { inlineStylesheets: "auto" },
  integrations: [
    {
      name: "workspace-cache",
      hooks: {
        "astro:build:start": () => {
          buildStarted = performance.now();
          resetStaticBuildInputErrors();
          beginStaticDocumentsBuild();
        },
        "astro:build:setup": ({ target, updateConfig }) => {
          if (target === "server") updateConfig({ plugins: [modelRenderCachePlugin(root)] });
        },
        "astro:server:setup": ({ server }) => installProviderDevRouting(server),
        "astro:config:setup": ({ command, updateConfig }) => {
          devAssetRoutes = command === "dev";
          updateConfig({ vite: { cacheDir: path.join(root, ".astro/vite", command) } });
        },
        "astro:route:setup": ({ route }) => {
          if (devAssetRoutes && [
            "src/pages/asset-static/[server]/[locale]/[...id].astro",
            "src/pages/[locale]/community/charts/[id].astro",
          ].includes(route.component))
            route.prerender = false;
        },
      },
    },
    {
      name: "build-id",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await finishStaticBuildInputs();
          await writeFile(new URL("build.json", dir), JSON.stringify({ id: buildId, web: webBuildId }));
          console.log(
            JSON.stringify({
              stage: "astro-static-build",
              phase: process.env.STATIC_BUILD_PHASE || "render",
              locale: process.env.STATIC_BUILD_LOCALE || "all",
              partition: process.env.STATIC_BUILD_PARTITION || "all",
              elapsedMs: performance.now() - buildStarted,
              peakRssKb: process.resourceUsage().maxRSS,
              cpus: availableParallelism(),
              memoryBytes: totalmem(),
            }),
          );
        },
      },
    },
  ],
  vite: {
    define: { __WEB_BUILD_ID__: JSON.stringify(process.env.STATIC_BUILD_INPUT_MODE === "frozen" ? "" : webBuildId) },
    worker: { format: "es" },
    build: {
      cssMinify: "lightningcss",
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            // The hydration hook must run before the separate LitElement module.
            if (id.includes("/node_modules/lit-html/")) return "lit-html";
            // Rollup pulls a manual chunk's unassigned dependencies into it.
            // The dynamic-import preload helper is such a dependency of the
            // flowchart, and every lazy import site on the site references
            // it, so leaving it unassigned made each page statically load
            // the flowchart and, through it, three and the Vega renderer.
            if (id.includes("vite/preload-helper") || id.includes("vite/modulepreload-polyfill"))
              return "preload-helper";
            if (id.includes("/.dependencies/vega-shell-default/dist/flowchart-")) return "vega-flowchart";
            if (id.includes("/node_modules/three/") || id.includes("/node_modules/.pnpm/three@")) return "three-core";
            if (id.includes("/.dependencies/vega/packages/protocol/")) return "vega-protocol";
            if (id.includes("/.dependencies/vega-renderer-three/")) return "vega-three-renderer";
          },
        },
      },
    },
    resolve: { dedupe: ["lit"] },
    server: {
      fs: { allow: workspaceFiles },
      watch: { ignored: ["**/data/**", "**/tmp/**", "**/.output/**", "**/.dependencies/**/target/**"] },
      ...(proxyTarget || providerTarget
        ? {
            proxy: {
              ...(providerTarget
                ? {
                    "^/api/v1/(?:garupa/bestdori|sekai)(?:/|$)": {
                      target: providerTarget,
                      changeOrigin: true,
                      configure(proxy) {
                        proxy.on("proxyReq", (request) => {
                          // Match preview.ts's public provider allowlist, plus the target Host.
                          const allowed = new Set(["host", "accept", "if-none-match", "if-range", "range"]);
                          for (const name of Object.keys(request.getHeaders())) {
                            if (!allowed.has(name.toLowerCase())) request.removeHeader(name);
                          }
                        });
                      },
                    },
                  }
                : {}),
              ...(proxyTarget
                ? {
                    "^/api/v1/(?:servers(?:/|$)|announcements/media/)": resourceProxy,
                    "/api": { target: proxyTarget, changeOrigin: !localWorkerTarget },
                    "/assets": resourceProxy,
                    "/objects": resourceProxy,
                    "/runtime": resourceProxy,
                    "/sonolus": { target: proxyTarget, changeOrigin: true },
                  }
                : {}),
            },
          }
        : {}),
    },
  },
});
