import { html, nothing, type TemplateResult } from "lit";
import { clientText } from "../../i18n/client";
import { icon } from "../ui/icon";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/textfield/outlined-text-field.js";
import type { BoxCandidate } from "@haneoka/game-data-exporter";
import type { BoxPreview } from "../../lib/team-builder/box-import/preview";
import type { BoxConfirmation } from "../../lib/team-builder/box-import/merge";
import {
  buildBoxImportReview,
  setBoxCardIncluded,
  setBoxField,
  setBoxMap,
  setBoxScalar,
  setBoxExistingValues,
  selectAvailableBoxItems,
  type BoxReviewField,
} from "../../lib/team-builder/box-review-model";
import { tile, tileMedia, type TileOptions } from "../ui/tile";
import { iconButton, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { ANDROID_CHANNELS } from "@haneoka/game-data-exporter";

export interface BoxImportDialogState {
  ownedKeys?: readonly string[];
  usbReady?: boolean;
  usbChannel?: string;
  server?: string;
  phase: "select" | "parsing" | "choose" | "review";
  candidates: readonly BoxCandidate[];
  selectedCandidateId: string;
  preview: BoxPreview | null;
  confirmation: BoxConfirmation;
  serverLabel: string;
  sourceServerLabel?: string;
  progress: { completed: number; total: number } | null;
  /** Owning UI supplies a localized, sanitized error; never the raw parser input. */
  error: string | null;
  canConfirm: boolean;
}
export interface BoxImportDialogActions {
  locale?: string;
  onOpenHistory?: () => void;
  appDownload?: TemplateResult;
  sources?: TemplateResult;
  sourceStatus?: string;
  screenshots?: () => void;
  android?: () => void;
  channel?: (value: string) => void;
  text: (key: string, fallback: string, params?: Record<string, string | number>) => string;
  card: (kind: "members" | "snapshots", id: number) => TileOptions | null;
  mapName: (map: "bandItems" | "characterRanks", id: number) => string;
  fieldName: (field: string) => string;
  noticeName: (path: string) => string;
  files: (files: File[]) => void;
  parseText: (value: string) => void;
  selectCandidate: (id: string) => void;
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
  const channels = ANDROID_CHANNELS.filter((channel) => channel.server === state.server);
  const t = actions.text,
    model = state.preview ? buildBoxImportReview(state.preview, state.confirmation) : null;
  type AccountPatch = { include?: boolean; value?: number | "keep" };
  const accountRows = model
    ? [
        ...model.maps.map((row) => ({
          ...row,
          name: actions.mapName(row.proposal.map, row.proposal.id),
          select: (patch: AccountPatch) => setBoxMap(state.confirmation, row.proposal.key, patch),
        })),
        ...model.scalars.map((row) => ({
          ...row,
          name: actions.fieldName(row.proposal.key),
          select: (patch: AccountPatch) => setBoxScalar(state.confirmation, row.proposal.key, patch),
        })),
      ]
    : [];
  const notices = [...new Map((state.preview?.notices ?? []).map((row) => [`${row.code}:${row.path}`, row])).values()];
  const sourceLabel = (source: BoxReviewField["source"]) =>
    source === "box"
      ? t("boxValue", "Box value")
      : source === "saved"
        ? t("keep", "Keep saved value")
        : source === "conflict"
          ? t("chooseValue", "Choose a value")
          : t("unknown", "Unknown");
  const field = (key: string, row: BoxReviewField) => {
    const selected = state.confirmation.cards.find((choice) => choice.key === key)?.fields?.[row.field];
    const caption = `${sourceLabel(row.defaultSource)}${row.defaultValue === null ? "" : `: ${row.defaultValue}`}`;
    const proposal = state.preview?.cards.find((card) => card.key === key);
    const keepLabel = `${t("keep", "Keep saved value")}: ${proposal?.existing[row.field] ?? t("unknown", "Unknown")}`;
    return row.values.length
      ? html`
          <md-outlined-select
            label=${actions.fieldName(row.field)}
            .value=${selected === undefined ? "auto" : String(selected)}
            .displayText=${selected === "keep" ? keepLabel : selected === undefined ? caption : String(selected)}
            @change=${(event: Event) => {
        const value = (event.target as HTMLInputElement).value;
        actions.confirmation(
          setBoxField(
            state.confirmation,
            key,
            row.field,
            value === "auto" ? undefined : value === "keep" ? "keep" : Number(value),
          ),
        );
      }}
          >
            <md-select-option value="auto"><span slot="headline">${caption}</span></md-select-option>
            ${
        proposal?.existingInstanceId != null
          ? html`
              <md-select-option value="keep"><span slot="headline">${keepLabel}</span></md-select-option>
            `
          : nothing
      }
            ${row.values.map(
        (value) => html`
          <md-select-option value=${String(value)}><span slot="headline">${value}</span></md-select-option>
        `,
      )}
          </md-outlined-select>
        `
      : html`
          <span>
            ${actions.fieldName(row.field)} · ${sourceLabel(row.source)}${row.value === null ? "" : `: ${row.value}`}
          </span>
        `;
  };
  return html`
    <dialog
      class="selection-pane team-builder__box-review"
      aria-label=${t("title", "Import Box")}
      @cancel=${(event: Event) => {
      event.preventDefault();
      actions.close();
    }}
    >
      <header class="sheet__header">
        <div class="team-builder__import-heading">
          <strong>${t("title", "Import Box")}</strong>
          <span class="team-builder__import-server">
            ${
              state.sourceServerLabel
                ? t("serverTransfer", "{source} → {target}", {
                    source: state.sourceServerLabel,
                    target: state.serverLabel,
                  })
                : state.serverLabel
            }
          </span>
        </div>
        ${iconButton({ icon: "close", label: t("close", "Close"), onClick: actions.close })}
      </header>
      <div class="selection-pane__body">
        ${
        state.error
          ? html`
              <p class="team-builder__error" role="alert">${state.error}</p>
            `
          : nothing
      }
        ${
        state.phase === "select"
          ? html`
              ${actions.appDownload ?? nothing}
              <div class="team-builder__import-file">
                  <button
                    type="button"
                    class="button button--tonal"
                    @click=${(event: Event) => ((event.currentTarget as HTMLElement).nextElementSibling as HTMLInputElement | null)?.click()}
                  >
                    ${icon("upload_file")}${t("chooseFiles", "Choose Box files")}
                  </button>
                  <input
                    hidden
                    type="file"
                    multiple
                    @change=${(event: Event) => {
                      const input = event.target as HTMLInputElement;
                      actions.files([...(input.files ?? [])]);
                      input.value = "";
                    }}
                  />
                </div>
                <div class="team-builder__fields">
                <button type="button" class="button button--outlined" @click=${actions.screenshots}>
                  ${t("screenshots", "Screenshots")}
                </button>
                <div class="team-builder__practice-control">
                  ${
          channels.length > 1
            ? html`
                <md-outlined-select
                  label=${t("channel", "Game channel")}
                  .value=${state.usbChannel ?? ""}
                  @change=${(event: Event) => actions.channel?.((event.target as HTMLInputElement).value)}
                >
                  ${channels.map(
            (channel) => html`
              <md-select-option value=${channel.packageId}>
                <span slot="headline">
                  ${t(channel.packageId.endsWith(".official") ? "channelOfficial" : "channelPlay", channel.label)}
                </span>
              </md-select-option>
            `,
          )}
                </md-outlined-select>
              `
            : nothing
        }
                  <button
                    type="button"
                    class="button button--outlined"
                    ?disabled=${!state.usbReady}
                    @click=${actions.android}
                  >
                    ${t("android", "Read Android phone")}
                  </button>
                </div>
                </div>
                ${accordion({
                  id: "team-box-paste",
                  label: t("paste", "Paste Box text"),
                  expanded: actions.expanded?.("box-paste") ?? false,
                  onExpandedChange: (value) => actions.expand?.("box-paste", value),
                  content: html`
                    <div class="team-builder__practice-control">
                  <md-outlined-text-field
                    type="textarea"
                    rows="4"
                    label=${t("paste", "Paste Box text")}
                  ></md-outlined-text-field>
                  <button
                    type="button"
                    class="button button--outlined"
                    @click=${(event: Event) => {
            const input = (event.currentTarget as HTMLElement).parentElement?.querySelector(
              "md-outlined-text-field",
            ) as HTMLElement & { value: string };
            if (input?.value.trim()) actions.parseText(input.value);
          }}
                  >
                    ${t("parse", "Read Box")}
                  </button>
                </div>
              `,
                })}
                ${
                  actions.sources
                    ? accordion({
                        id: "team-box-sources",
                        label: t("otherSources", "Save folders and backups"),
                        expanded: actions.expanded?.("box-sources") ?? false,
                        onExpandedChange: (value) => actions.expand?.("box-sources", value),
                        content: actions.sources,
                      })
                    : nothing
                }
              `
          : nothing
      }
        ${
        state.phase === "parsing"
          ? html`
              <p role="status">
                ${actions.sourceStatus || t("parsing", "Reading Box")}${state.progress ? ` · ${state.progress.completed}/${state.progress.total}` : ""}
              </p>
            `
          : nothing
      }
        ${
        (state.phase === "choose" || state.phase === "review") && state.candidates.length > 1
          ? html`
              <md-outlined-select
                label=${t("candidate", "Choose Box data")}
                .value=${state.selectedCandidateId || "choose"}
                @change=${(event: Event) => {
          const id = (event.target as HTMLInputElement).value;
          if (state.candidates.some((candidate) => candidate.id === id)) actions.selectCandidate(id);
        }}
              >
                <md-select-option value="choose">
                  <span slot="headline">${t("candidate", "Choose Box data")}</span>
                </md-select-option>
                ${state.candidates.map(
          (candidate, index) => html`
            <md-select-option value=${candidate.id}>
              <span slot="headline">
                ${t("candidateCounts", "Data {index}: {members} members, {snapshots} photos, {characters} characters, {items} items", { index: index + 1, members: candidate.members.length, snapshots: candidate.snapshots.length, characters: candidate.characters.length, items: candidate.bandItems.length })}
              </span>
            </md-select-option>
          `,
        )}
              </md-outlined-select>
            `
          : nothing
      }
        ${
        model && state.preview
          ? html`
              <section class="surface team-builder__import-policies">
                  ${
                    state.preview.cards.length
                      ? html`
                          <div class="team-builder__practice-control">
                            <strong class="detail-section-title">${t("ownershipMode", "Members and snapshots")}</strong>
                            ${segmented<"merge" | "replace">({
          label: t("ownershipMode", "Members and snapshots"),
          value: state.confirmation.ownership ?? "merge",
          options: [
            { value: "merge", label: t("mergeOwnership", "Merge ownership") },
            { value: "replace", label: t("replaceOwnership", "Replace member and snapshot ownership") },
          ],
          onSelect: (ownership) => actions.confirmation({ ...state.confirmation, ownership }),
        })}
                          </div>
                        `
                      : nothing
                  }
                  ${
                    state.confirmation.ownership === "replace" ? html`
                          <p>
                            ${t("replaceScope", "Replace all member and snapshot ownership with selected cards · {count} marked not owned. Account bonuses, teams and preferences stay saved.", { count: state.ownedKeys?.filter((key) => !model.cards.some((row) => row.choice.include && key === `${row.proposal.kind === "members" ? "m" : "s"}.${row.proposal.cardId}.own`)).length ?? model.removed })}
                          </p>
                        `
                      : nothing
                  }
                  <div class="team-builder__practice-control">
                    <strong class="detail-section-title">${t("existingPolicy", "Existing cards")}</strong>
                    ${segmented<"keep" | "overwrite" | "updates">({
          label: t("existingPolicy", "Existing cards"),
          value: state.confirmation.existingValues ?? "keep",
          options: [
            { value: "keep", label: t("existingKeep", "Keep all existing values") },
            { value: "updates", label: t("existingUpdates", "Only increases") },
            { value: "overwrite", label: t("existingOverwrite", "Overwrite all existing values") },
          ],
          onSelect: (value) => actions.confirmation(setBoxExistingValues(state.preview!, state.confirmation, value)),
        })}
              </div>
                </section>
                <div class="team-builder__actions">
                <button
                  type="button"
                  class="button button--text"
                  @click=${() => actions.confirmation(selectAvailableBoxItems(state.preview!, state.confirmation, true))}
                >
                  ${t("selectAvailable", "Select available entries")}
                </button>
                <button
                  type="button"
                  class="button button--text"
                  @click=${() => actions.confirmation(selectAvailableBoxItems(state.preview!, state.confirmation, false))}
                >
                  ${t("clear", "Clear selection")}
                </button>
              </div>
              <div class="collection collection--member">
                ${model.cards.map((row) => {
          const options = actions.card(row.proposal.kind, row.proposal.cardId);
          return html`
            <div
              class="team-builder__owned-card"
              ?data-selected=${row.choice.include}
              role="group"
              aria-label=${options?.label ?? t("review", "Needs review")}
            >
              ${
              options
                ? row.blocked
                  ? html`
                      ${tileMedia(options)}
                      <strong>${options.title}</strong>
                    `
                  : tile({
                      ...options,
                      href: undefined,
                      itemId: undefined,
                      selected: row.choice.include,
                      onOpen: () =>
                        actions.confirmation(
                          setBoxCardIncluded(state.confirmation, row.proposal.key, !row.choice.include),
                        ),
                    })
                : nothing
            }
              <label class="team-builder__check">
                <md-checkbox
                  .checked=${row.choice.include}
                  ?disabled=${row.blocked && !row.choice.include}
                  aria-label=${`${t("include", "Include")}: ${options?.label ?? t("review", "Needs review")}`}
                  @change=${(event: Event) => actions.confirmation(setBoxCardIncluded(state.confirmation, row.proposal.key, (event.target as HTMLInputElement).checked))}
                ></md-checkbox>
                <span>${t("include", "Include")}</span>
              </label>
              <div class="team-builder__practice-control">
                ${row.fields.map((value) => field(row.proposal.key, value))}
              </div>
              ${
              row.blocked
                ? html`
                    <small role="status">${t("review", "Needs review")}</small>
                  `
                : nothing
            }
            </div>
          `;
        })}
              </div>
              ${
          accountRows.length
            ? accordion({
                id: "team-box-maps",
                label: t("maps", "Character and item levels"),
                expanded: actions.expanded?.("box-maps") ?? false,
                onExpandedChange: (value) => actions.expand?.("box-maps", value),
                content: html`
                  <div class="team-builder__fields">
                    ${accountRows.map(
                      (row) => html`
                        <div class="team-builder__practice-control">
                          <label class="team-builder__check">
                            <md-checkbox
                              .checked=${row.choice.include}
                              ?disabled=${row.blocked && !row.choice.include}
                              aria-label=${`${t("include", "Include")}: ${row.name}`}
                              @change=${(event: Event) => actions.confirmation(row.select({ include: (event.target as HTMLInputElement).checked }))}
                            ></md-checkbox>
                            <span>${row.name}</span>
                          </label>
                          <small>${t("saved", "Saved")}: ${row.proposal.existing ?? t("unknown", "Unknown")}</small>
                          <md-outlined-select
                            label=${t("boxValue", "Box value")}
                            .value=${row.choice.value === undefined ? "auto" : String(row.choice.value)}
                            .displayText=${row.value === null ? (row.requiresChoice ? t("chooseValue", "Choose a value") : t("unknown", "Unknown")) : String(row.value)}
                            @change=${(event: Event) => {
                const value = (event.target as HTMLInputElement).value;
                actions.confirmation(
                  row.select({ value: value === "auto" ? undefined : value === "keep" ? "keep" : Number(value) }),
                );
              }}
                          >
                            <md-select-option value="auto">
                              <span slot="headline">
                                ${row.defaultValue === null ? t("chooseValue", "Choose a value") : String(row.defaultValue)}
                              </span>
                            </md-select-option>
                            ${
                row.existing
                  ? html`
                      <md-select-option value="keep">
                        <span slot="headline">
                          ${t("keep", "Keep saved value")}: ${row.proposal.existing ?? t("unknown", "Unknown")}
                        </span>
                      </md-select-option>
                    `
                  : nothing
              }
                            ${row.proposal.values.map(
                (value) => html`
                  <md-select-option value=${String(value)}><span slot="headline">${value}</span></md-select-option>
                `,
              )}
                          </md-outlined-select>
                          ${
              row.blocked
                ? html`
                    <small role="status">${t("review", "Needs review")}</small>
                  `
                : nothing
            }
                        </div>
                      `,
                    )}
                  </div>
                `,
              })
            : nothing
        }
              ${
          notices.length
            ? accordion({
                id: "team-box-notices",
                label: t("notImported", "Fields not imported"),
                metadata: notices.length,
                expanded: actions.expanded?.("box-notices") ?? false,
                onExpandedChange: (value) => actions.expand?.("box-notices", value),
                content: actions.expanded?.("box-notices")
                  ? html`
                      <ul class="list">
                        ${notices.map(
                          (row) => html`
                            <li>${actions.noticeName(row.path)} · ${t(`notice.${row.code}`, "Needs review")}</li>
                          `,
                        )}
                      </ul>
                    `
                  : nothing,
              })
            : nothing
        }
              ${
          state.preview.issues.length
            ? accordion({
                id: "team-box-issues",
                label: t("issues", "Entries needing review"),
                metadata: state.preview.issues.length,
                expanded: actions.expanded?.("box-issues") ?? false,
                onExpandedChange: (value) => actions.expand?.("box-issues", value),
                content: html`
                  <ul class="list">
                    ${state.preview.issues.map(
                      (issue) => html`
                        <li>
                          ${
                            issue.kind === "input"
                              ? issue.field === "row"
                                ? t("listRow", "Row {row}", { row: issue.id })
                                : t("review", "Needs review")
                              : issue.kind === "members" || issue.kind === "snapshots"
                                ? `${actions.text(issue.kind, issue.kind)} #${issue.id}`
                                : issue.kind === "bandItems" || issue.kind === "characterRanks"
                                  ? actions.mapName(issue.kind, issue.id)
                                  : t("review", "Needs review")
                          }
                          ·
                          ${
                            issue.code === "unavailable_target_card" || issue.code === "unavailable_target_entity"
                              ? t("unavailableTarget", "Not in the target server's catalogue")
                              : issue.field === "row"
                              ? t("listRowCheck", "Check the card ID, name, type and training values in this row.")
                              : html`
                                  ${actions.fieldName(issue.field)} · ${t("review", "Needs review")}
                                `
                          }
                        </li>
                      `,
                    )}
                  </ul>
                `,
              })
            : nothing
        }
            `
          : nothing
      }
      </div>
      <footer class="selection-pane__footer team-builder__actions">
        ${
          model
            ? html`
          <span class="team-builder__import-count" role="status">
                  ${t("selectedEntries", "{count} selected", { count: model.included })}
                </span>
              ` : nothing
        }
        ${
          state.phase === "select" && actions.onOpenHistory
            ? html`
          <button type="button" class="button button--tonal" @click=${actions.onOpenHistory}>
            ${icon("history")}${clientText(actions.locale ?? "ja", "catalog.gachaHistory.title", "Gacha history")}
          </button>
        ` : nothing
        }
        ${
        state.phase === "parsing"
          ? html`
              <button type="button" class="button button--outlined" @click=${actions.cancel}>
                ${t("cancel", "Cancel")}
              </button>
            `
          : nothing
      }
        ${
        state.phase === "review"
          ? html`
              <button
                type="button"
                class="button"
                ?disabled=${!state.canConfirm || !model?.canConfirm}
                @click=${actions.confirm}
              >
                ${t("confirm", "Confirm import")}
              </button>
            `
          : nothing
      }
      </footer>
    </dialog>
  `;
}
