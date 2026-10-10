import { html, nothing } from "lit";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/textfield/outlined-text-field.js";
import type { BoxCandidate } from "../../lib/team-builder/box-import/types";
import type { BoxPreview } from "../../lib/team-builder/box-import/preview";
import type { BoxConfirmation } from "../../lib/team-builder/box-import/merge";
import { buildBoxImportReview, setBoxCardIncluded, setBoxField, setBoxMap, setBoxExistingValues, selectAvailableBoxItems, type BoxReviewField } from "../../lib/team-builder/box-review-model";
import { tile, tileMedia, type TileOptions } from "../ui/tile";
import { iconButton, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";

export interface BoxImportDialogState {
  phase: "select" | "parsing" | "choose" | "review";
  candidates: readonly BoxCandidate[];
  selectedCandidateId: string;
  preview: BoxPreview | null;
  confirmation: BoxConfirmation;
  serverLabel: string;
  bindingConfirmed: boolean;
  progress: { completed: number; total: number } | null;
  /** Owning UI supplies a localized, sanitized error; never the raw parser input. */
  error: string | null;
  canConfirm: boolean;
}
export interface BoxImportDialogActions {
  text: (key: string, fallback: string, params?: Record<string, string | number>) => string;
  card: (kind: "members" | "snapshots", id: number) => TileOptions | null;
  mapName: (map: "bandItems" | "characterRanks", id: number) => string;
  fieldName: (field: string) => string;
  files: (files: File[]) => void;
  parseText: (value: string) => void;
  selectCandidate: (id: string) => void;
  bind: (value: boolean) => void;
  confirmation: (value: BoxConfirmation) => void;
  close: () => void;
  cancel: () => void;
  confirm: () => void;
  expanded?: (id: string) => boolean;
  expand?: (id: string, value: boolean) => void;
}

/** Local sanitized Box review. Main owns parser Worker, captured account/pin,
 * showModal and InventoryStore/CAS; this renderer only emits explicit choices.
 */
export function renderBoxImportDialog(state: BoxImportDialogState, actions: BoxImportDialogActions) {
  const t = actions.text, model = state.preview ? buildBoxImportReview(state.preview, state.confirmation) : null;
  const sourceLabel = (source: BoxReviewField["source"]) => source === "box" ? t("boxValue", "Box value") : source === "saved" ? t("keep", "Keep saved value") : source === "conflict" ? t("chooseValue", "Choose a value") : t("unknown", "Unknown");
  const field = (key: string, row: BoxReviewField) => {
    const selected = state.confirmation.cards.find(choice => choice.key === key)?.fields?.[row.field];
    const caption = `${sourceLabel(row.defaultSource)}${row.defaultValue === null ? "" : `: ${row.defaultValue}`}`;
    const proposal = state.preview?.cards.find(card => card.key === key);
    const keepLabel = `${t("keep", "Keep saved value")}: ${proposal?.existing[row.field] ?? t("unknown", "Unknown")}`;
    return row.values.length ? html`<md-outlined-select label=${actions.fieldName(row.field)} .value=${selected === undefined ? "auto" : String(selected)} .displayText=${selected === "keep" ? keepLabel : selected === undefined ? caption : String(selected)}
      @change=${(event: Event) => { const value = (event.target as HTMLInputElement).value;
        actions.confirmation(setBoxField(state.confirmation, key, row.field, value === "auto" ? undefined : value === "keep" ? "keep" : Number(value))); }}>
      <md-select-option value="auto"><span slot="headline">${caption}</span></md-select-option>
      ${proposal?.existingInstanceId != null ? html`<md-select-option value="keep"><span slot="headline">${keepLabel}</span></md-select-option>` : nothing}
      ${row.values.map(value => html`<md-select-option value=${String(value)}><span slot="headline">${value}</span></md-select-option>`)}
    </md-outlined-select>` : html`<span>${actions.fieldName(row.field)} · ${sourceLabel(row.source)}${row.value === null ? "" : `: ${row.value}`}</span>`;
  };
  return html`<dialog class="selection-pane team-builder__box-review" aria-label=${t("title", "Import Box")}
    @cancel=${(event: Event) => { event.preventDefault(); actions.close(); }}>
    <header class="sheet__header"><strong>${t("title", "Import Box")}</strong>${iconButton({ icon: "close", label: t("close", "Close"), onClick: actions.close })}</header>
    <div class="selection-pane__body">
      ${state.error ? html`<p class="team-builder__error" role="alert">${state.error}</p>` : nothing}
      ${state.phase === "select" ? html`<div class="team-builder__fields">
        <div><button type="button" class="button button--outlined" @click=${(event: Event) => ((event.currentTarget as HTMLElement).nextElementSibling as HTMLInputElement | null)?.click()}>${t("chooseFiles", "Choose Box files")}</button>
          <input hidden type="file" multiple @change=${(event: Event) => { const input = event.target as HTMLInputElement; actions.files([...input.files ?? []]); input.value = ""; }} /></div>
        <div class="team-builder__practice-control"><md-outlined-text-field type="textarea" rows="4" label=${t("paste", "Paste Box text")}></md-outlined-text-field>
          <button type="button" class="button button--outlined" @click=${(event: Event) => { const input = (event.currentTarget as HTMLElement).parentElement?.querySelector("md-outlined-text-field") as HTMLElement & { value: string };
            if (input?.value.trim()) actions.parseText(input.value); }}>${t("parse", "Read Box")}</button></div>
      </div>` : nothing}
      ${state.phase === "parsing" ? html`<p role="status">${t("parsing", "Reading Box")}${state.progress ? ` · ${state.progress.completed}/${state.progress.total}` : ""}</p>` : nothing}
      ${(state.phase === "choose" || state.phase === "review") && state.candidates.length > 1 ? html`<md-outlined-select label=${t("candidate", "Choose Box data")} .value=${state.selectedCandidateId || "choose"}
        @change=${(event: Event) => { const id = (event.target as HTMLInputElement).value; if (state.candidates.some(candidate => candidate.id === id)) actions.selectCandidate(id); }}>
        <md-select-option value="choose"><span slot="headline">${t("candidate", "Choose Box data")}</span></md-select-option>
        ${state.candidates.map((candidate, index) => html`<md-select-option value=${candidate.id}><span slot="headline">${t("candidateCounts", "Data {index}: {members} members, {snapshots} photos, {characters} characters, {items} items", { index: index + 1, members: candidate.members.length, snapshots: candidate.snapshots.length, characters: candidate.characters.length, items: candidate.bandItems.length })}</span></md-select-option>`)}
      </md-outlined-select>` : nothing}
      ${model && state.preview ? html`
        <label class="team-builder__check"><md-checkbox .checked=${state.bindingConfirmed} aria-label=${t("bind", "Use the current {server} card data", { server: state.serverLabel })}
          @change=${(event: Event) => actions.bind((event.target as HTMLInputElement).checked)}></md-checkbox><span>${t("bind", "Use the current {server} card data", { server: state.serverLabel })}</span></label>
        ${segmented<"keep" | "overwrite" | "updates">({
          label: t("existingPolicy", "Existing cards"),
          value: state.confirmation.existingValues ?? "keep",
          options: [
            { value: "keep", label: t("existingKeep", "Keep all existing values") },
            { value: "updates", label: t("existingUpdates", "Only increases") },
            { value: "overwrite", label: t("existingOverwrite", "Overwrite all existing values") },
          ],
          onSelect: value => actions.confirmation(setBoxExistingValues(state.preview!, state.confirmation, value)),
        })}
        <div class="team-builder__actions"><button type="button" class="button button--text" @click=${() => actions.confirmation(selectAvailableBoxItems(state.preview!, state.confirmation, true))}>${t("selectAvailable", "Select available entries")}</button>
          <button type="button" class="button button--text" @click=${() => actions.confirmation(selectAvailableBoxItems(state.preview!, state.confirmation, false))}>${t("clear", "Clear selection")}</button></div>
        <div class="collection collection--member">${model.cards.map(row => {
          const options = actions.card(row.proposal.kind, row.proposal.cardId);
          return html`<div class="team-builder__owned-card" role="group" aria-label=${options?.label ?? t("review", "Needs review")}>
            ${options ? row.blocked ? html`${tileMedia(options)}<strong>${options.title}</strong>` :
              tile({ ...options, href: undefined, itemId: undefined, selected: row.choice.include,
                onOpen: () => actions.confirmation(setBoxCardIncluded(state.confirmation, row.proposal.key, !row.choice.include)) }) : nothing}
            <label class="team-builder__check"><md-checkbox .checked=${row.choice.include} ?disabled=${row.blocked && !row.choice.include}
              aria-label=${`${t("include", "Include")}: ${options?.label ?? t("review", "Needs review")}`}
              @change=${(event: Event) => actions.confirmation(setBoxCardIncluded(state.confirmation, row.proposal.key, (event.target as HTMLInputElement).checked))}></md-checkbox><span>${t("include", "Include")}</span></label>
            <div class="team-builder__practice-control">${row.fields.map(value => field(row.proposal.key, value))}</div>
            ${row.blocked ? html`<small role="status">${t("review", "Needs review")}</small>` : nothing}
          </div>`;
        })}</div>
        ${model.maps.length ? accordion({ id: "team-box-maps", label: t("maps", "Character and item levels"), expanded: actions.expanded?.("box-maps") ?? false,
          onExpandedChange: value => actions.expand?.("box-maps", value), content: html`<div class="team-builder__fields">${model.maps.map(row => html`<div class="team-builder__practice-control">
            <label class="team-builder__check"><md-checkbox .checked=${row.choice.include} ?disabled=${row.blocked && !row.choice.include}
              aria-label=${`${t("include", "Include")}: ${actions.mapName(row.proposal.map, row.proposal.id)}`}
              @change=${(event: Event) => actions.confirmation(setBoxMap(state.confirmation, row.proposal.key, { include: (event.target as HTMLInputElement).checked }))}></md-checkbox><span>${actions.mapName(row.proposal.map, row.proposal.id)}</span></label>
            <small>${t("saved", "Saved")}: ${row.proposal.existing ?? t("unknown", "Unknown")}</small>
            <md-outlined-select label=${t("boxValue", "Box value")} .value=${row.choice.value === undefined ? "auto" : String(row.choice.value)}
              .displayText=${row.value === null ? row.requiresChoice ? t("chooseValue", "Choose a value") : t("unknown", "Unknown") : String(row.value)}
              @change=${(event: Event) => { const value = (event.target as HTMLInputElement).value; actions.confirmation(setBoxMap(state.confirmation, row.proposal.key, { value: value === "auto" ? undefined : value === "keep" ? "keep" : Number(value) })); }}>
              <md-select-option value="auto"><span slot="headline">${row.defaultValue === null ? row.existing && state.confirmation.existingValues !== "overwrite" ? t("unknown", "Unknown") : t("chooseValue", "Choose a value") : String(row.defaultValue)}</span></md-select-option>
              ${row.existing ? html`<md-select-option value="keep"><span slot="headline">${t("keep", "Keep saved value")}: ${row.proposal.existing ?? t("unknown", "Unknown")}</span></md-select-option>` : nothing}
              ${row.proposal.values.map(value => html`<md-select-option value=${String(value)}><span slot="headline">${value}</span></md-select-option>`)}
            </md-outlined-select>
          </div>`)}</div>` }) : nothing}
        ${state.preview.issues.length ? accordion({ id: "team-box-issues", label: t("issues", "Entries needing review"), metadata: state.preview.issues.length,
          expanded: actions.expanded?.("box-issues") ?? false, onExpandedChange: value => actions.expand?.("box-issues", value),
          content: html`<ul class="list">${state.preview.issues.map(issue => html`<li>${issue.kind === "input"
            ? issue.field === "row" ? t("listRow", "Row {row}", { row: issue.id }) : t("review", "Needs review")
            : issue.kind === "members" || issue.kind === "snapshots" ? `${actions.text(issue.kind, issue.kind)} #${issue.id}` : issue.kind === "bandItems" || issue.kind === "characterRanks" ? actions.mapName(issue.kind, issue.id) : t("review", "Needs review")} · ${issue.field === "row"
              ? t("listRowCheck", "Check the card ID, name, type and training values in this row.")
              : html`${actions.fieldName(issue.field)} · ${t("review", "Needs review")}`}</li>`)}</ul>` }) : nothing}
      ` : nothing}
    </div>
    <footer class="selection-pane__footer team-builder__actions">
      ${state.phase === "parsing" ? html`<button type="button" class="button button--outlined" @click=${actions.cancel}>${t("cancel", "Cancel")}</button>` : nothing}
      ${state.phase === "review" ? html`<button type="button" class="button" ?disabled=${!state.canConfirm || !state.bindingConfirmed || !model?.canConfirm} @click=${actions.confirm}>${t("confirm", "Confirm import")}</button>` : nothing}
    </footer>
  </dialog>`;
}
