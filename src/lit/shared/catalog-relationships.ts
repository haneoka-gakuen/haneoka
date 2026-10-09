import { html, nothing } from "lit";
import { resolveLocalizedText, resolveRelationshipText, type RelationshipTextOptions } from "../../lib/localized-text";

type Character = Record<string, unknown>;

/** Source-qualified portraits share the same layout as member/snapshot relations. */
export function catalogPortraitStack(values: ReadonlyArray<{key:string;name:unknown;image:string}>) {
  return html`<span class="avatar-stack">${values
    .filter((item,index,list)=>item.image && list.findIndex(other=>other.key===item.key)===index)
    .map(item=>html`<img src=${item.image} alt="" loading="lazy" decoding="async" />`)}</span>`;
}

/** One caller-scoped catalogue lookup; IDs never cross a server context here. */
export function catalogCharacterRelationship(
  ids: readonly number[],
  locale: string,
  lookup: (id: number) => Character | undefined,
  fallbackName: (id: number) => string = () => "",
  relationship: RelationshipTextOptions = {},
) {
  const characters = ids.map((id) => ({ id, character: lookup(id) }));
  const names = characters.map(({ id, character }) => {
    for (const value of [character?.characterName, character?.englishName])
      if (resolveLocalizedText(value, locale).text) return value;
    return fallbackName(id);
  });
  const resolved = resolveRelationshipText(names, locale, relationship);
  const content = html`
    ${resolved.parts.map(
      (part) => html`
        <span lang=${part.lang}>${part.text}</span>
      `,
    )}
  `;
  const adornment = html`
    <span class="avatar-stack">
      ${characters
      .filter(({ id }, index, values) => values.findIndex((value) => value.id === id) === index)
      .slice(0, 5)
      .map(({ id, character }) => {
        const image = String(character?.faceImage || character?.thumbnailImage || "");
        const name =
          resolveLocalizedText(character?.characterName, locale).text ||
          resolveLocalizedText(character?.englishName, locale).text ||
          fallbackName(id);
        return image
          ? html`
              <img src=${image} alt=${name} loading="lazy" decoding="async" />
            `
          : nothing;
      })}
    </span>
  `;
  return { content, adornment, label: resolved.text };
}
