import { html } from "lit";
import { resolveLocalizedText } from "../../lib/localized-text";
export function localizedContent(value: unknown, locale: string) {
  const resolved = resolveLocalizedText(value, locale);
  return html`
    <span lang=${resolved.locale}>${resolved.text}</span>
  `;
}
export function localizedList(values: unknown[], locale: string) {
  const labels = values.map((value) => resolveLocalizedText(value, locale)).filter((value) => value.text);
  let index = 0;
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" })
    .formatToParts(labels.map((value) => value.text))
    .map((part) =>
      part.type === "element"
        ? html`
            <span lang=${labels[index++]!.locale}>${part.value}</span>
          `
        : part.value,
    );
}
