import { searchCategory } from "../../src/lib/search-categories.ts";
import { parseFragment } from "parse5";

const plainText = (node) => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(plainText).join("");
const compact = (text) => text.replace(/\s+/gu, " ").trim();
const escapeText = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
function documentTitle(html) {
  const head = parseFragment(html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu)?.[1] || "");
  const pending = [...head.childNodes];
  for (const node of pending) {
    if (node.tagName === "meta") {
      const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
      if (attrs["data-pagefind-meta"] === "label[content]" && attrs.content?.trim()) return compact(attrs.content);
    }
    pending.push(...(node.childNodes || []));
  }
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/iu)?.[0];
  return heading ? compact(plainText(parseFragment(heading))) : "";
}

/** Add search-only classification and title weighting without changing the served document. */
export function withSearchMetadata(html, sourcePath) {
  const prefix = sourcePath.split(/[\\/]/u)[0];
  const server = ["jp", "intl", "intl-test", "jp-cbt", "intl-cbt"].includes(prefix) ? prefix : "global";
  const category = searchCategory(sourcePath);
  const title = documentTitle(html);
  const metadata = `<meta data-pagefind-filter="server:${server}"><meta data-pagefind-filter="section:${category.section}"><meta data-pagefind-meta="kind:${category.kind}">`;
  return html.replace(/<head\b[^>]*>/iu, (tag) => `${tag}${metadata}`)
    .replace(/(<main\b[^>]*\bdata-pagefind-body[^>]*>)([\s\S]*?)(<\/main\s*>)/iu,
      (_match, opening, body, closing) => {
        if (!title) return opening + body + closing;
        let matched = false;
        const weighted = body.replace(/<h([1-3])\b[^>]*>[\s\S]*?<\/h\1\s*>/giu, (heading) => {
          if (matched || compact(plainText(parseFragment(heading))) !== title) return heading;
          matched = true;
          return heading.replace(/<h[1-3]\b[^>]*>/iu, (tag) => /\bdata-pagefind-weight\s*=/iu.test(tag)
            ? tag : `${tag.slice(0, -1)} data-pagefind-weight="8">`);
        });
        // AppShell's title lives outside main. This copy exists only in the search index.
        return opening + (matched ? "" : `<h1 data-pagefind-weight="8">${escapeText(title)}</h1>`) + weighted + closing;
      });
}
