// L3 — GEB
// Input: Published HTML and its canonical path.
// Output: Search-only metadata and complete public Markdown records and buckets.
// Pos: [Map](L2-2.md); semantic document projection for frontend finalization.
// Effects/Dependencies: Parses public main content for Markdown and excludes page-data scripts.
import { searchCategory } from "../../src/lib/search-categories.ts";
import { stripDocumentVersion } from "../../src/lib/document-address.ts";
import { isSiteOrigin, CANONICAL_ORIGIN } from "../../src/lib/site-origin.ts";
import { isPublicReleaseServer } from "../../src/lib/temporary-public-routing.ts";
import { parse, parseFragment, serialize } from "parse5";

const plainText = (node) => (node.nodeName === "#text" ? node.value : (node.childNodes || []).map(plainText).join(""));
const compact = (text) => text.replace(/\s+/gu, " ").trim();
const SCRIPT_START = /<!--|<script\b[^>]*>/giu;
const SCRIPT_END = /<\/script\s*>/giu;
const JSON_TYPE = /\stype\s*=\s*(?:"application\/json"|'application\/json'|application\/json(?=[\s>]))/iu;

function withoutInlineJson(html) {
  const parts = [];
  let copied = 0;
  SCRIPT_START.lastIndex = 0;
  for (let match; (match = SCRIPT_START.exec(html));) {
    if (match[0] === "<!--") {
      const end = html.indexOf("-->", SCRIPT_START.lastIndex);
      if (end < 0) break;
      SCRIPT_START.lastIndex = end + 3;
      continue;
    }
    const headerEnd = SCRIPT_START.lastIndex;
    SCRIPT_END.lastIndex = headerEnd;
    const end = SCRIPT_END.exec(html);
    if (!end) break;
    SCRIPT_START.lastIndex = SCRIPT_END.lastIndex;
    if (!JSON_TYPE.test(match[0])) continue;
    parts.push(html.slice(copied, headerEnd), end[0]);
    copied = SCRIPT_END.lastIndex;
  }
  return copied ? parts.join("") + html.slice(copied) : html;
}
const escapeText = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
function documentTitle(html) {
  const opening = /<head\b[^>]*>/iu.exec(html);
  const end = opening ? html.indexOf("</head>", opening.index + opening[0].length) : -1;
  const head = parseFragment(opening && end >= 0 ? html.slice(opening.index + opening[0].length, end) : "");
  const pending = [...head.childNodes];
  for (const node of pending) {
    if (node.tagName === "meta") {
      const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
      if (attrs["data-pagefind-meta"] === "label[content]" && attrs.content?.trim()) return compact(attrs.content);
    }
    pending.push(...(node.childNodes || []));
  }
  const first = /<h1\b[^>]*>/iu.exec(html);
  const closing = first ? html.indexOf("</h1>", first.index + first[0].length) : -1;
  const heading = first && closing >= 0 ? html.slice(first.index, closing + 5) : "";
  return heading ? compact(plainText(parseFragment(heading))) : "";
}

export function assertPublicStaticDocumentPath(sourcePath) {
  const parts = sourcePath.split(/[\\/]/u);
  if (["provider-static", "playlist-static"].includes(parts[0])) return;
  const position = ["static-views", "asset-static"].includes(parts[0]) ? 1 : 0;
  if (/^(?:ja|en|ko|zh-CN|zh-TW)$/u.test(parts[position + 1] || "") && !isPublicReleaseServer(parts[position]))
    throw new Error("Static documents require a public release server");
}

/** Add search-only classification and title weighting without changing the served document. */
function searchMetadata(html, sourcePath) {
  assertPublicStaticDocumentPath(sourcePath);
  // Pagefind keeps script ids as anchors even when their text is excluded.
  if (/<html\b[^>]*\bdata-pagefind-ignore="all"/iu.test(html))
    return '<!doctype html><html data-pagefind-ignore="all"><head><title>haneoka</title></head><body></body></html>';
  html = withoutInlineJson(html);
  if (html.includes('data-content-view="full"')) {
    const fragment = parse(html);
    const prune = (node) => {
      if (!node.childNodes) return;
      node.childNodes = node.childNodes.filter(
        (child) => !child.attrs?.some(({ name, value }) => name === "data-content-view" && value === "full"),
      );
      node.childNodes.forEach(prune);
    };
    prune(fragment);
    html = serialize(fragment);
  }
  const prefix = sourcePath.split(/[\\/]/u)[0];
  const server = isPublicReleaseServer(prefix) ? prefix : "global";
  const category = searchCategory(sourcePath);
  const title = documentTitle(html);
  const metadata = `<meta data-pagefind-filter="server:${server}"><meta data-pagefind-filter="section:${category.section}"><meta data-pagefind-meta="kind:${category.kind}">`;
  const document = html.replace(/<head\b[^>]*>/iu, (tag) => `${tag}${metadata}`);
  if (!title) return document;
  const main = /<main\b[^>]*\bdata-pagefind-body[^>]*>/iu.exec(document);
  if (!main) return document;
  const from = main.index + main[0].length;
  const to = document.indexOf("</main>", from);
  if (to < 0) return document;
  const body = document.slice(from, to);
  for (const opening of body.matchAll(/<h([1-3])\b[^>]*>/giu)) {
    const end = body.indexOf(`</h${opening[1]}>`, opening.index + opening[0].length);
    if (end < 0 || compact(plainText(parseFragment(body.slice(opening.index, end + 5)))) !== title) continue;
    if (/\bdata-pagefind-weight\s*=/iu.test(opening[0])) return document;
    const at = from + opening.index + opening[0].length - 1;
    return `${document.slice(0, at)} data-pagefind-weight="8"${document.slice(at)}`;
  }
  // AppShell's title lives outside main. This copy exists only in the search index.
  return `${document.slice(0, from)}<h1 data-pagefind-weight="8">${escapeText(title)}</h1>${document.slice(from)}`;
}

export function withSearchMetadata(html, sourcePath) {
  const document = searchMetadata(html, sourcePath);
  const root = /<html\b[^>]*>/iu.exec(document);
  const head = /<head\b[^>]*>[\s\S]*?<\/head\s*>/iu.exec(document);
  const heading = /<h1\b[^>]*\bdata-pagefind-meta="title"[^>]*>[\s\S]*?<\/h1\s*>/iu.exec(document);
  const main = /<main\b[^>]*\bdata-pagefind-body[^>]*>/iu.exec(document);
  if (!root || !head || !main) return document;
  const end = document.indexOf("</main>", main.index + main[0].length);
  if (end < 0) return document;
  const shellHeading = heading && (heading.index < main.index || heading.index >= end + 7) ? heading : undefined;
  const regions = [
    { from: root.index, to: root.index + root[0].length },
    { from: head.index, to: head.index + head[0].length },
    { from: main.index, to: end + 7 },
    ...(shellHeading ? [{ from: shellHeading.index, to: shellHeading.index + shellHeading[0].length }] : []),
  ].sort((a, b) => a.from - b.from);
  let remainder = "",
    copied = 0;
  for (const region of regions) {
    remainder += document.slice(copied, region.from);
    copied = region.to;
  }
  remainder += document.slice(copied);
  if (/data-pagefind-(?:meta|filter|sort|body|weight)\b/iu.test(remainder)) return document;
  return `<!doctype html>${root[0]}${head[0]}<body>${shellHeading?.[0] || ""}${document.slice(main.index, end + 7)}</body></html>`;
}

const attrsOf = (node) => Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
const markdownEscape = (value) => value.replace(/([\\`*_[\]<>|])/gu, "\\$1");
const hasClass = (attrs, name) => (attrs.class || "").split(/\s+/u).includes(name);
const excludedBodyNode = (attrs) =>
  (attrs.hidden !== undefined && !hasClass(attrs, "md-accordion__panel")) ||
  attrs["aria-hidden"] === "true" || attrs.inert !== undefined || attrs.role === "dialog" ||
  attrs["data-content-view"] === "full" || attrs["data-pagefind-ignore"] === "all" ||
  /(?:^|\s)(?:browse__filters|browse__filter-group|detail-level-switch|story-transcript__media)(?:\s|$)/u.test(attrs.class || "");

function galleryImage(node) {
  if (node.tagName === "img") return attrsOf(node);
  for (const child of node.childNodes || []) {
    const image = galleryImage(child);
    if (image) return image;
  }
}

function semanticMain(html) {
  const opening = /<main\b[^>]*\bid="main-content"[^>]*>/iu.exec(html);
  if (!opening) return;
  const end = html.indexOf("</main>", opening.index + opening[0].length);
  if (end < 0) return;
  return parseFragment(withoutInlineJson(html.slice(opening.index, end + 7))).childNodes[0];
}
/** Render the public semantic document, including tables and collapsed detail sections, without UI or page-data scripts. */
export function markdownDocument(html, sourcePath) {
  const main = semanticMain(html);
  if (!main) return;
  const title = documentTitle(html);
  if (!title) return;
  const headingLevels = [];
  const collectHeadings = (node) => {
    if (excludedBodyNode(attrsOf(node))) return;
    if (/^h[1-6]$/u.test(node.tagName || "")) headingLevels.push(Number(node.tagName[1]));
    (node.childNodes || []).forEach(collectHeadings);
  };
  collectHeadings(main);
  const headingOffset = Math.max(0, (headingLevels.length ? Math.min(...headingLevels) : 2) - 2);
  const canonical = `${CANONICAL_ORIGIN}/${sourcePath.replace(/index\.html$/u, "")}`;
  const href = (value) => {
    if (!value || value.startsWith("#")) return "";
    try {
      const url = new URL(value, canonical);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return "";
      if (isSiteOrigin(url.origin)) {
        if (/^\/(?:_astro|api|entity-data|playback-data|provider-static|static-views)\//u.test(url.pathname)) return "";
        if (/^\/(?:assets|runtime|objects)\/(?:jp|intl)\//u.test(url.pathname)) {
          url.searchParams.delete("release");
          url.searchParams.delete("asset");
        } else stripDocumentVersion(url);
      }
      url.searchParams.delete("return");
      return url.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
    } catch {
      return "";
    }
  };
  const render = (node) => {
    if (node.nodeName === "#text") return markdownEscape(node.value.replace(/\s+/gu, " "));
    const tag = node.tagName;
    const attrs = attrsOf(node);
    if (
      [
        "script",
        "style",
        "svg",
        "input",
        "select",
        "textarea",
        "canvas",
        "dialog",
        "template",
        "noscript",
        "nav",
        "form",
        "menu",
      ].includes(tag) ||
      excludedBodyNode(attrs)
    )
      return "";
    const children = () => (node.childNodes || []).map(render).join("");
    if (tag === "button") {
      const label = hasClass(attrs, "md-accordion__trigger") && compact(children());
      return label ? `\n\n### ${label}\n\n` : "";
    }
    if (tag === "br") return "\n";
    if (tag === "image-gallery") {
      const image = galleryImage(node);
      const mirrored = /"(\/public-media\/[a-f0-9]{64}\.[a-z0-9]+)"/u.exec(image?.["data-candidates"] || "")?.[1];
      const source = href(mirrored || image?.["data-src"] || image?.src);
      return source ? `\n\n![${markdownEscape(image.alt || title)}](${source})\n\n` : "";
    }
    if (tag === "img") return markdownEscape(attrs.alt || "");
    if (tag === "time" && attrs.datetime) {
      const text = compact(children());
      return text && text !== attrs.datetime ? `${text} (${markdownEscape(attrs.datetime)})` : markdownEscape(attrs.datetime);
    }
    if (tag === "a") {
      const text = compact(children());
      const target = href(attrs.href);
      return text && target ? `[${text}](${target})` : text;
    }
    if (/^h[1-6]$/u.test(tag || "")) {
      const heading = compact(children());
      return heading && heading !== markdownEscape(title)
        ? `\n\n${"#".repeat(Math.max(2, Number(tag[1]) - headingOffset))} ${heading}\n\n`
        : "";
    }
    if (tag === "pre") return `\n\n\`\`\`\n${plainText(node).trim()}\n\`\`\`\n\n`;
    if (tag === "code") return `\`${plainText(node).replace(/`/gu, "\\`")}\``;
    if (["strong", "b", "em", "i"].includes(tag)) {
      const text = children().trim();
      const mark = tag === "strong" || tag === "b" ? "**" : "*";
      return text ? `${mark}${text}${mark}` : "";
    }
    if (tag === "table") {
      const rows = [];
      const collect = (parent) => {
        if (excludedBodyNode(attrsOf(parent))) return;
        if (parent.tagName === "tr")
          rows.push(
            (parent.childNodes || [])
              .filter((child) => ["td", "th"].includes(child.tagName) && !excludedBodyNode(attrsOf(child)))
              .map((cell) => compact(render(cell))),
          );
        else (parent.childNodes || []).forEach(collect);
      };
      collect(node);
      if (!rows.some((row) => row.some(Boolean))) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
      return `\n\n${line(rows[0])}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    if (tag === "li") return `\n- ${children().trim().replace(/\n/g, "\n  ")}\n`;
    if (tag === "dt") return `\n- **${compact(children())}**: `;
    if (tag === "dd") return `${children().trim()}\n`;
    if (tag === "hr") return "\n\n---\n\n";
    if (["audio", "video", "source"].includes(tag))
      return href(attrs.src) ? `\n\n[${tag}](${href(attrs.src)})\n\n` : children();
    const body = children();
    return [
      "p",
      "div",
      "section",
      "article",
      "header",
      "footer",
      "ul",
      "ol",
      "dl",
      "details",
      "summary",
      "blockquote",
    ].includes(tag)
      ? `\n\n${body.trim()}\n\n`
      : body;
  };
  const body = render(main)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+\n/gu, "\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!body) return;
  const language = /<html\b[^>]*\blang="([^"]+)"/iu.exec(html)?.[1];
  const metadata = { title, canonical, ...(language && { lang: language }) };
  const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  return { title, canonical, markdown: `---\n${frontmatter}\n---\n\n# ${markdownEscape(title)}\n\n${body}\n` };
}
