import { html, nothing } from "lit";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import type { ScreenshotImportPreview, ScreenshotCardConfirmation, ScreenshotRecognitionResult } from "../../lib/team-builder/screenshot-import";
import { screenshotLevelDefault } from "../../lib/team-builder/screenshot-import";
import { tile, tileMedia, type TileOptions } from "../ui/tile";
import { iconButton, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { renderLevelSwitch } from "../ui/level-switch";
import type { ScreenshotCrop } from "../../lib/team-builder/screenshot-image";

export interface ScreenshotImportDialogState {
  phase: "select" | "preparing" | "preview" | "uploading" | "queued" | "processing" | "review" | "failed";
  localImages?: { url: string; crop: ScreenshotCrop }[];
  preview?: ScreenshotImportPreview;
  results?: readonly ScreenshotRecognitionResult[];
  confirmations: readonly ScreenshotCardConfirmation[];
  existingValues?: "keep" | "overwrite" | "updates";
  bindingConfirmed?: boolean;
  /** Local Blob-derived crop URLs, never a public screenshot resource URL. */
  crops: Readonly<Record<string, string>>;
  error: string | null;
  canConfirm: boolean;
}
export interface ScreenshotImportDialogActions {
  upload?: () => void;
  crop?: (image: number, side: keyof ScreenshotCrop, value: number) => void;
  text: (key: string, fallback: string) => string;
  card: (kind: "members" | "snapshots", cardId: number) => TileOptions | null;
  levels?: (kind: "members" | "snapshots", cardId: number) => readonly number[];
  files: (files: File[]) => void;
  close: () => void;
  cancel: () => void;
  correct: (image: number, observation: number) => void;
  candidate: (image: number, observation: number, cardId: number) => void;
  include: (key: string, value: boolean) => void;
  bind: (value: boolean) => void;
  level: (key: string, value: number | "keep" | undefined, source: "observed" | "manual") => void;
  existingValues: (value: "keep" | "overwrite" | "updates") => void;
  confirm: () => void;
  expandedSource?: (key: string) => boolean;
  expandSource?: (key: string, expanded: boolean) => void;
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
        <p>${t("privacy", "Recognition requires a website account and uploads the confirmed images to the private recognition service. Preview and crop out names, account IDs and notifications before uploading. Only visible cards and levels are observed; other training stays unknown. Files/text and manual entry remain available without uploading images.")}</p>
        ${state.phase === "preparing" ? html`<p role="status">${t("preparing", "Preparing local previews")}</p>` : nothing}
        ${state.localImages?.map((image, index) => html`<div class="stack"><img src=${image.url} alt=${t("localPreview", "Local image preview")} style=${`max-width:100%;max-height:50vh;object-fit:contain;clip-path:inset(${image.crop.top}% ${image.crop.right}% ${image.crop.bottom}% ${image.crop.left}%)`} />
          <div class="cluster">${(["top", "right", "bottom", "left"] as const).map(side => html`<label>${t(side, side)} (%)<input type="number" min="0" max="95" .value=${String(image.crop[side])}
            @change=${(event: Event) => actions.crop?.(index, side, Number((event.target as HTMLInputElement).value))} /></label>`)}</div></div>`)}
        ${state.phase === "select" || state.phase === "failed" ||
          (state.phase === "review" && state.results?.length && state.results.every(result => result.status === "no-reliable-grid")) ? html`
          <div>
            <button type="button" class="button button--outlined"
              @click=${(event: Event) => ((event.currentTarget as HTMLElement).nextElementSibling as HTMLInputElement | null)?.click()}>${t("chooseImages", "Choose screenshots")}</button>
            <input hidden type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" multiple
              @change=${(event: Event) => { const input = event.target as HTMLInputElement;
                actions.files([...input.files ?? []]); input.value = ""; }} />
          </div>` : nothing}
        ${busy ? html`<p role="status">${t(state.phase, "Recognizing screenshots")}</p>` : nothing}
        ${state.error ? html`<p class="team-builder__error" role="alert">${t(state.error.startsWith("image-") ? state.error : "failedMessage", "Screenshot recognition failed")}</p>` : nothing}
        ${state.preview ? html`
          <label class="team-builder__check"><md-checkbox .checked=${state.bindingConfirmed ?? false}
            @change=${(event: Event) => actions.bind((event.target as HTMLInputElement).checked)}></md-checkbox><span>${t("bind", "These screenshots belong to the same game account as this inventory.")}</span></label>
          ${segmented<"keep" | "overwrite" | "updates">({
            label: t("existingPolicy", "Existing cards"),
            value: state.existingValues ?? "keep",
            options: [
              { value: "updates", label: t("updates", "Apply increases; review decreases") },
              { value: "keep", label: t("existingKeep", "Keep all existing values") },
              { value: "overwrite", label: t("existingOverwrite", "Overwrite all existing values") },
            ],
            onSelect: actions.existingValues,
          })}
          <div class="collection collection--member">
            ${state.preview.cards.map(proposal => {
              const options = actions.card(proposal.kind, proposal.cardId);
              const choice = state.confirmations.find(value => value.key === proposal.key);
              const existing = proposal.existingInstanceId !== null;
              const defaultChoice = screenshotLevelDefault(proposal, state.existingValues);
              const conflict = defaultChoice.source === "conflict";
              const defaultLevel = defaultChoice.value;
              const defaultLabel = defaultChoice.source === "saved" ? t("keepLevel", "Keep saved level") : conflict ? t("chooseLevel", "Choose level") :
                defaultChoice.source === "observed" ? t("observedLevel", "Screenshot level") : t("levelUnknown", "Level not recognized");
              const defaultText = defaultLevel === null ? defaultLabel : `${defaultLabel}: ${defaultLevel}`;
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
                <div class="team-builder__practice-control">
                  <p class="team-builder__hint">${defaultText}</p>
                  ${proposal.existingLevel !== null && proposal.observedLevels.some(level => level < proposal.existingLevel!) ? html`<p>${t("decrease", "A lower observed level needs explicit selection.")}</p>` : nothing}
                  ${(() => {
                    const levels = [...new Set(actions.levels?.(proposal.kind, proposal.cardId) ?? [])].filter(Number.isSafeInteger).sort((a,b)=>a-b);
                    const selectedLevel = choice?.level === "keep" ? proposal.existingLevel : choice?.level === undefined ? defaultLevel : choice.level;
                    const value = selectedLevel !== null && levels.includes(selectedLevel) ? selectedLevel : null;
                    const change = (level: number) => actions.level(proposal.key, level, proposal.observedLevels.includes(level) ? "observed" : "manual");
                    return levels.length > 1 ? renderLevelSwitch(t("level", "Visible level"), levels, value, change, String,
                      { unknownLabel: selectedLevel === null ? t("chooseLevel", "Choose level") : String(selectedLevel), commitOnChange: true })
                      : levels.length === 1 ? html`<button class="button button--outlined" @click=${()=>change(levels[0])}>${t("level", "Visible level")}: ${levels[0]}</button>` : nothing;
                  })()}
                  ${existing && choice?.level !== "keep" ? html`<button type="button" class="button button--text" @click=${()=>actions.level(proposal.key, "keep", "manual")}>${t("keepLevel", "Keep saved level")}: ${proposal.existingLevel ?? t("levelUnknown", "Level not recognized")}</button>` : nothing}
                  ${choice?.level !== undefined ? html`<button class="button button--text" @click=${()=>actions.level(proposal.key, undefined, "manual")}>${defaultText}</button>` : nothing}
                </div>
                ${!proposal.observedLevels.length ? html`<small>${t("levelUnknown", "Level not recognized")}</small>` : nothing}
                ${conflict && choice?.include && choice.level === undefined ? html`<small role="status">${t("chooseLevel", "Choose level")}</small>` : nothing}
                ${accordion({ id: `team-screenshot-${proposal.key}`, label: t("sourceImages", "Screenshots"),
                  expanded: actions.expandedSource?.(proposal.key) ?? false,
                  onExpandedChange: expanded => actions.expandSource?.(proposal.key, expanded),
                  content: html`${proposal.observations.map(value => source(value.image, value.index, proposal.cardId))}` })}
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
        ${state.phase === "preview" ? html`<button class="button" @click=${actions.upload}>${t("upload", "Upload these cropped images for recognition")}</button>` : nothing}
        ${busy ? html`<button class="button button--outlined" @click=${actions.cancel}>${t("cancel", "Cancel")}</button>` : nothing}
        ${state.phase === "review" ? html`<button class="button" ?disabled=${!state.canConfirm} @click=${actions.confirm}>${t("confirm", "Confirm import")}</button>` : nothing}
      </footer>
    </dialog>`;
}
