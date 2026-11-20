import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { safeAnnouncementUrl } from "./announcements";

export type AnnouncementBodyNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      tag: string;
      attributes: Record<string, string>;
      children: AnnouncementBodyNode[];
    };

const allowedTags = new Set([
  "a",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "wbr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "sub",
  "sup",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "img",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "ruby",
  "rt",
  "rp",
]);
const discardedTags = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "head",
  "title",
  "meta",
  "link",
  "base",
  "frame",
  "frameset",
  "textarea",
  "select",
  "button",
]);
const htmlNamespace = "http://www.w3.org/1999/xhtml";

function integerAttribute(value: string, minimum: number, maximum: number): string {
  if (!/^-?\d+$/.test(value)) return "";
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? String(number) : "";
}

function safeAttributes(element: DefaultTreeAdapterTypes.Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of element.attrs) {
    if (attribute.namespace || attribute.prefix) continue;
    const { name, value } = attribute;
    if (name === "lang" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) attributes.lang = value;
    if (name === "dir" && ["ltr", "rtl", "auto"].includes(value)) attributes.dir = value;
    if (name === "title") attributes.title = value;
    if (element.tagName === "a" && name === "href") {
      const href = safeAnnouncementUrl(value);
      if (href) {
        attributes.href = href;
        if (/^https?:\/\//i.test(href)) {
          attributes.target = "_blank";
          attributes.rel = "noopener noreferrer";
        }
      }
    }
    if (element.tagName === "img") {
      if (name === "src") {
        const src = safeAnnouncementUrl(value, true);
        if (src) attributes.src = src;
      }
      if (name === "alt") attributes.alt = value;
      if (name === "width" || name === "height") {
        const size = integerAttribute(value, 1, 32768);
        if (size) attributes[name] = size;
      }
    }
    if ((element.tagName === "th" || element.tagName === "td") && ["colspan", "rowspan"].includes(name)) {
      const span = integerAttribute(value, 1, 1000);
      if (span) attributes[name] = span;
    }
    if (element.tagName === "th" && name === "scope" && ["row", "col", "rowgroup", "colgroup"].includes(value))
      attributes.scope = value;
    if (element.tagName === "col" && name === "span") {
      const span = integerAttribute(value, 1, 1000);
      if (span) attributes.span = span;
    }
    if ((element.tagName === "ol" && name === "start") || (element.tagName === "li" && name === "value")) {
      const number = integerAttribute(value, -1000000, 1000000);
      if (number) attributes[name] = number;
    }
    if (element.tagName === "ol" && name === "reversed") attributes.reversed = "";
  }
  if (element.tagName === "img") {
    attributes.alt ??= "";
    attributes.loading = "lazy";
    attributes.decoding = "async";
  }
  return attributes;
}

function presentation(element: DefaultTreeAdapterTypes.Element, attributes: Record<string, string>): string {
  const authored = new Set(element.attrs.find(({ name }) => name === "class")?.value.split(/\s+/u));
  const rawStyle = element.attrs.find(({ name }) => name === "style")?.value ?? "";
  const declarations = new Map<string, string>();
  for (const entry of rawStyle.split(";")) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    declarations.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim().toLowerCase());
  }
  const classes = [];
  const style = [];
  let tag = element.tagName === "h1" ? "h2" : element.tagName;
  if (authored.has("news-title") || authored.has("news-subtitle")) {
    const title = authored.has("news-title");
    classes.push(title ? "announcement-body__section-title" : "announcement-body__subtitle");
    if (tag === "div" || tag === "p") tag = title ? "h2" : "h3";
  }
  if (authored.has("margin-left")) classes.push("announcement-body__left-image");
  if (authored.has("horizontal-splitline")) tag = "hr";
  const align = declarations.get("text-align") ?? element.attrs.find(({ name }) => name === "align")?.value ??
    [...authored].find(name => /^text-align-type-(?:left|right|center|justify)$/u.test(name))?.slice("text-align-type-".length);
  if (align && ["left", "right", "center", "justify", "start", "end"].includes(align)) style.push(`text-align:${align}`);
  if (["p", "div", "span", "strong", "h2", "h3", "li"].includes(tag)) {
    const rawSize = /^(1[2-9]|2[0-4])px$/u.exec(declarations.get("font-size") ?? "");
    const size = Number(rawSize?.[1] ?? 16);
    if (rawSize) style.push(`font-size:${size / 16}rem`);
    const leading = /^(\d+(?:\.\d{1,3})?)(px|em|%)?$/u.exec(declarations.get("line-height") ?? "");
    if (leading) {
      const scale = leading[2] === "px" ? size : leading[2] === "%" ? 100 : 1;
      const ratio = Number(leading[1]) / scale;
      if (ratio >= 1.2 && ratio <= 2.2) style.push(`line-height:${Math.round(ratio * 1000) / 1000}`);
    }
    const weight = declarations.get("font-weight");
    if (weight && /^(?:bold|normal|[4-9]00)$/u.test(weight)) style.push(`font-weight:${weight}`);
    const margin = declarations.get("margin");
    if (tag === "p" && margin && /^4px 0(?:px)?(?: 4px 22px)?$/u.test(margin)) {
      classes.push("announcement-body__compact");
      if (margin.endsWith("22px")) classes.push("announcement-body__indent");
    }
  }
  if (classes.length) attributes.class = classes.join(" ");
  if (style.length) attributes.style = style.join(";");
  return tag;
}

/** Parse authored HTML into an exact allowlist, independent of the browser DOM. */
export function parseAnnouncementBody(html: string): AnnouncementBodyNode[] {
  const fragment = parseFragment(html);
  const sanitize = (nodes: DefaultTreeAdapterTypes.ChildNode[], depth = 0): AnnouncementBodyNode[] => {
    if (depth > 100) return [];
    return nodes.flatMap((node): AnnouncementBodyNode[] => {
      if (node.nodeName === "#text") return [{ type: "text", value: (node as DefaultTreeAdapterTypes.TextNode).value }];
      if (!("tagName" in node)) return [];
      if (node.namespaceURI !== htmlNamespace || discardedTags.has(node.tagName)) return [];
      const children = sanitize(node.childNodes, depth + 1);
      if (!allowedTags.has(node.tagName)) return children;
      const attributes = safeAttributes(node);
      if (node.tagName === "img" && !attributes.src) return [];
      const tag = presentation(node, attributes);
      return [{ type: "element", tag, attributes, children: tag === "hr" ? [] : children }];
    });
  };
  return sanitize(fragment.childNodes);
}

/** Static markup uses the same parsed allowlist as native browser nodes. */
export function announcementBodyMarkup(source: string, tableLabel: string, title: string) {
  const nodes = parseAnnouncementBody(source), images: string[] = [];
  let illustrated = false;
  const text = (rows: AnnouncementBodyNode[]): string => rows.map(node => node.type === "text" ? node.value : text(node.children)).join("");
  let firstHeading = true;
  const omitDuplicateHeading = (rows: AnnouncementBodyNode[]): AnnouncementBodyNode[] => rows.flatMap<AnnouncementBodyNode>(node => {
    if (node.type === "text") return [node];
    if ((node.tag === "h1" || node.tag === "h2") && firstHeading) {
      firstHeading = false;
      if (text(node.children).replace(/\s+/gu, " ").trim() === title.replace(/\s+/gu, " ").trim()) return [];
    }
    return [{ ...node, children: omitDuplicateHeading(node.children) }];
  });
  const clean = omitDuplicateHeading(nodes);
  const escape = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
  const voidTags = new Set(["br", "hr", "wbr", "img", "col"]);
  const markup = (rows: AnnouncementBodyNode[]): string => rows.map(node => {
    if (node.type === "text") return escape(node.value);
    if (node.tag === "img" && node.attributes.src) {
      images.push(node.attributes.src);
      illustrated ||= isAnnouncementIllustration(node.attributes.width);
    }
    const tag = `<${node.tag}${Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escape(value)}"`).join("")}>`;
    const element = tag + (voidTags.has(node.tag) ? "" : markup(node.children) + `</${node.tag}>`);
    return node.tag === "table" ? `<div class="announcement-table-scroll" role="region" aria-label="${escape(tableLabel)}" tabindex="0">${element}</div>` : element;
  }).join("");
  return { markup: markup(clean), text: text(clean), images, illustrated };
}

export const isAnnouncementIllustration = (width: string | null | undefined) => !width || Number(width) >= 240;

/** Construct safe native nodes; authored markup never enters an HTML DOM sink. */
export function announcementBodyFragment(html: string, tableLabel: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const append = (parent: Node, nodes: AnnouncementBodyNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        parent.appendChild(document.createTextNode(node.value));
        continue;
      }
      const element = document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attributes)) element.setAttribute(name, value);
      append(element, node.children);
      if (node.tag === "table") {
        const region = document.createElement("div");
        region.className = "announcement-table-scroll";
        region.setAttribute("role", "region");
        region.setAttribute("aria-label", tableLabel);
        region.tabIndex = 0;
        region.appendChild(element);
        parent.appendChild(region);
      } else parent.appendChild(element);
    }
  };
  append(fragment, parseAnnouncementBody(html));
  return fragment;
}
