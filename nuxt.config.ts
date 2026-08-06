import { DEFAULT_ARCHIVE_LOCALE } from "./app/i18n/locales";
import { fileURLToPath } from "node:url";

const materializedDependencyWorkspace = fileURLToPath(new URL("./.dependencies", import.meta.url));

const configuredReleaseServers = [
  ...new Set(
    String(process.env.RELEASE_SERVERS || "jp-cbt,gl-cbt")
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean),
  ),
];
const preferredReleaseServer = String(process.env.RELEASE_SERVER || "").trim();
const defaultReleaseServer = preferredReleaseServer || "gl-cbt";
const siteOrigin = "https://haneoka.org";
const siteTitle = "haneoka";
const siteDescription = "A public resource archive, event dashboard, and community for BanG Dream! Our Notes.";
const socialImage = `${siteOrigin}/images/haneoka-social-card.png`;
const localBestdoriProviderOrigin = String(process.env.LOCAL_BESTDORI_PROVIDER_ORIGIN || "").trim();
const localReleaseOrigin = String(process.env.LOCAL_RELEASE_ORIGIN || "").trim();
const localWorkerOrigin = String(process.env.LOCAL_WORKER_ORIGIN || "").trim();
const localProxy = {
  // Keep the explicitly namespaced provider route ahead of the broader Garupa
  // API route. A Bestdori region must never be resolved as an Our Notes
  // release-server ID even in local development.
  ...(localBestdoriProviderOrigin
    ? {
        "/api/v1/garupa/bestdori": { target: localBestdoriProviderOrigin, changeOrigin: true },
      }
    : {}),
  ...(localWorkerOrigin
    ? {
        "/api/auth": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/account": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/admin": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/community": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/garupa": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/releases": { target: localWorkerOrigin, changeOrigin: true },
        "/api/v1/home": { target: localWorkerOrigin, changeOrigin: true },
      }
    : {}),
  ...(localReleaseOrigin
    ? {
        "/api": { target: localReleaseOrigin, changeOrigin: true },
        "/assets": { target: localReleaseOrigin, changeOrigin: true },
        "/objects": { target: localReleaseOrigin, changeOrigin: true },
        "/runtime": { target: localReleaseOrigin, changeOrigin: true },
        "/sonolus": { target: localReleaseOrigin, changeOrigin: true },
      }
    : {}),
};

export default defineNuxtConfig({
  compatibilityDate: "2026-02-14",
  devtools: { enabled: false },
  // Public content surfaces are server-rendered so the first paint arrives
  // with the HTML instead of waiting for the entry chunk to boot. Authenticated
  // and highly dynamic surfaces stay client-rendered via routeRules below;
  // unknown routes fall back to the generic SPA shell (200.html) served by the
  // Worker, so a direct refresh never hydrates a content page as the wrong route.
  ssr: true,
  components: [{ path: "~/components", pathPrefix: false }],
  imports: {
    transform: {
      // Linked dependency packages are already compiled ESM. Treating
      // their minified locals as Nuxt composables can inject colliding imports
      // (for example Vue's `h`) into otherwise valid library modules.
      exclude: [/[\\/]\.dependencies[\\/]/],
    },
  },
  vue: {
    compilerOptions: {
      isCustomElement: (tag) => tag.startsWith("md-"),
    },
  },
  css: [
    "@fontsource/material-symbols-rounded/400.css",
    "@haneoka/design-tokens/tokens.css",
    "@haneoka/ui/styles.css",
    "@haneoka/vega/styles.css",
    "~/assets/styles/main.css",
  ],
  app: {
    head: {
      htmlAttrs: { lang: DEFAULT_ARCHIVE_LOCALE },
      title: siteTitle,
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { name: "theme-color", content: "#31356e" },
        { name: "color-scheme", content: "light" },
        { name: "mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-status-bar-style", content: "default" },
        { name: "description", content: siteDescription },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "haneoka" },
        { property: "og:title", content: siteTitle },
        { property: "og:description", content: siteDescription },
        { property: "og:url", content: siteOrigin },
        { property: "og:image", content: socialImage },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: "haneoka shooting-star project banner" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: siteTitle },
        { name: "twitter:description", content: siteDescription },
        { name: "twitter:image", content: socialImage },
        { name: "twitter:image:alt", content: "haneoka shooting-star project banner" },
      ],
      link: [
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml", sizes: "any" },
        { rel: "icon", href: "/favicon.ico", sizes: "any" },
        { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
        { rel: "icon", href: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
    },
  },
  runtimeConfig: {
    public: {
      apiBase: "/api/v1",
      releaseServer: defaultReleaseServer,
      releaseServers: configuredReleaseServers,
      canonicalOrigin: siteOrigin,
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
    tsConfig: {
      compilerOptions: {
        noUncheckedIndexedAccess: false,
        strictPropertyInitialization: false,
      },
    },
  },
  routeRules: {
    // Authenticated and browser-only surfaces render client-side; their session
    // and catalog work must not run during SSR.
    "/account/**": { ssr: false },
    "/admin/**": { ssr: false },
    "/settings/**": { ssr: false },
    "/tools/**": { ssr: false },
    "/community/**": { ssr: false },
    // The asset explorer is a catch-all ([...path]) with an unbounded param
    // space, so it is client-rendered rather than prerendered per path.
    "/catalog/assets/**": { ssr: false },
  },
  nitro: {
    prerender: {
      // Prerender only the closed set of static public routes. Anything not
      // listed here is served from the generic SPA fallback (200.html), which
      // preserves the previous client-rendered behaviour for dynamic routes.
      crawlLinks: false,
      routes: [
        "/",
        "/about",
        "/privacy",
        "/terms",
        "/catalog",
        "/catalog/band-items",
        "/catalog/challenge",
        "/catalog/characters",
        "/catalog/circle",
        "/catalog/comics",
        "/catalog/events",
        "/catalog/exchange",
        "/catalog/gacha",
        "/catalog/help",
        "/catalog/items",
        "/catalog/live2d",
        "/catalog/login-campaigns",
        "/catalog/member-cards",
        "/catalog/shop",
        "/catalog/songs",
        "/catalog/stamps",
        "/catalog/stories",
        "/catalog/stories/afterlive",
        "/catalog/stories/band",
        "/catalog/stories/home",
        "/catalog/stories/link",
        "/catalog/stories/tutorial",
        "/catalog/support-cards",
      ],
    },
  },
  experimental: {
    // Route components and full-screen runtimes are loaded lazily. Reload once
    // immediately when any Vite preload fails, including failures outside the
    // router's own navigation promise. Nuxt guards this per path in session
    // storage, so a persistent edge error cannot cause a reload loop.
    emitRouteChunkError: "automatic-immediate",
    defaults: {
      // Homepage navigation exposes many application routes. Avoid competing
      // with the initial render by waiting for an explicit navigation intent.
      nuxtLink: { prefetch: false },
    },
  },
  vite: {
    resolve: {
      // The app links Vega and the UI package from independent workspaces.
      // Resolve their shared custom-element runtime once so Material Web
      // definitions and Lit decorators keep one browser identity.
      dedupe: ["vue", "@material/web", "lit", "lit-element", "lit-html", "@lit/reactive-element"],
    },
    server: {
      fs: {
        // Local development links the independently versioned dependency
        // packages from the sibling workspace. Published packages remain inside
        // node_modules and do not depend on this allowance.
        allow: [materializedDependencyWorkspace],
      },
      proxy: localProxy,
    },
    ssr: {
      // BBob's published ESM entrypoint imports "./render" without an
      // extension. Bundle it so Vite resolves that import during SSR builds.
      noExternal: ["@bbob/vue3"],
    },
    optimizeDeps: {
      include: [
        "@material/web/button/filled-button.js",
        "@material/web/button/filled-tonal-button.js",
        "@material/web/button/outlined-button.js",
        "@material/web/button/text-button.js",
        "@material/web/checkbox/checkbox.js",
        "@material/web/chips/filter-chip.js",
        "@material/web/dialog/dialog.js",
        "@material/web/focus/md-focus-ring.js",
        "@material/web/icon/icon.js",
        "@material/web/iconbutton/filled-tonal-icon-button.js",
        "@material/web/iconbutton/icon-button.js",
        "@material/web/list/list-item.js",
        "@material/web/list/list.js",
        "@material/web/labs/card/filled-card.js",
        "@material/web/progress/circular-progress.js",
        "@material/web/progress/linear-progress.js",
        "@material/web/labs/segmentedbutton/outlined-segmented-button.js",
        "@material/web/labs/segmentedbuttonset/outlined-segmented-button-set.js",
        "@material/web/radio/radio.js",
        "@material/web/ripple/ripple.js",
        "@material/web/select/outlined-select.js",
        "@material/web/select/select-option.js",
        "@material/web/slider/slider.js",
        "@material/web/switch/switch.js",
        "@material/web/tabs/primary-tab.js",
        "@material/web/tabs/tabs.js",
        "@material/web/textfield/outlined-text-field.js",
        "@vue-flow/background",
        "@vue-flow/controls",
        "@vue-flow/core",
        "@vue-flow/minimap",
        "@msgpack/msgpack",
        "@haneoka/vega-shell-default",
        "howler",
        "semver",
        "three",
      ],
      esbuildOptions: {
        // BBob 4.3.1 publishes one extensionless ESM re-export next to render.mjs.
        resolveExtensions: [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"],
      },
    },
    build: {
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/three/examples/jsm/")) return "three-extras";
            if (id.includes("/node_modules/three/")) return "three-core";
          },
        },
      },
    },
  },
});
