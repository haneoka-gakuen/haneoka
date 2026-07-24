import { DEFAULT_ARCHIVE_LOCALE } from "./app/i18n/locales";

const configuredReleaseServers = [
  ...new Set(
    String(process.env.RELEASE_SERVERS || "jp-cbt")
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean),
  ),
];
const preferredReleaseServer = String(process.env.RELEASE_SERVER || "").trim();
const defaultReleaseServer = preferredReleaseServer || configuredReleaseServers[0] || "jp-cbt";
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
  // The Worker falls back to the root static entry for client-side routes.
  // Keep this application as an SPA so a direct refresh derives the route
  // from the browser URL instead of hydrating the fallback page as home.
  ssr: false,
  components: [{ path: "~/components", pathPrefix: false }],
  vue: {
    compilerOptions: {
      isCustomElement: (tag) => tag.startsWith("md-"),
    },
  },
  css: [
    "@fontsource/material-symbols-rounded/400.css",
    "@haneoka/design-tokens/tokens.css",
    "@haneoka/ui/styles.css",
    "@haneoka/story/styles.css",
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
  nitro: {
    prerender: { routes: ["/", "/privacy", "/terms"] },
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
    server: {
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
