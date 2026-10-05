#!/usr/bin/env node
import { withSearchMetadata } from "./search-metadata.mjs";
import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as pagefind from "pagefind";
import { parseFragment } from "parse5";
import { copyCalendarStaticAssets } from "./calendar-static-assets.mjs";

const output = path.resolve(".output/public");
const calendarImages = await copyCalendarStaticAssets({ outputRoot: output });
if (calendarImages) console.log(`finalized ${calendarImages} generated calendar images`);
// The Cubism declaration is useful to developers but is not a browser asset
// and is intentionally outside the runtime's exact production file set.
for (const relative of ["Core/CRI/live2dcubismmotionsynccore.d.ts"]) {
  const target = path.join(output, relative);
  if (existsSync(target)) unlinkSync(target);
}
console.log("finalized browser-only public output");

// Keep the complete document so Pagefind sees artwork/label metadata in head.
// Without a searchable main, Pagefind otherwise indexes the surrounding shell.
// robots=noindex pages (such as chart variants) also duplicate their entity.
function indexable(html) {
  if (!/<main\b[^>]*\bdata-pagefind-body(?:\s|=|>)/iu.test(html)) return false;
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu)?.[1] || "";
  for (const tag of head.match(/<meta\b(?=[^>]*\bname=["']?robots\b)[^>]*>/giu) || []) {
    const node = parseFragment(tag).childNodes[0];
    const name = node?.attrs?.find((attr) => attr.name === "name")?.value;
    if (name?.toLowerCase() !== "robots") continue;
    const content = node?.attrs?.find((attr) => attr.name === "content")?.value || "";
    if (content.split(/[\s,]+/u).some((directive) => directive.toLowerCase() === "noindex")) return false;
  }
  return true;
}

function withServerFilter(html, sourcePath) {
  return withSearchMetadata(html, sourcePath);
}

const files = readdirSync(output, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
  .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)));
let index;
try {
  const created = await pagefind.createIndex({
    excludeSelectors: ["script", "style", "button", "input", "select", "[aria-hidden=true]", ".audio-dock"],
  });
  index = created.index;
  if (created.errors.length || !index)
    throw new Error(`Search index initialization failed: ${created.errors.join("; ")}`);
  let cursor = 0;
  let indexed = 0;
  let failure;
  // Bound both HTML buffers and service requests while indexing many pages.
  const addPages = async () => {
    try {
      while (cursor < files.length && !failure) {
        const sourcePath = files[cursor++];
        if (sourcePath === "404.html") continue;
        const content = await readFile(path.join(output, sourcePath), "utf8");
        if (!indexable(content)) continue;
        const result = await index.addHTMLFile({ sourcePath, content: withServerFilter(content, sourcePath) });
        if (result.errors.length)
          throw new Error(`Search indexing failed for ${sourcePath}: ${result.errors.join("; ")}`);
        indexed += 1;
      }
    } catch (error) {
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: 4 }, addPages));
  if (failure) throw failure;
  if (!indexed) throw new Error("Search indexing found no searchable main pages");
  const indexOutput = path.join(output, "pagefind");
  // A repeated finalization must not retain removed pages or language shards.
  rmSync(indexOutput, { recursive: true, force: true });
  const written = await index.writeFiles({ outputPath: indexOutput });
  if (written.errors.length) throw new Error(`Search output failed: ${written.errors.join("; ")}`);
  console.log(`indexed ${indexed} main pages for global search (${files.length - indexed} excluded)`);
} finally {
  try {
    await index?.deleteIndex();
  } finally {
    await pagefind.close();
  }
}
