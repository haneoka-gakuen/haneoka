#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicSource = path.join(root, "public");
const staging = path.join(root, ".generated-public");
const output = path.join(staging, "fonts");
const families = {
  roboto: "@fontsource-variable/roboto",
  en: "@fontsource-variable/noto-sans",
  ja: "@fontsource-variable/noto-sans-jp",
  "zh-TW": "@fontsource-variable/noto-sans-tc",
  "zh-CN": "@fontsource-variable/noto-sans-sc",
  ko: "@fontsource-variable/noto-sans-kr",
};

rmSync(staging, { recursive: true, force: true });
cpSync(publicSource, staging, { recursive: true });
mkdirSync(output, { recursive: true });
for (const [locale, dependency] of Object.entries(families)) {
  const source = path.dirname(require.resolve(`${dependency}/package.json`));
  const target = path.join(output, locale);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(source, "files"), path.join(target, "files"), { recursive: true });
  const css = readFileSync(path.join(source, "wght.css"), "utf8").replaceAll(
    "font-display: swap",
    "font-display: optional",
  );
  writeFileSync(path.join(target, "font.css"), css);
}
console.log("staged public assets with locale-split Fontsource packages");
