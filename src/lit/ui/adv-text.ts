import { noChange } from "lit";
import { Directive, directive } from "lit/directive.js";
import { renderVegaAdvText } from "@haneoka/vega-plugin-richtext";

class AdvText extends Directive {
  private source?: string;
  render(source: string) {
    if (source === this.source) return noChange;
    this.source = source;
    return renderVegaAdvText(document, source);
  }
}
export const advText = directive(AdvText);
