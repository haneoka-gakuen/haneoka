import { createPreset } from "@bbob/preset";
import type { BBobCoreOptions, NodeContent, TagNodeObject, TagNodeTree } from "@bbob/types";

export const COMMUNITY_BBCODE_MAX_LENGTH = 20_000;
const COMMUNITY_BBCODE_MAX_TAGS = 1_000;
const COMMUNITY_BBCODE_MAX_DEPTH = 32;

export const COMMUNITY_BBCODE_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "quote",
  "code",
  "list",
  "*",
  "url",
  "spoiler",
];

export const COMMUNITY_BBCODE_OPTIONS: BBobCoreOptions = {
  caseFreeTags: true,
  contextFreeTags: ["code"],
  enableEscapeTags: true,
  onlyAllowTags: [...COMMUNITY_BBCODE_TAGS],
};

type CommunityBbobNode = TagNodeObject<string>;
type CommunityBbobContent = NodeContent<string>;

const contentArray = (content: TagNodeTree<string> | undefined): CommunityBbobContent[] => {
  if (content == null) return [];
  return Array.isArray(content) ? content : [content];
};

const attributeValue = (node: CommunityBbobNode): string | undefined => {
  for (const value of Object.values(node.attrs ?? {})) {
    if (typeof value === "string") return value.trim();
  }
  return undefined;
};

const plainText = (content: TagNodeTree<string> | undefined, depth = 0): string => {
  if (depth >= COMMUNITY_BBCODE_MAX_DEPTH) return "";
  return contentArray(content)
    .map((node) => {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (node == null) return "";
      return plainText(node.content, depth + 1);
    })
    .join("");
};

const safeHref = (candidate: string | undefined): string | undefined => {
  const value = candidate?.trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  if (value.startsWith("#")) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(value)) return value;
  if (!/^https?:\/\//i.test(value)) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const element = (
  tag: string,
  node: CommunityBbobNode,
  attrs: Record<string, string | boolean> = {},
): CommunityBbobNode => ({
  tag,
  attrs,
  content: node.content,
});

const inline =
  (tag: string) =>
  (node: CommunityBbobNode): CommunityBbobNode =>
    element(tag, node);

export const communityBbobPreset = createPreset({
  b: inline("strong"),
  strong: inline("strong"),
  i: inline("em"),
  em: inline("em"),
  u: inline("u"),
  s: inline("s"),
  strike: inline("s"),
  quote: (node: CommunityBbobNode): CommunityBbobNode => {
    const author = attributeValue(node);
    return {
      tag: "blockquote",
      attrs: {},
      content: author ? [{ tag: "cite", attrs: {}, content: [author] }, ...contentArray(node.content)] : node.content,
    };
  },
  code: (node: CommunityBbobNode): CommunityBbobNode => ({
    tag: "pre",
    attrs: {},
    content: [{ tag: "code", attrs: {}, content: node.content }],
  }),
  list: (node: CommunityBbobNode): CommunityBbobNode => {
    const style = attributeValue(node)?.toLocaleLowerCase();
    return element(style === "1" || style === "a" ? "ol" : "ul", node);
  },
  "*": inline("li"),
  url: (node: CommunityBbobNode): CommunityBbobNode => {
    const href = safeHref(attributeValue(node) || plainText(node.content));
    if (!href) return element("span", node);
    const external = /^https?:\/\//i.test(href);
    return element("a", node, {
      href,
      ...(external ? { rel: "nofollow noopener noreferrer ugc", target: "_blank" } : {}),
    });
  },
  spoiler: (node: CommunityBbobNode): CommunityBbobNode => ({
    tag: "details",
    attrs: {},
    content: [
      { tag: "summary", attrs: {}, content: [attributeValue(node) || "Spoiler"] },
      { tag: "div", attrs: { class: "community-bbcode__spoiler-body" }, content: node.content },
    ],
  }),
});

const TAG_PATTERN = /\[(\/?)\s*(b|strong|i|em|u|s|strike|quote|code|list|\*|url|spoiler)(?:=[^\]\r\n]{0,512})?\s*\]/gi;

/**
 * BBob deliberately has a small API surface and does not expose parse budgets.
 * This cheap preflight prevents adversarial nesting from reaching its recursive
 * Vue renderer. Invalid input is displayed as plain text by the component.
 */
export const isCommunityBbcodeWithinBudget = (source: string): boolean => {
  if (source.length > COMMUNITY_BBCODE_MAX_LENGTH) return false;

  let depth = 0;
  let tagCount = 0;
  let insideCode = false;
  for (const match of source.matchAll(TAG_PATTERN)) {
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLocaleLowerCase();
    tagCount += 1;
    if (tagCount > COMMUNITY_BBCODE_MAX_TAGS) return false;

    if (insideCode) {
      if (closing && tag === "code") {
        insideCode = false;
        depth = Math.max(0, depth - 1);
      }
      continue;
    }

    if (tag === "*") continue;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }

    depth += 1;
    if (depth > COMMUNITY_BBCODE_MAX_DEPTH) return false;
    if (tag === "code") insideCode = true;
  }

  return true;
};
