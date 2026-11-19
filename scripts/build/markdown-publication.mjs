// L3 — GEB
// Input: Markdown rendered from proven public HTML.
// Output: Direct Markdown routes, small locale indexes and static entity shards.
// Pos: [Map](L2-2.md); public document discovery and storage.
// Effects/Dependencies: Stages rendered text and writes deployment assets.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CANONICAL_ORIGIN } from "../../src/lib/site-origin.ts";
import { markdownPath, markdownShardPath } from "../../src/lib/markdown-document.ts";

const locales = ["en", "ja", "ko", "zh-CN", "zh-TW"];
const targets = ["jp", "intl"];
const MAX_SHARD_BYTES = 256 * 1024;
const link = (title, pathname) =>
  `- [${title.replace(/[\[\]\\]/gu, "\\$&").replace(/\s+/gu, " ")}](${CANONICAL_ORIGIN}${pathname})`;
const label = (segment) => segment.replace(/-/gu, " ").replace(/^./u, (letter) => letter.toUpperCase());
const entryLink = ({ title, pathname }) => link(title, pathname);

export function stageMarkdownDocument(staging, entries, sourcePath, document) {
  const canonicalPath = new URL(document.canonical).pathname;
  const pathname = markdownPath(canonicalPath);
  const parts = sourcePath.split("/");
  const prefix = parts.splice(0, targets.includes(parts[0]) ? 2 : 1).join("/");
  const section = parts[0] === "index.html" ? "" : parts[0];
  const file = path.join(staging, `${entries.length}.md`);
  writeFileSync(file, document.markdown);
  entries.push({ canonicalPath, pathname, prefix, section, title: document.title, file });
  return `<link rel="alternate" type="text/markdown" href="${pathname}"><link rel="describedby" href="/${prefix}/llms.txt">`;
}

export function publishMarkdownDocuments(output, staging, entries) {
  entries.sort((a, b) => a.pathname.localeCompare(b.pathname, "en"));
  const paths = new Map(entries.map(({ canonicalPath, pathname }) => [canonicalPath, pathname]));
  const shards = new Map();
  const write = (pathname, content) => {
    const file = path.join(output, pathname.slice(1));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const links = /\]\(https:\/\/haneoka\.org(\/[^()?#\s]*)\)/gu;
  const read = (entry) =>
    readFileSync(entry.file, "utf8").replace(links, (value, pathname) => {
      const target = paths.get(pathname.endsWith("/") ? pathname : `${pathname}/`);
      return target ? `](${CANONICAL_ORIGIN}${target})` : value;
    });
  for (const entry of entries) {
    const shard = markdownShardPath(entry.pathname);
    if (shard) {
      if (!shards.has(shard)) shards.set(shard, []);
      shards.get(shard).push(entry);
      rmSync(path.join(output, entry.pathname.slice(1)), { force: true });
    } else write(entry.pathname, read(entry));
  }
  let packed = 0;
  for (const [pathname, documents] of shards) {
    const parts = documents.map((entry) => [entry.pathname, read(entry)]);
    const shard = JSON.stringify(Object.fromEntries(parts));
    if (Buffer.byteLength(shard) <= MAX_SHARD_BYTES) {
      write(pathname, shard);
      packed++;
    } else for (const [target, markdown] of parts) write(target, markdown);
  }
  rmSync(staging, { recursive: true, force: true });

  for (const [prefix, documents] of Map.groupBy(entries, (entry) => entry.prefix)) {
    documents.sort((a, b) => a.title.localeCompare(b.title, prefix.split("/").at(-1)));
    const sections = [];
    for (const [section, pages] of Map.groupBy(documents, (entry) => entry.section)) {
      const overview = pages.find((entry) => entry.canonicalPath === `/${prefix}/${section ? `${section}/` : ""}`);
      if (overview) sections.push(entryLink(overview));
      const details = pages.filter((entry) => entry !== overview);
      if (!details.length) continue;
      const pathname = `/${prefix}/${section}/llms.txt`;
      const title = overview?.title || label(section);
      write(pathname, `# ${title}\n\n${details.map(entryLink).join("\n")}\n`);
      sections.push(`${link(title, pathname)}: ${details.length}`);
    }
    write(`/${prefix}/llms.txt`, `# haneoka\n\n> BanG Dream! Our Notes\n\n## Catalogs\n\n${sections.join("\n")}\n`);
  }

  const languageLink = (locale, prefix) =>
    link(new Intl.DisplayNames([locale], { type: "language" }).of(locale), `/${prefix}llms.txt`);
  write("/llms.txt", [
    "# haneoka",
    "> Unofficial BanG Dream! Our Notes database. Read public character profiles, cards, songs, events, gacha and stories in Markdown.",
    "Each document gives the canonical web address. Start with a catalog to find individual entries.",
    ...targets.map((server) => `## ${server === "jp" ? "Japan" : "International"}\n\n${locales.map((locale) => languageLink(locale, `${server}/${locale}/`)).join("\n")}`),
    `## Site guides\n\n${locales.map((locale) => languageLink(locale, `${locale}/`)).join("\n")}`,
  ].join("\n\n") + "\n");
  return packed;
}
