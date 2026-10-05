import { parse } from "@bbob/parser";
import type { JSONContent } from "@tiptap/core";
import { validStickerToken } from "./community-sticker-token";
export { validStickerToken } from "./community-sticker-token";

type Tag = { tag: string; attrs: Record<string, unknown>; content: Tree[] };
type Tree = string | Tag;
const tags = [
  "b",
  "i",
  "u",
  "s",
  "quote",
  "code",
  "spoiler",
  "list",
  "*",
  "li",
  "url",
  "sticker",
  "h2",
  "h3",
  "h4",
  "align",
  "highlight",
  "hr",
];
const blockTags = new Set(["quote", "code", "spoiler", "list", "li", "h2", "h3", "h4", "align", "hr"]);
export const escapeMarkup = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const safeCommunityLink = (value: string): string => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};
const attribute = (node: Tag) => String(Object.values(node.attrs)[0] || "");
const tree = (source: string): Tree[] => {
  if (source.length > 20000) return [source];
  const nodes = parse(source, { onlyAllowTags: tags, enableEscapeTags: true, contextFreeTags: ["code"] }) as Tree[];
  const stack = nodes.map((node) => ({ node, depth: 0 }));
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 24000 || depth > 40) return [source];
    if (typeof node !== "string") for (const child of node.content) stack.push({ node: child, depth: depth + 1 });
  }
  return nodes;
};
const literal = (nodes: Tree[]): string =>
  nodes.map((node) => (typeof node === "string" ? node : literal(node.content))).join("");

export interface CommunityMarkupOptions { allowStickers?: boolean; }
export function communityMarkup(source: string, spoiler = "Spoiler", locale = "en", options: CommunityMarkupOptions = {}): string {
  const flow = (nodes: Tree[], align = ""): string => {
    const blocks: string[] = [];
    let inline = "";
    const flush = () => {
      const text = inline.replace(/^\n+|\n+$/g, "");
      if (text)
        blocks.push(
          ...text
            .split(/\n\n/)
            .map(
              (part) =>
                `<p${align ? ` style="text-align:${align}"` : ""}>${part.replaceAll("\n", "<br>") || "<br>"}</p>`,
            ),
        );
      inline = "";
    };
    for (const node of nodes) {
      if (typeof node !== "string" && blockTags.has(node.tag.toLowerCase())) {
        flush();
        blocks.push(renderNode(node, align));
      } else inline += renderNode(node);
    }
    flush();
    return blocks.join("");
  };
  const inline = (nodes: Tree[]): string => nodes.map((node) => renderNode(node)).join("");
  const renderNode = (node: Tree, align = ""): string => {
    if (typeof node === "string") return escapeMarkup(node);
    const tag = node.tag.toLowerCase();
    const marks: Record<string, string> = { b: "strong", i: "em", u: "u", s: "s" };
    if (marks[tag]) return `<${marks[tag]}>${inline(node.content)}</${marks[tag]}>`;
    if (tag === "align") {
      const align = attribute(node);
      return flow(node.content, ["left", "center", "right", "justify"].includes(align) ? align : "");
    }
    if (["h2", "h3", "h4"].includes(tag))
      return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inline(node.content)}</${tag}>`;
    if (tag === "hr") return "<hr>";
    if (tag === "highlight") return `<mark>${inline(node.content)}</mark>`;
    if (tag === "quote") return `<blockquote>${flow(node.content)}</blockquote>`;
    if (tag === "code") return `<pre><code>${escapeMarkup(literal(node.content))}</code></pre>`;
    if (tag === "spoiler")
      return `<details data-spoiler><summary>${escapeMarkup(spoiler)}</summary><div>${flow(node.content)}</div></details>`;
    if (tag === "url") {
      const href = safeCommunityLink(attribute(node) || literal(node.content));
      return href
        ? `<a href="${escapeMarkup(href)}" target="_blank" rel="nofollow noopener noreferrer">${inline(node.content)}</a>`
        : inline(node.content);
    }
    if (tag === "sticker") {
      if (options.allowStickers === false) return inline(node.content);
      const token = attribute(node);
      return validStickerToken(token)
        ? `<community-sticker token="${escapeMarkup(token)}" locale="${escapeMarkup(locale)}" label="${escapeMarkup(literal(node.content))}"></community-sticker>`
        : inline(node.content);
    }
    if (tag === "list") {
      const groups: Tree[][] = [];
      for (const child of node.content) {
        if (typeof child !== "string" && child.tag === "*") groups.push([...child.content]);
        else if (typeof child !== "string" && child.tag === "li") groups.push(child.content);
        else if (groups.length) groups[groups.length - 1].push(child);
        else if (typeof child !== "string" || child.trim()) groups.push([child]);
      }
      const listTag = attribute(node) === "1" ? "ol" : "ul";
      return `<${listTag}>${groups.map((group) => `<li>${flow(group)}</li>`).join("")}</${listTag}>`;
    }
    return inline(node.content);
  };
  return flow(tree(source));
}
export const communityExcerpt = (source: string) => literal(tree(source)).replace(/\s+/g, " ").trim();
/** Bounded built-in sticker preview; code and spoilers never reveal their contents. */
export function communityStickerPreview(source: string, limit = 1): Array<{ token: string; label: string }> {
  const maximum = Math.min(1, Math.max(0, Math.trunc(limit)));
  if (!maximum) return [];
  const found: Array<{ token: string; label: string }> = [];
  const visibleCaption = (nodes: Tree[]): Tree[] => nodes.flatMap((node): Tree[] => {
    if (typeof node === "string") return [node];
    if (node.tag.toLowerCase() === "code" || node.tag.toLowerCase() === "spoiler") return [];
    return [{ ...node, content: visibleCaption(node.content) }];
  });
  const pending = [...tree(source)].reverse();
  while (pending.length && found.length < maximum) {
    const node = pending.pop()!;
    if (typeof node === "string") continue;
    const tag = node.tag.toLowerCase();
    if (tag === "code" || tag === "spoiler") continue;
    if (tag === "sticker") {
      const token = attribute(node);
      if (validStickerToken(token)) {
        found.push({ token, label: literal(visibleCaption(node.content)) });
        continue;
      }
    }
    pending.push(...[...node.content].reverse());
  }
  return found;
}
const escapeText = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
export function communityDocument(node: JSONContent): string {
  const children = (separator = "") => (node.content || []).map(communityDocument).join(separator);
  if (node.type === "text") {
    let value = escapeText(node.text || "");
    for (const mark of node.marks || []) {
      if (mark.type === "highlight") {
        value = `[highlight]${value}[/highlight]`;
        continue;
      }
      const tag = ({ bold: "b", italic: "i", underline: "u", strike: "s" } as Record<string, string>)[mark.type];
      if (tag) value = `[${tag}]${value}[/${tag}]`;
      else if (mark.type === "link") {
        const href = safeCommunityLink(String(mark.attrs?.href || ""));
        if (href && !href.includes("]")) value = `[url=${href}]${value}[/url]`;
      }
    }
    return value;
  }
  if (["paragraph", "heading"].includes(node.type || "")) {
    let value = children();
    if (node.type === "heading") {
      const level = [2, 3, 4].includes(Number(node.attrs?.level)) ? Number(node.attrs?.level) : 2;
      value = `[h${level}]${value}[/h${level}]`;
    }
    const align = String(node.attrs?.textAlign || "");
    return ["center", "right", "justify"].includes(align) ? `[align=${align}]${value}[/align]` : value;
  }
  if (node.type === "horizontalRule") return "[hr][/hr]";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "communitySticker")
    return validStickerToken(String(node.attrs?.token || ""))
      ? `[sticker=${node.attrs!.token}]${escapeText(String(node.attrs?.label || ""))}[/sticker]`
      : "";
  if (node.type === "codeBlock")
    return `[code]${escapeText((node.content || []).map((child) => child.text || "").join(""))}[/code]`;
  if (node.type === "blockquote") return `[quote]${children("\n\n")}[/quote]`;
  if (node.type === "communitySpoiler") return `[spoiler]${children("\n\n")}[/spoiler]`;
  if (node.type === "bulletList" || node.type === "orderedList")
    return `[list${node.type === "orderedList" ? "=1" : ""}]${children("\n")}[/list]`;
  if (node.type === "listItem") return `[*]${children("\n")}`;
  return children(node.type === "doc" ? "\n\n" : "");
}
