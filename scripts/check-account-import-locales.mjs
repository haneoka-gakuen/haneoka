import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const locales = ["en", "zh-CN", "zh-TW", "ja", "ko"];
const flatten = (value, prefix = "") =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return item && typeof item === "object" ? Object.entries(flatten(item, path)) : [[path, item]];
    }),
  );
const file = (locale) => `public/i18n/${locale}.json`;
const current = Object.fromEntries(
  locales.map((locale) => [locale, flatten(JSON.parse(fs.readFileSync(file(locale), "utf8")))]),
);
const baseIndex = process.argv.indexOf("--base");
const baseRef = baseIndex >= 0 ? process.argv[baseIndex + 1] : "HEAD";
if (!baseRef) throw new Error("--base requires a commit or ref");
const before = flatten(JSON.parse(execFileSync("git", ["show", `${baseRef}:${file("en")}`], { encoding: "utf8" })));
const keys = Object.keys(current.en).filter(
  (key) => key.startsWith("tools.teamBuilder.") && current.en[key] !== before[key],
);
assert(keys.length > 0);
const tokens = (text) => [...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();
for (const key of keys)
  for (const locale of locales) {
    const value = current[locale][key];
    assert(typeof value === "string" && value.trim(), `${locale}: ${key}`);
    assert.deepEqual(tokens(value), tokens(current.en[key]), `${locale}: ${key} placeholders`);
  }
console.log(`${keys.length} changed messages: all five locales and placeholders match`);
