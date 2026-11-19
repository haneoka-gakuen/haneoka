/**
 * Social images: the site card, one card per navigation destination and the
 * localized navigation cards, rendered with local headless Chrome and committed
 * with src/config/social-cards.json. Documentation images are generated only
 * when explicitly requested with --docs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();
const chrome = process.env.CHROME || "google-chrome-stable";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "haneoka-social-"));
const LOCALES = ["en", "ja", "zh-TW", "zh-CN", "ko"];
const FONT = {
  ja: "Noto Sans JP Variable",
  "zh-TW": "Noto Sans TC Variable",
  "zh-CN": "Noto Sans SC Variable",
  ko: "Noto Sans KR Variable",
};
const interfaceOnly = process.argv.includes("--interface");
const latinFont = interfaceOnly ? "Roboto Variable" : "Roboto";
const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(fs.readFileSync(`public/i18n/${locale}.json`, "utf8"))]),
);
const label = (locale, key) =>
  key.split(".").reduce((value, part) => value?.[part], catalogs[locale]) ??
  key.split(".").reduce((value, part) => value?.[part], catalogs.en);
const socialLabels = JSON.parse(fs.readFileSync("src/config/interface-share.json", "utf8"));
const sprite = fs.readFileSync(".generated-public/icons.svg", "utf8");
const symbol = (name) =>
  new RegExp(`<symbol id="${name}-filled"[^>]*>[\\s\\S]*?</symbol>`)
    .exec(sprite)?.[0]
    ?.replace(`id="${name}-filled"`, `id="${name}"`) ??
  new RegExp(`<symbol id="${name}"[^>]*>[\\s\\S]*?</symbol>`).exec(sprite)?.[0];
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const file = (relative) => pathToFileURL(path.join(root, relative)).href;

const navigationBundle = path.join(work, "navigation.mjs");
await build({
  entryPoints: ["src/config/navigation.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: navigationBundle,
  logLevel: "silent",
});
const { NAV_SECTIONS } = await import(pathToFileURL(navigationBundle).href);

const C = {
  surface: "#fcf8fd",
  primary: "#555994",
  primaryContainer: "#e0e0ff",
  onPrimaryContainer: "#3d417b",
  secondaryContainer: "#e1e0f9",
  onSecondaryContainer: "#444559",
  tertiary: "#1c6773",
  tertiaryContainer: "#aaedfb",
  onTertiaryContainer: "#004e59",
  onSurface: "#1b1b1f",
  onSurfaceVariant: "#46464f",
  inversePrimary: "#bfc2ff",
  night: "#31356e",
};
const PALETTES = {
  primary: {
    hero: C.primary,
    icon: C.primaryContainer,
    backdrop: C.primaryContainer,
    accent: C.tertiaryContainer,
    chip: C.inversePrimary,
  },
  tertiary: {
    hero: C.tertiary,
    icon: C.tertiaryContainer,
    backdrop: "#d3f4fb",
    accent: C.primaryContainer,
    chip: C.tertiaryContainer,
  },
  night: {
    hero: C.night,
    icon: C.inversePrimary,
    backdrop: C.secondaryContainer,
    accent: C.tertiaryContainer,
    chip: C.inversePrimary,
  },
};
const SECTION_PALETTE = {
  home: "primary",
  library: "primary",
  stories: "night",
  tools: "tertiary",
  games: "tertiary",
  "anon-tokyo": "night",
  community: "night",
  mirrors: "tertiary",
  sekai: "tertiary",
};
const SHAPES = [
  [9, 0.085],
  [12, 0.06],
  [8, 0.11],
  [4, 0.17],
  [6, 0.12],
  [10, 0.08],
];

/** Material 3 Expressive shapes: a circle with smooth lobes (cookie, scallop, flower, clover). */
function radial(cx, cy, r, lobes, depth, rotate = 0) {
  const points = [];
  for (let i = 0; i < 720; i++) {
    const t = (i / 720) * Math.PI * 2;
    const radius = r * (1 - (depth * (1 - Math.cos(lobes * (t + rotate)))) / 2);
    points.push(`${(cx + radius * Math.cos(t)).toFixed(1)},${(cy + radius * Math.sin(t)).toFixed(1)}`);
  }
  return `M${points.join("L")}Z`;
}
const icon = (name, x, y, size, color) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" color="${color}"><use href="#${name}"/></svg>`;

function page({ width, height, icons, art, copy, extraCss = "" }) {
  const fonts = ["jp", "tc", "sc", "kr"]
    .map(
      (name) =>
        `<link rel="stylesheet" href="${file(`node_modules/@fontsource-variable/noto-sans-${name}/wght.css`)}">`,
    )
    .join("");
  const extendedFont = interfaceOnly
    ? `<link rel="stylesheet" href="${file("node_modules/@fontsource-variable/roboto/wght.css")}">`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">${fonts}${extendedFont}<style>
@font-face{font-family:Roboto;src:url("${file("node_modules/@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2")}") format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:${C.surface};font-family:'${latinFont}',sans-serif}
.art{position:absolute;inset:0}
.brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:650;color:${C.onSurface}}
.brand img{width:56px;height:56px}
h1{font-weight:800;color:${C.onSurface};line-height:.98;letter-spacing:-.03em}
h2{font-weight:650;color:${C.primary};letter-spacing:-.015em}
.names{list-style:none;padding:0;display:grid;gap:4px}
.names li{font-weight:550;color:${C.onSurfaceVariant};white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:10px}
.chip{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 16px 0 12px;border-radius:21px;background:${C.secondaryContainer};color:${C.onSecondaryContainer};font-size:18px;font-weight:600}
.chip svg{width:24px;height:24px;fill:currentColor}
${extraCss}
</style></head><body>
<svg width="0" height="0" style="position:absolute">${[...new Set(icons)].map(symbol).filter(Boolean).join("")}</svg>
<svg class="art" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${art}</svg>
${copy}
<script>
document.fonts.ready.then(() => {
  for (const node of document.querySelectorAll("[data-fit]")) {
    const [max, lines] = node.dataset.fit.split(",").map(Number);
    let size = max;
    node.style.fontSize = size + "px";
    while (size > 28 && (node.scrollWidth > node.clientWidth || node.getBoundingClientRect().height > size * 0.98 * lines + 2)) node.style.fontSize = (size -= 2) + "px";
  }
  document.body.dataset.ready = "";
});
</script></body></html>`;
}
const names = (values, size) =>
  `<ul class="names">${values.map(([locale, text]) => `<li lang="${locale}" style="font-family:'${FONT[locale] || latinFont}',sans-serif;font-size:${size}px;line-height:${size + 7}px">${escape(text)}</li>`).join("")}</ul>`;
const LOCALIZED_SITE = Object.fromEntries(
  ["ja", "zh-TW", "zh-CN", "ko"].map((locale) => [
    locale,
    label(locale, "common.seo.homeTitle").replace(/^BanG Dream! Our Notes\s*/u, ""),
  ]),
);
const FEATURES = [
  ["cards", "Cards"],
  ["music_note", "Songs"],
  ["graphic_eq", "Charts"],
  ["auto_stories", "Stories"],
  ["event", "Events"],
  ["emoji_events", "GEKISO Arena"],
  ["groups", "Team builder"],
];

function siteCard() {
  const hero = radial(905, 312, 212, 9, 0.085, Math.PI / 18);
  const art = `
<path d="${radial(930, 318, 372, 12, 0.05)}" fill="${C.primaryContainer}"/>
<path d="${radial(40, 640, 150, 6, 0.14)}" fill="${C.tertiaryContainer}" fill-opacity=".55"/>
<path d="${radial(1098, 112, 84, 4, 0.16, Math.PI / 4)}" fill="${C.tertiaryContainer}"/>
<path d="${radial(1108, 520, 80, 8, 0.11)}" fill="${C.primary}"/>
<rect x="652" y="420" width="150" height="150" rx="48" fill="${C.inversePrimary}" fill-opacity=".7"/>
<path d="${hero}" fill="${C.night}"/>
<image href="${file("public/favicon.svg")}" x="723" y="130" width="364" height="364"/>
<path d="${radial(700, 122, 70, 6, 0.14, Math.PI / 6)}" fill="${C.inversePrimary}"/>
${icon("music_note", 672, 94, 56, C.onPrimaryContainer)}${icon("emoji_events", 1064, 78, 68, C.onTertiaryContainer)}
${icon("cards", 693, 461, 68, C.onPrimaryContainer)}${icon("auto_stories", 1072, 484, 72, C.primaryContainer)}`;
  const copy = `<div style="position:absolute;left:64px;top:44px;width:560px">
<div class="brand"><img src="${file("public/favicon.svg")}" alt="">haneoka</div>
<h1 style="margin-top:26px;font-size:76px">BanG Dream!<br>Our Notes</h1>
<h2 style="margin-top:8px;font-size:40px">Database &amp; Viewer</h2>
<div style="margin-top:12px">${names(Object.entries(LOCALIZED_SITE), 19)}</div></div>
<div class="chips" style="position:absolute;left:64px;top:500px;width:580px">${FEATURES.map(([name, text]) => `<span class="chip"><svg viewBox="0 0 24 24"><use href="#${name}"/></svg>${text}</span>`).join("")}</div>`;
  return page({
    width: 1200,
    height: 630,
    icons: ["music_note", "emoji_events", "cards", "auto_stories", ...FEATURES.map(([name]) => name)],
    art,
    copy,
  });
}

const FEATURE_LABELS = [
  "navigation.cards",
  "navigation.songs",
  "navigation.chart",
  "navigation.stories",
  "navigation.events",
  "navigation.arena",
  "tools.teamBuilder.title",
];
const siteSubtitle = (locale) => label(locale, "common.seo.homeTitle").replace(/^BanG Dream! Our Notes\s*/u, "");
function localizedSiteCard(locale) {
  return siteCard()
    .replace("<html>", `<html lang="${locale}">`)
    .replace("Database &amp; Viewer", escape(siteSubtitle(locale)))
    .replace(
      `<div style="margin-top:12px">${names(Object.entries(LOCALIZED_SITE), 19)}</div>`,
      `<div style="margin-top:24px;font-size:24px;color:${C.onSurfaceVariant}">haneoka.org</div>`,
    )
    .replace(
      /<span class="chip">([\s\S]*?)<\/svg>[^<]*<\/span>/gu,
      (() => {
        let index = 0;
        return (_, image) =>
          `<span class="chip">${image}</svg>${escape(label(locale, FEATURE_LABELS[index++]))}</span>`;
      })(),
    )
    .replace("h2{font-weight", `h2{font-family:'${FONT[locale] || latinFont}',sans-serif;font-weight`);
}

function headerCard() {
  const art = `
<path d="${radial(1330, 240, 400, 12, 0.05)}" fill="${C.primaryContainer}"/>
<path d="${radial(1540, 70, 96, 4, 0.16, Math.PI / 4)}" fill="${C.tertiaryContainer}"/>
<path d="${radial(1520, 420, 86, 8, 0.11)}" fill="${C.primary}"/>
<path d="${radial(1300, 240, 196, 9, 0.085, Math.PI / 18)}" fill="${C.night}"/>
<image href="${file("public/favicon.svg")}" x="1132" y="72" width="336" height="336"/>
${icon("emoji_events", 1504, 34, 72, C.onTertiaryContainer)}${icon("auto_stories", 1484, 384, 72, C.primaryContainer)}`;
  const copy = `<div style="position:absolute;left:96px;top:64px;width:980px">
<div class="brand"><img src="${file("public/favicon.svg")}" alt="">haneoka</div>
<h1 style="margin-top:28px;font-size:84px">BanG Dream! Our Notes</h1>
<h2 style="margin-top:10px;font-size:44px">Database &amp; Viewer</h2>
<p style="margin-top:22px;display:flex;gap:8px 26px;flex-wrap:wrap;font-size:22px;font-weight:550;color:${C.onSurfaceVariant}">${Object.entries(
    LOCALIZED_SITE,
  )
    .map(([locale, text]) => `<span lang="${locale}" style="font-family:'${FONT[locale]}'">${escape(text)}</span>`)
    .join("")}</p></div>`;
  return page({ width: 1600, height: 480, icons: ["emoji_events", "auto_stories"], art, copy });
}

function sectionCard(entry, sectionId, index, locale) {
  const palette = PALETTES[SECTION_PALETTE[sectionId] || "primary"];
  const [lobes, depth] = SHAPES[index % SHAPES.length];
  const title = label(locale || "en", entry.label) || entry.route;
  const localized = ["ja", "zh-TW", "zh-CN", "ko"].map((locale) => [locale, label(locale, entry.label) || title]);
  const art = `
<path d="${radial(930, 318, 372, 12, 0.05, index)}" fill="${palette.backdrop}"/>
<path d="${radial(40, 640, 150, 6, 0.14)}" fill="${palette.accent}" fill-opacity=".55"/>
<path d="${radial(905, 312, 212, lobes, depth, Math.PI / 18)}" fill="${palette.hero}"/>
${icon(entry.icon, 785, 192, 240, palette.icon)}
<path d="${radial(1100, 118, 78, 4, 0.16, Math.PI / 4)}" fill="${palette.chip}"/>
<path d="${radial(1110, 528, 70, 8, 0.11)}" fill="${C.night}"/>
<image href="${file("public/favicon.svg")}" x="1050" y="468" width="120" height="120"/>`;
  const copy = `<div style="position:absolute;left:64px;top:44px;width:600px">
<div class="brand"><img src="${file("public/favicon.svg")}" alt="">haneoka</div>
<h1 data-fit="76,2" lang="${locale || "en"}" style="font-family:'${FONT[locale] || latinFont}',sans-serif;margin-top:34px;font-size:76px;width:600px">${escape(title)}</h1>
<h2 style="margin-top:12px;font-size:30px">BanG Dream! Our Notes</h2>
<div style="margin-top:18px">${locale ? names([[locale, siteSubtitle(locale)]], 24) : names(localized, 22)}</div>
${locale ? `<div style="margin-top:32px;font-size:24px;color:${C.onSurfaceVariant}">haneoka.org</div>` : ""}</div>`;
  return page({ width: 1200, height: 630, icons: [entry.icon], art, copy });
}

function render(html, width, height, output) {
  const source = path.join(work, `${crypto.randomUUID()}.html`);
  const shot = path.join(work, `${crypto.randomUUID()}.png`);
  fs.writeFileSync(source, html);
  execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=6000",
      `--screenshot=${shot}`,
      pathToFileURL(source).href,
    ],
    { stdio: "ignore" },
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync("python3", [
    "-c",
    "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').quantize(256,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).save(sys.argv[2],optimize=True)",
    shot,
    output,
  ]);
  return crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex").slice(0, 10);
}

async function interfacePreviews() {
  const localesBundle = path.join(work, "interface-options.mjs");
  await build({
    entryPoints: ["src/i18n/interface-language-options.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: localesBundle,
  });
  const { interfaceLanguages } = await import(pathToFileURL(localesBundle).href);
  const { outputFiles } = await build({
    stdin: {
      contents:
        'import { openInterfaceShare } from "./src/i18n/interface-share"; openInterfaceShare(document.documentElement.dataset.interface);',
      resolveDir: root,
    },
    bundle: true,
    minify: true,
    write: false,
    legalComments: "none",
  });
  const redirect = outputFiles[0].text.replaceAll("</script", "<\\/script");
  const attr = (value) => escape(value).replaceAll('"', "&quot;");
  let count = 0;
  for (const { value: locale, tag } of interfaceLanguages) {
    catalogs[locale] = JSON.parse(fs.readFileSync(`src/i18n/interface/${locale}.json`, "utf8"));
    let index = 0;
    for (const [id, entry] of Object.entries(socialLabels)) {
      const home = id === "home";
      const title = home
        ? label(locale, "common.seo.homeTitle")
        : `${label(locale, entry.key)} - ${label(locale, "common.seo.siteTitle")}`;
      const filename = `images/social/${locale}/${id}.png`;
      const image = home
        ? localizedSiteCard(locale)
        : sectionCard({ label: entry.key, icon: entry.icon }, entry.section, index++, locale);
      const digest = render(image, 1200, 630, `public/${filename}`);
      const src = attr(`https://haneoka.org/${filename}?v=${digest}`);
      const directory = `public/share-preview/${locale}/p-${id}`;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        `${directory}/index.html`,
        `<!doctype html>
<html lang="${tag}" data-interface="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>${escape(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="haneoka">
<meta property="og:locale" content="${tag.replace("-", "_")}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:image" content="${src}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${attr(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(title)}">
<meta name="twitter:image" content="${src}">
<script>${redirect}</script>
</head>
<body>
<h1>${escape(title)}</h1>
<a href="/en/">${escape(label(locale, "navigation.home"))}</a>
</body>
</html>
`,
      );
      count++;
    }
  }
  console.log(`rendered ${count} interface share previews`);
}
if (interfaceOnly) {
  try {
    await interfacePreviews();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  process.exit(0);
}

const manifest = {};
manifest["/"] = {};
for (const locale of LOCALES) {
  const name = `social/${locale}/home.png`;
  manifest["/"][locale] = `${name}?v=${render(localizedSiteCard(locale), 1200, 630, `public/images/${name}`)}`;
}
if (process.argv.includes("--docs")) {
  render(siteCard(), 1200, 630, "docs/assets/haneoka-social-card.png");
  render(headerCard(), 1600, 480, "docs/assets/haneoka-header.png");
  for (const [name, size] of [
    ["haneoka-social-card", [1200, 630]],
    ["haneoka-header", [1600, 480]],
  ]) {
    const data = fs.readFileSync(`docs/assets/${name}.png`).toString("base64");
    fs.writeFileSync(
      `docs/assets/${name}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}" height="${size[1]}" viewBox="0 0 ${size[0]} ${size[1]}" role="img" aria-label="haneoka"><image href="data:image/png;base64,${data}" width="${size[0]}" height="${size[1]}"/></svg>\n`,
    );
  }
}
let index = 0;
for (const section of NAV_SECTIONS)
  for (const entry of section.items) {
    if (!entry.icon || manifest[entry.route]) continue;
    const slug = entry.route.replace(/^\/+|\/+$/gu, "").replaceAll("/", "-") || "home";
    manifest[entry.route] = {};
    for (const locale of LOCALES) {
      const name = `social/${locale}/${slug}.png`;
      manifest[entry.route][locale] =
        `${name}?v=${render(sectionCard(entry, section.id, index, locale), 1200, 630, `public/images/${name}`)}`;
    }
    index++;
  }
fs.writeFileSync("src/config/social-cards.json", `${JSON.stringify(manifest, null, 2)}\n`);
fs.rmSync(work, { recursive: true, force: true });
console.log(`rendered ${Object.keys(manifest).length} social cards`);
