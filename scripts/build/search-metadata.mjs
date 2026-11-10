import { searchCategory } from "../../src/lib/search-categories.ts";
import { isPublicReleaseServer } from "../../src/lib/temporary-public-routing.ts";
import { parse, parseFragment, serialize } from "parse5";

const plainText = (node) => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(plainText).join("");
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
  if (/<html\b[^>]*\bdata-pagefind-ignore="all"/iu.test(html)) return '<!doctype html><html data-pagefind-ignore="all"><head><title>haneoka</title></head><body></body></html>';
  html = withoutInlineJson(html);
  if (html.includes('data-content-view="full"')) {
    const fragment = parse(html);
    const prune = (node) => {
      if (!node.childNodes) return;
      node.childNodes = node.childNodes.filter((child) => !child.attrs?.some(({ name, value }) => name === "data-content-view" && value === "full"));
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
