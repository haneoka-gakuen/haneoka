import { html, nothing } from "lit";
import "../../styles/character-profile.css";

type Item = Record<string, unknown>;
export function characterProfile(options: {
  item: Item;
  name: string;
  description: string;
  catchCopy: string;
  part: string;
  voiceActor: string;
  alternateName: string;
  bandLogo?: string;
  gallery: unknown;
  fields: Array<{ label: string; value: string }>;
}) {
  return html`
    <section
      class="character-profile"
      style=${`--profile-accent:${String(options.item.colorCode || "var(--md-sys-color-primary-container)")}`}
    >
      <div class="character-profile__visual">${options.gallery}</div>
      <div class="character-profile__body">
        ${
          options.bandLogo
            ? html`
                <img class="character-profile__band" src=${options.bandLogo} alt="" />
              `
            : nothing
        }
        <header>
          ${
            options.part
              ? html`
                  <p class="character-profile__part">${options.part}</p>
                `
              : nothing
          }
          <h2>${options.name}</h2>
          ${
            options.alternateName && options.alternateName !== options.name
              ? html`
                  <p class="character-profile__alternate">${options.alternateName}</p>
                `
              : nothing
          }
          ${
            options.voiceActor
              ? html`
                  <p class="character-profile__voice">
                    <small>CV.</small>
                    ${options.voiceActor.replace(/^CV\s*[.．:：]\s*/iu, "")}
                  </p>
                `
              : nothing
          }
        </header>
        ${
          options.catchCopy
            ? html`
                <p class="character-profile__catch">${options.catchCopy}</p>
              `
            : nothing
        }
        ${
          options.description
            ? html`
                <p class="character-profile__description">${options.description}</p>
              `
            : nothing
        }
        <dl>
          ${options.fields.map(
            (field) => html`
              <div>
                <dt>${field.label}</dt>
                <dd>${field.value}</dd>
              </div>
            `,
          )}
        </dl>
      </div>
    </section>
  `;
}
