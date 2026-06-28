export interface AdvRichTextTextNode {
  readonly type: "text";
  readonly value: string;
}

export interface AdvRichTextBreakNode {
  readonly type: "break";
}

export interface AdvRichTextSizeNode {
  readonly type: "size";
  readonly percent: number;
  readonly children: AdvRichTextNode[];
}

export interface AdvRichTextRubyNode {
  readonly type: "ruby";
  readonly base: string;
  readonly annotation: string;
}

export type AdvRichTextNode = AdvRichTextTextNode | AdvRichTextBreakNode | AdvRichTextSizeNode | AdvRichTextRubyNode;

export function advTextSizePercent(value: unknown): number {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 100;
  return Math.max(40, Math.min(300, percent));
}

function appendText(children: AdvRichTextNode[], value: string): void {
  if (!value) return;
  const previous = children[children.length - 1];
  if (previous?.type === "text") {
    children[children.length - 1] = { type: "text", value: previous.value + value };
    return;
  }
  children.push({ type: "text", value });
}

function appendPlainText(children: AdvRichTextNode[], value: string): void {
  let start = 0;
  for (const match of value.matchAll(/\r\n|\r|\n/g)) {
    const index = match.index;
    appendText(children, value.slice(start, index));
    children.push({ type: "break" });
    start = index + match[0].length;
  }
  appendText(children, value.slice(start));
}

/**
 * Parses the small, supported subset of Unity ADV markup into inert render nodes.
 * Unknown complete tags are discarded like the game player, and incomplete tags
 * are withheld so typewriter playback never exposes a partial markup token.
 */
export function parseAdvRichText(value: unknown): AdvRichTextNode[] {
  const source = String(value ?? "");
  const lower = source.toLowerCase();
  const root: AdvRichTextNode[] = [];
  const childrenStack: AdvRichTextNode[][] = [root];
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    const children = childrenStack[childrenStack.length - 1] as AdvRichTextNode[];
    const sizeOpen = rest.match(/^<size=([0-9]+(?:\.[0-9]+)?)%>/i);
    if (sizeOpen) {
      const node: AdvRichTextSizeNode = {
        type: "size",
        percent: advTextSizePercent(sizeOpen[1]),
        children: [],
      };
      children.push(node);
      childrenStack.push(node.children);
      index += sizeOpen[0].length;
      continue;
    }

    const sizeClose = rest.match(/^<\/size>/i);
    if (sizeClose) {
      if (childrenStack.length > 1) childrenStack.pop();
      index += sizeClose[0].length;
      continue;
    }

    const rubyOpen = rest.match(/^<ruby=([^>]*)>/i);
    if (rubyOpen) {
      const bodyStart = index + rubyOpen[0].length;
      const closeIndex = lower.indexOf("</ruby>", bodyStart);
      const partialTagIndex = closeIndex >= 0 ? -1 : source.indexOf("<", bodyStart);
      const bodyEnd = closeIndex >= 0 ? closeIndex : partialTagIndex >= 0 ? partialTagIndex : source.length;
      const base = source.slice(bodyStart, bodyEnd);
      if (base) children.push({ type: "ruby", base, annotation: rubyOpen[1] || "" });
      index = closeIndex >= 0 ? closeIndex + "</ruby>".length : source.length;
      continue;
    }

    const rubyClose = rest.match(/^<\/ruby>/i);
    if (rubyClose) {
      index += rubyClose[0].length;
      continue;
    }

    if (source[index] === "<") {
      const tagEnd = source.indexOf(">", index);
      if (tagEnd < 0) break;
      index = tagEnd + 1;
      continue;
    }

    const nextTag = source.indexOf("<", index);
    const end = nextTag >= 0 ? nextTag : source.length;
    appendPlainText(children, source.slice(index, end));
    index = end;
  }

  return root;
}
