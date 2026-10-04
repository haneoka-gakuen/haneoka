import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";
import "../../styles/dialogue.css";

export type DialogueRowState = "idle" | "loading" | "playing" | "error" | "cancelled";

export interface DialogueRowOptions {
  key?: string;
  commandIndex?: number;
  className?: string;
  avatar?: unknown;
  speaker?: string;
  speakerContent?: unknown;
  speakerLanguage?: string;
  text?: unknown;
  textLanguage?: string;
  meta?: unknown;
  action?: unknown;
  state?: DialogueRowState;
  statusMessage?: string;
}

/**
 * The shared speech-row language used by catalogue voice clips and story
 * transcripts. Consumers own their data and actions; this function owns the
 * speaker header and speech geometry and the inline playback affordance slot.
 */
export function dialogueRow(options: DialogueRowOptions): TemplateResult {
  const state = options.state || "idle";
  const classes = ["dialogue-row", options.className || ""].filter(Boolean).join(" ");
  const avatar = options.avatar && options.avatar !== nothing ? options.avatar : icon("person", 24);
  const hasSpeaker = Boolean(options.speaker);
  const statusRole = state === "error" ? "alert" : "status";

  return html`
    <article
      class=${classes}
      data-dialogue-key=${options.key || nothing}
      data-dialogue-state=${state}
      data-command-index=${options.commandIndex ?? nothing}
    >
      ${
        hasSpeaker || (options.avatar && options.avatar !== nothing)
          ? html`
              <div class="dialogue-row__heading">
                <div class="dialogue-row__avatar" aria-hidden="true">${avatar}</div>
                ${
            hasSpeaker
              ? html`
                  <strong class="dialogue-row__speaker" lang=${options.speakerLanguage || nothing}>
                    ${options.speakerContent ?? options.speaker}
                  </strong>
                `
              : nothing
          }
              </div>
            `
          : nothing
      }
      <div class="dialogue-row__bubble">
        <div class="dialogue-row__content">
          <div class="dialogue-row__copy">
            ${
              options.text
                ? html`
                    <!-- prettier-ignore -->
                    <div class="dialogue-row__text" lang=${options.textLanguage || nothing} dir="auto">${options.text}</div>
                  `
                : nothing
            }
            ${options.meta || nothing}
          </div>
          ${
            options.action
              ? html`
                  <div class="dialogue-row__action">${options.action}</div>
                `
              : nothing
          }
        </div>
        ${
          options.statusMessage && state !== "loading"
            ? html`
                <p class=${`dialogue-row__status dialogue-row__status--${state}`} role=${statusRole}>
                  ${options.statusMessage}
                </p>
              `
            : nothing
        }
      </div>
    </article>
  `;
}
