// L3 — GEB
// Input: Vega website stage, locale catalogs and provisioned Cubism lock inputs.
// Output: A self-contained playback directory for App distribution.
// Pos: [Map](L2-2.md); offline player package build.
// Effects/Dependencies: Verifies licensed files, compiles web assets and writes .output/offline-story-player.
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".output/offline-story-player");
const require = createRequire(import.meta.url);
const uiFonts = ["roboto", "noto-sans", "noto-sans-jp", "noto-sans-sc", "noto-sans-tc", "noto-sans-kr"];
execFileSync(process.execPath, ["scripts/cubism-runtime.mjs", "verify"], {
  cwd: root, stdio: "inherit", env: { ...process.env, HANEOKA_CUBISM_RUNTIME_POLICY: "required" },
});
await rm(output, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { player: "src/offline-story-player/player.ts" },
  outdir: output,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: ["chrome108", "safari16.4", "firefox121"],
  define: { "import.meta.env.SSR": "false", "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
  plugins: [{
    name: "root-public-assets",
    setup(context) {
      context.onResolve({ filter: /^\/(?:fonts|icons|images|basis|assets|runtime)\//u }, (args) => (
        args.kind === "url-token" ? { path: args.path, external: true } : undefined
      ));
      context.onResolve({ filter: /^@fontsource-variable\/[^/]+\/wght\.css\?url$/u }, (args) => ({
        path: args.path.split("/")[1],
        namespace: "ui-font-url",
      }));
      context.onLoad({ filter: /.*/, namespace: "ui-font-url" }, ({ path }) => {
        if (!uiFonts.includes(path)) throw new Error(`Unknown offline UI font ${path}`);
        return { contents: `export default "/fonts/${path}/wght.css";` };
      });
    },
  }],
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".woff2": "dataurl" },
});

const lock = JSON.parse(await readFile(join(root, "config/cubism-runtime.lock.json"), "utf8"));
const files = [
  ["src/offline-story-player/index.html", "index.html"],
  ["public/icons.svg", "icons.svg"],
  ...["en", "ja", "ko", "zh-CN", "zh-TW"].map((locale) => [`public/i18n/${locale}.json`, `i18n/${locale}.json`]),
  ...lock.files.filter(({ output }) => output).map(({ target, output }) => [target, output]),
  ...["haneoka-mpl-2.0.txt", "open-source-ui.txt", "spine-runtimes-license.txt", "fonts.txt"].map((file) => [
    `public/licenses/${file}`, `licenses/${file}`,
  ]),
];
await Promise.all(files.map(async ([source, key]) => {
  const path = join(output, key);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(join(root, source), path);
}));

await mkdir(join(output, "assets"), { recursive: true });
await Promise.all([
  cp(join(root, ".dependencies/vega/dist/assets"), join(output, "assets"), { recursive: true }),
  cp(join(root, ".dependencies/vega-theme-haneoka/assets"), join(output, "assets"), { recursive: true }),
  cp(join(root, "public/basis"), join(output, "basis"), { recursive: true }),
]);

await Promise.all(uiFonts.map(async (family) => {
  const source = require.resolve(`@fontsource-variable/${family}/wght.css`);
  const directory = join(output, "fonts", family);
  await mkdir(join(directory, "files"), { recursive: true });
  const css = await readFile(source, "utf8");
  const subsets = new Set([...css.matchAll(/url\(\.\/files\/([^()]+)\)/gu)].map((entry) => entry[1]));
  await Promise.all([
    copyFile(source, join(directory, "wght.css")),
    copyFile(join(dirname(source), "LICENSE"), join(directory, "LICENSE")),
    ...[...subsets].map((name) => copyFile(join(dirname(source), "files", name), join(directory, "files", name))),
  ]);
}));
