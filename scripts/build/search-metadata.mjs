import { searchCategory } from "../../src/lib/search-categories.ts";
import { isPublicReleaseServer } from "../../src/lib/temporary-public-routing.ts";
import { parse, parseFragment, serialize } from "parse5";
import { decodePageData } from "../../src/lib/page-data-codec.ts";

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
export function withSearchMetadata(html, sourcePath) {
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

const attrsOf = (node) => Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
const markdownEscape = (value) => value.replace(/([\\`*_[\]<>|])/gu, "\\$1");
const descendants = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of node.childNodes || []) {
    const found = descendants(child, predicate);
    if (found) return found;
  }
};
export function markdownPath(pathname) {
  return pathname === "/" ? "/index.md" : `${pathname.replace(/\/+$/u, "")}.md`;
}
/** Render the public semantic document, including tables and collapsed detail sections, without UI or page-data scripts. */
export function markdownDocument(html, sourcePath, readSeed) {
  const document = parse(withoutInlineJson(html));
  const main = descendants(document, (node) => node.tagName === "main" && attrsOf(node).id === "main-content");
  if (!main) return;
  const headingLevels = [];
  const collectHeadings = (node) => {
    if (attrsOf(node)["data-content-view"] === "full") return;
    if (/^h[1-6]$/u.test(node.tagName || "")) headingLevels.push(Number(node.tagName[1]));
    (node.childNodes || []).forEach(collectHeadings);
  };
  collectHeadings(main);
  const headingOffset = Math.max(0, Math.min(...headingLevels) - 2);
  const canonical = `https://haneoka.org/${sourcePath.replace(/index\.html$/u, "")}`;
  const href = (value) => {
    if (!value) return "";
    try {
      const url = new URL(value, canonical);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return "";
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
        "button",
        "input",
        "select",
        "textarea",
        "canvas",
        "dialog",
        "template",
        "noscript",
        "nav",
      ].includes(tag) ||
      attrs["aria-hidden"] === "true" ||
      attrs["data-content-view"] === "full"
    )
      return "";
    const children = () => (node.childNodes || []).map(render).join("");
    if (tag === "br") return "\n";
    if (tag === "img") return attrs.alt && href(attrs.src) ? `![${markdownEscape(attrs.alt)}](${href(attrs.src)})` : "";
    if (tag === "a") {
      const text = compact(children());
      return text && href(attrs.href) ? `[${text}](${href(attrs.href)})` : text;
    }
    if (/^h[1-6]$/u.test(tag || ""))
      return `\n\n${"#".repeat(Math.max(2, Number(tag[1]) - headingOffset))} ${compact(children())}\n\n`;
    if (tag === "pre") return `\n\n\`\`\`\n${plainText(node).trim()}\n\`\`\`\n\n`;
    if (tag === "code") return `\`${plainText(node).replace(/`/gu, "\\`")}\``;
    if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
    if (tag === "em" || tag === "i") return `*${children().trim()}*`;
    if (tag === "table") {
      const rows = [];
      const collect = (parent) => {
        if (parent.tagName === "tr")
          rows.push(
            (parent.childNodes || [])
              .filter((child) => ["td", "th"].includes(child.tagName))
              .map((cell) => compact(render(cell))),
          );
        else (parent.childNodes || []).forEach(collect);
      };
      collect(node);
      if (!rows.length) return "";
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
      ? `\n\n${body}\n\n`
      : body;
  };
  const title = documentTitle(html);
  const body = render(main)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+\n/gu, "\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^ +/gmu, "")
    .trim();
  const records = [];
  const seeds = new Set();
  const collectSeeds = (node) => {
    const id = attrsOf(node)["data-page-data"];
    if (id) seeds.add(id);
    (node.childNodes || []).forEach(collectSeeds);
  };
  if (/^(?:jp|intl)\/[^/]+\/[^/]+\/[^/]+\/index\.html$/u.test(sourcePath)) collectSeeds(main);
  for (const match of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu)) {
    const opening = match[0].slice(0, match[0].indexOf(">") + 1);
    const attrs = attrsOf(parseFragment(`${opening}</script>`).childNodes[0]);
    if (attrs.type !== "application/json" || !seeds.has(attrs.id)) continue;
    const raw = attrs["data-src"]
      ? readSeed?.(attrs["data-src"])
      : match[0].slice(opening.length, match[0].lastIndexOf("</script"));
    if (!raw) continue;
    const payload = decodePageData(JSON.parse(raw));
    const episode = payload?.schema === "haneoka-story-payload-v1" ? payload.episodes?.[payload.id] : undefined;
    const item =
      payload?.schema === "haneoka-entity-payload-v1"
        ? payload.item
        : episode
          ? Object.fromEntries(Object.entries(episode).filter(([key]) => key !== "commands" && key !== "assets"))
          : undefined;
    if (item)
      records.push({
        id: payload.id,
        server: payload.server,
        releaseId: payload.releaseId,
        ...(episode && {
          source: `https://haneoka.org/api/v1/servers/${payload.server}/catalog/stories/${encodeURIComponent(payload.id)}?release=${encodeURIComponent(payload.releaseId)}`,
        }),
        item,
      });
  }
  const data = records.length
    ? `\n## Structured data\n\n\`\`\`json\n${JSON.stringify(records.length === 1 ? records[0] : records, null, 2)}\n\`\`\`\n`
    : "";
  return { title, canonical, markdown: `# ${markdownEscape(title)}\n\n<${canonical}>\n\n${body}\n${data}` };
}
