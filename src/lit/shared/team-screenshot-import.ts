import { html, nothing } from "lit";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import type { ScreenshotImportPreview, ScreenshotCardConfirmation, ScreenshotRecognitionResult } from "../../lib/team-builder/screenshot-import";
import { tile, tileMedia, type TileOptions } from "../ui/tile";
import { iconButton } from "../ui/controls";

export interface ScreenshotImportDialogState {
  phase: "select" | "uploading" | "queued" | "processing" | "review" | "failed";
  preview?: ScreenshotImportPreview;
  results?: readonly ScreenshotRecognitionResult[];
  confirmations: readonly ScreenshotCardConfirmation[];
  /** Local Blob-derived crop URLs, never a public screenshot resource URL. */
  crops: Readonly<Record<string, string>>;
  error: string | null;
  canConfirm: boolean;
}
export interface ScreenshotImportDialogActions {
  text: (key: string, fallback: string) => string;
  card: (kind: "members" | "snapshots", cardId: number) => TileOptions | null;
  files: (files: File[]) => void;
  close: () => void;
  cancel: () => void;
  correct: (image: number, observation: number) => void;
  candidate: (image: number, observation: number, cardId: number) => void;
  include: (key: string, value: boolean) => void;
  level: (key: string, value: number | undefined) => void;
  confirm: () => void;
}

/** Independent top-layer review surface; owning UI shows the modal and runs the
 * authenticated job/controller. The renderer performs no upload or inventory write.
 * Current catalogue tiles and manual picker callbacks are reused.
 */
export function renderScreenshotImportDialog(state: ScreenshotImportDialogState, actions: ScreenshotImportDialogActions) {
  const t = actions.text;
  const busy = ["uploading", "queued", "processing"].includes(state.phase);
  const source = (image: number, index: number, selected: number | null) => {
    const observation = state.results?.[image]?.observations[index];
    if (!observation) return nothing;
    const ids = [...new Set([...observation.candidates.map(candidate => candidate.cardId), ...(selected === null ? [] : [selected])])];
    const name = (id: number) => { const options = actions.card(observation.kind, id);
      return typeof options?.title === "string" ? options.title : options?.label ?? ""; };
    return html`<div>
      ${state.crops[`${image}:${index}`] ? tileMedia({ title: t("reviewCard", "Review card"), label: t("reviewCard", "Review card"),
        image: state.crops[`${image}:${index}`], aspectRatio: `${observation.bbox[2]} / ${observation.bbox[3]}`, fit: "contain" }) : nothing}
      ${ids.length ? html`<md-outlined-select label=${t("candidate", "Card")} .value=${selected === null ? "choose" : String(selected)}
        .displayText=${selected === null ? t("chooseCard", "Choose card") : name(selected)}
        @change=${(event: Event) => { const value = Number((event.target as HTMLInputElement).value);
          if (ids.includes(value)) actions.candidate(image, index, value); }}>
        ${selected === null ? html`<md-select-option value="choose"><span slot="headline">${t("chooseCard", "Choose card")}</span></md-select-option>` : nothing}
        ${ids.map(id => html`<md-select-option value=${String(id)}><span slot="headline">${name(id)}</span></md-select-option>`)}
      </md-outlined-select>` : nothing}
      <button class="button button--outlined" @click=${() => actions.correct(image, index)}>${t("chooseCard", "Choose card")}</button>
    </div>`;
  };
  return html`
    <dialog class="selection-pane team-builder__screenshot-review" aria-label=${t("title", "Import screenshots")}
      @cancel=${(event: Event) => { event.preventDefault(); actions.close(); }}>
      <header class="sheet__header">
        <strong>${t("title", "Import screenshots")}</strong>
        ${iconButton({ icon: "close", label: t("close", "Close"), onClick: actions.close })}
      </header>
      <div class="selection-pane__body">
        ${state.phase === "select" || state.phase === "failed" ||
          (state.phase === "review" && state.results?.length && state.results.every(result => result.status === "no-reliable-grid")) ? html`
          <div>
            <button type="button" class="button button--outlined"
              @click=${(event: Event) => ((event.currentTarget as HTMLElement).nextElementSibling as HTMLInputElement | null)?.click()}>${t("chooseImages", "Choose screenshots")}</button>
            <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple
              @change=${(event: Event) => { const input = event.target as HTMLInputElement;
                actions.files([...input.files ?? []]); input.value = ""; }} />
          </div>` : nothing}
        ${busy ? html`<p role="status">${t(state.phase, "Recognizing screenshots")}</p>` : nothing}
        ${state.error ? html`<p class="team-builder__error" role="alert">${t("failedMessage", "Screenshot recognition failed")}</p>` : nothing}
        ${state.preview ? html`
          <div class="collection collection--member">
            ${state.preview.cards.map(proposal => {
              const options = actions.card(proposal.kind, proposal.cardId);
              const choice = state.confirmations.find(value => value.key === proposal.key);
              return html`<div role="group" aria-label=${options?.label ?? t("reviewCard", "Review card")}>
                ${options ? tile({ ...options, href: undefined, onOpen: () => {
                  const first = proposal.observations[0]!; actions.correct(first.image, first.index);
                } }) : nothing}
                <label class="team-builder__check">
                  <md-checkbox .checked=${choice?.include ?? false}
                    aria-label=${`${t("include", "Include card")}: ${options?.label ?? t("reviewCard", "Review card")}`}
                    @change=${(event: Event) => actions.include(proposal.key, (event.target as HTMLInputElement).checked)}></md-checkbox>
                  <span>${t("include", "Include card")}</span>
                </label>
                <md-outlined-select label=${t("level", "Visible level")} .value=${choice?.level === undefined ? "keep" : String(choice.level)}
                  .displayText=${choice?.level === undefined ? t("keepLevel", "Keep saved level") : String(choice.level)}
                  @change=${(event: Event) => { const value = (event.target as HTMLInputElement).value;
                    actions.level(proposal.key, value === "keep" ? undefined : Number(value)); }}>
                  <md-select-option value="keep"><span slot="headline">${t("keepLevel", "Keep saved level")}</span></md-select-option>
                  ${proposal.observedLevels.map(level => html`<md-select-option value=${String(level)}><span slot="headline">${level}</span></md-select-option>`)}
                </md-outlined-select>
                ${!proposal.observedLevels.length ? html`<small>${t("levelUnknown", "Level not recognized")}</small>` : nothing}
                <details><summary>${t("sourceImages", "Screenshots")}</summary>
                  ${proposal.observations.map(value => source(value.image, value.index, proposal.cardId))}
                </details>
              </div>`;
            })}
          </div>` : nothing}
        ${(state.results ?? []).map((result, image) => html`
          ${result.status === "no-reliable-grid" ? html`<p role="status">${t("noGrid", "No reliable card grid found")}</p>` : nothing}
          <div class="collection collection--member">
            ${result.observations.map((observation, index) => !state.preview?.cards.some(card =>
              card.observations.some(value => value.image === image && value.index === index)) ? html`
              <div>
                <span>${observation.cardId === null ? t("unrecognized", "Unrecognized card") : t("reviewCard", "Review card")}</span>
                ${source(image, index, null)}
              </div>` : nothing)}
          </div>`)}
      </div>
      <footer class="selection-pane__footer team-builder__actions">
        ${busy ? html`<button class="button button--outlined" @click=${actions.cancel}>${t("cancel", "Cancel")}</button>` : nothing}
        ${state.phase === "review" ? html`<button class="button" ?disabled=${!state.canConfirm} @click=${actions.confirm}>${t("confirm", "Confirm import")}</button>` : nothing}
      </footer>
    </dialog>`;
}
