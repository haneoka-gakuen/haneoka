import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Astro emits each page's hoisted scripts as <script type="module" src>, but
 * no modulepreload hints for their static imports: the browser discovers the
 * shared chunks (lit, i18n client, catalog helpers, ...) only after each entry
 * has downloaded and parsed, one network round trip per import level. This
 * pass lists every entry's static import closure as modulepreload links in the
 * document head, so the whole graph downloads in parallel with the entries.
 * Dynamic imports (editors, viewers, dialogs) stay lazy.
 */

// Minified Vite output: import"./a.js"  import{a as b}from"./a.js"  export{a}from"./a.js"
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'`();]*?\bfrom\s*)?["'](\.{1,2}\/[^"'`]+?\.js|\/_astro\/[^"'`]+?\.js)["']/gu;
const ENTRY = /<script\b[^>]*\btype=["']?module["']?[^>]*\bsrc=["'](\/_astro\/[^"']+?\.js)["'][^>]*>/giu;
const EXISTING = /<link\b[^>]*\brel=["']?modulepreload["']?[^>]*\bhref=["']([^"']+)["'][^>]*>/giu;

export function staticImports(source, publicPath) {
  const imports = new Set();
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1];
    imports.add(specifier.startsWith("/") ? specifier : path.posix.join(path.posix.dirname(publicPath), specifier));
  }
  return [...imports];
}

export function createModuleGraph(outputRoot) {
  const imports = new Map();
  const read = (publicPath) => {
    let pending = imports.get(publicPath);
    if (!pending) {
      pending = readFile(path.join(outputRoot, publicPath), "utf8")
        .then((source) => staticImports(source, publicPath))
        .catch(() => []);
      imports.set(publicPath, pending);
    }
    return pending;
  };
  const closures = new Map();
  /** Every module an entry statically needs, in breadth-first (discovery) order. */
  return (entry) => {
    let closure = closures.get(entry);
    if (!closure) {
      closure = (async () => {
        const seen = new Set([entry]);
        const order = [];
        for (let level = [entry]; level.length;) {
          const next = [];
          for (const dependencies of await Promise.all(level.map(read)))
            for (const dependency of dependencies)
              if (!seen.has(dependency)) {
                seen.add(dependency);
                order.push(dependency);
                next.push(dependency);
              }
          level = next;
        }
        return order;
      })();
      closures.set(entry, closure);
    }
    return closure;
  };
}

/** The document with modulepreload links for its entries' static imports; unchanged when none apply. */
export async function withModulePreloads(html, closureOf) {
  const head = html.search(/<\/head\s*>/iu);
  if (head < 0) return html;
  const entries = [...html.matchAll(ENTRY)].map((match) => match[1]);
  if (!entries.length) return html;
  const present = new Set([...entries, ...[...html.matchAll(EXISTING)].map((match) => match[1])]);
  const links = [];
  for (const closure of await Promise.all(entries.map(closureOf)))
    for (const dependency of closure)
      if (!present.has(dependency)) {
        present.add(dependency);
        links.push(`<link rel="modulepreload" href="${dependency}">`);
      }
  return links.length ? `${html.slice(0, head)}${links.join("")}${html.slice(head)}` : html;
}

/** Rewrite every listed HTML file (paths relative to outputRoot) in place. */
export async function addModulePreloads(outputRoot, files) {
  const closureOf = createModuleGraph(outputRoot);
  let changed = 0;
  let cursor = 0;
  const work = async () => {
    while (cursor < files.length) {
      const file = path.join(outputRoot, files[cursor++]);
      const html = await readFile(file, "utf8");
      const next = await withModulePreloads(html, closureOf);
      if (next !== html) {
        await writeFile(file, next);
        changed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, work));
  return changed;
}
