import { html, noChange, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { styleMap } from "lit/directives/style-map.js";
import { parseAdvRichText, advTextLengthCss, type AdvRichTextNode } from "@haneoka/vega-plugin-richtext";
import { advTextFontSizeCss, NATIVE_TALK_FONT_SIZE } from "../../lib/adv-text-size";
import "../../styles/adv-text.css";

// Preserve authored whitespace; HTML formatting must not add text nodes.
// prettier-ignore
function renderNodes(nodes: readonly AdvRichTextNode[], nativeBase: number): Array<string | TemplateResult> {
  return nodes.map((node) => {
    if (node.type === "text") return node.value;
    if (node.type === "break") return html`<br />`;
    if (node.type === "ruby") return html`<ruby><rb>${node.base}</rb><rt>${node.annotation}</rt></ruby>`;
    if (node.type === "style") return html`<span style=${styleMap(node.style.fontSize ? { ...node.style, fontSize: advTextFontSizeCss(node.style.fontSize, nativeBase) } : node.style)}>${renderNodes(node.children, nativeBase)}</span>`;
    if (node.type === "size") return html`<span class="vega-rich-text__size" style=${styleMap({ fontSize: advTextFontSizeCss(`${node.percent}%`, nativeBase) })}>${renderNodes(node.children, nativeBase)}</span>`;
    const length = advTextLengthCss(node.unit === "%" ? node.value / 100 : node.value, node.unit === "%" ? "em" : node.unit);
    return html`<span class="vega-rich-text__space" aria-hidden="true" style=${styleMap({ display: "inline-block", height: "0", width: node.value < 0 ? "0" : length, marginInlineStart: node.value < 0 ? length : undefined })}></span>`;
  });
}

class AdvText extends Directive {
  private source?: string;
  private nativeBase?: number;
  render(source: string, nativeBase = NATIVE_TALK_FONT_SIZE) {
    if (source === this.source && nativeBase === this.nativeBase) return noChange;
    this.source = source;
    this.nativeBase = nativeBase;
    // prettier-ignore
    return html`<span class="story-rich-text">${renderNodes(parseAdvRichText(source), nativeBase)}</span>`;
  }
}
export const advText = directive(AdvText);
