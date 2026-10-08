import { LitElement, html, nothing } from "lit";
import "../styles/chart-creation-collections.css";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/slider/slider.js";
import type { Project } from "../../packages/chart-editor/src/model";
import {
  readAuthorCollections,
  authorSelectionForScope,
  cycleAuthorCollection,
  type AuthorCollections,
  type AuthorGroup,
  type AuthorLayer,
  type CollectionKind,
} from "../../packages/chart-editor/src/creation/collections";
import type { AuthorCollectionOperation } from "../../packages/chart-editor/src/creation/collections-history";
import { clientText } from "../i18n/client";
import { iconButton, segmented } from "./ui/controls";

export interface ChartCollectionScope {
  groupId?: string;
  layerId?: string;
}

/** Controlled sidebar: all project writes use the workspace's existing history. */
export class ChartCreationCollections extends LitElement {
  static properties = {
    locale: {},
    project: { attribute: false },
    selection: { attribute: false },
    scope: { attribute: false },
    busy: { type: Boolean },
    forceSpeedAvailable: { type: Boolean },
    globalNoteSpeed: { type: Number },
    onOperation: { attribute: false },
    onScope: { attribute: false },
    onSelect: { attribute: false },
    kind: { state: true },
    name: { state: true },
    deleting: { state: true },
  };
  declare locale: string;
  declare project: Project | undefined;
  declare selection: ReadonlySet<string>;
  declare scope: ChartCollectionScope;
  declare busy: boolean;
  declare forceSpeedAvailable: boolean;
  declare globalNoteSpeed: number;
  declare onOperation: ((operation: AuthorCollectionOperation) => boolean) | undefined;
  declare onScope: ((scope: ChartCollectionScope) => void) | undefined;
  declare onSelect: ((ids: string[]) => void) | undefined;
  declare private kind: CollectionKind;
  declare private name: string;
  declare private deleting: string;

  constructor() {
    super();
    this.locale = "en";
    this.selection = new Set();
    this.scope = {};
    this.busy = false;
    this.forceSpeedAvailable = false;
    this.globalNoteSpeed = 5;
    this.kind = "group";
    this.name = "";
    this.deleting = "";
  }
  createRenderRoot() {
    return this;
  }
  private t(key: string) {
    return clientText(this.locale, `chartEditorPage.collections.${key}`);
  }
  private c(key: string) {
    return clientText(this.locale, key);
  }
  private get scopeKey() {
    return this.kind === "group" ? "groupId" : "layerId";
  }
  private apply(operation: AuthorCollectionOperation) {
    return !this.busy && Boolean(this.onOperation?.(operation));
  }
  private setScope(id?: string) {
    if (!this.busy) this.onScope?.({ ...this.scope, [this.scopeKey]: id });
  }
  private add() {
    if (!this.name.trim()) return;
    if (this.apply({ type: "create", kind: this.kind, name: this.name })) this.name = "";
  }
  private removeCollection(id: string, members: "detach" | "delete") {
    if (!this.apply({ type: "delete", kind: this.kind, id, members })) return;
    if (this.scope[this.scopeKey] === id) this.setScope();
    this.deleting = "";
  }
  private assignment(state: AuthorCollections, kind: CollectionKind) {
    const key = kind === "group" ? "groupId" : "layerId";
    const values = new Set([...this.selection].map((id) => state.members[id]?.[key] ?? ""));
    const value = values.size > 1 ? "__mixed__" : (values.values().next().value ?? "");
    const items = kind === "group" ? state.groups : state.layers;
    return html`
      <md-outlined-select
        label=${this.t(`assign_${kind}`)}
        .value=${value}
        ?disabled=${this.busy || !this.selection.size}
        @change=${(event: Event) => {
          const id = (event.target as HTMLSelectElement).value;
          if (id !== "__mixed__") this.apply({ type: "assign", ids: [...this.selection], [key]: id || null });
        }}
      >
        <md-select-option value=""><div slot="headline">${this.t("unassigned")}</div></md-select-option>
        ${
          value === "__mixed__"
            ? html`
                <md-select-option value="__mixed__" disabled>
                  <div slot="headline">${this.t("mixed")}</div>
                </md-select-option>
              `
            : nothing
        }
        ${items.map(
          (item) => html`
            <md-select-option value=${item.id}><div slot="headline">${item.name}</div></md-select-option>
          `,
        )}
      </md-outlined-select>
    `;
  }
  private row(item: AuthorGroup | AuthorLayer, index: number, length: number) {
    const visible = !("visible" in item) || item.visible;
    const active = this.scope[this.scopeKey] === item.id;
    const members = this.project
      ? [...authorSelectionForScope(this.project, { ...this.scope, [this.scopeKey]: item.id })]
      : [];
    return html`
      <li class="chart-collections__row" data-active=${String(active)}>
        <div class="chart-collections__identity chart-creation__form">
          ${iconButton({
            icon: "filter_alt",
            label: item.name,
            toggle: true,
            pressed: active,
            disabled: this.busy,
            onClick: () => this.setScope(active ? undefined : item.id),
          })}
          <md-outlined-text-field
            aria-label=${this.t(`${this.kind}_name`)}
            .value=${live(item.name)}
            ?disabled=${this.busy}
            @change=${(event: Event) => {
              const field = event.target as HTMLInputElement;
              if (
                field.value !== item.name &&
                !this.apply({ type: "rename", kind: this.kind, id: item.id, name: field.value })
              )
                field.value = item.name;
            }}
          ></md-outlined-text-field>
        </div>
        ${this.kind === "group" && this.forceSpeedAvailable && !("visible" in item) ? html`
          <div class="chart-creation__form" data-group-speed=${item.id}>
            <label>
              <md-checkbox aria-label=${`${item.name} ${this.t("force_speed")}`}
                .checked=${item.forceNoteSpeed !== undefined} ?disabled=${this.busy}
                @change=${async (event: Event) => {
                  const field = event.target as HTMLElementTagNameMap["md-checkbox"];
                  if (!this.apply({ type: "group-speed", id: item.id,
                    speed: field.checked ? (item.forceNoteSpeed ?? this.globalNoteSpeed) : null })) {
                    // Let Material render the attempted state before restoring its host property.
                    await field.updateComplete;
                    const current = this.project ? readAuthorCollections(this.project).groups.find(group => group.id === item.id) : item;
                    field.checked = current?.forceNoteSpeed !== undefined;
                  }
                }}></md-checkbox>
              ${this.t("force_speed")}
            </label>
            <md-slider class="md3-slider" labeled aria-label=${`${item.name} ${this.c("chartPlayer.noteSpeed")}`}
              min="1" max="14" step="0.1" .value=${item.forceNoteSpeed ?? this.globalNoteSpeed}
              ?disabled=${this.busy || item.forceNoteSpeed === undefined || item.forceNoteSpeed < 1 || item.forceNoteSpeed > 14}
              @change=${async (event: Event) => {
                const field = event.target as HTMLElementTagNameMap["md-slider"];
                if (!this.apply({ type: "group-speed", id: item.id, speed: Number(field.value) })) {
                  await field.updateComplete;
                  const current = this.project ? readAuthorCollections(this.project).groups.find(group => group.id === item.id) : item;
                  field.value = current?.forceNoteSpeed ?? this.globalNoteSpeed;
                }
              }}></md-slider>
            <md-outlined-text-field type="number" min="1" max="14" step="0.1"
              label=${`${item.name} ${this.c("chartPlayer.noteSpeed")}`} .value=${live(String(item.forceNoteSpeed ?? this.globalNoteSpeed))}
              ?disabled=${this.busy || item.forceNoteSpeed === undefined}
              @change=${(event: Event) => {
                const field = event.target as HTMLInputElement, speed = Number(field.value);
                if (!field.value.trim() || !Number.isFinite(speed) || speed < 1 || speed > 14 || !this.apply({ type: "group-speed", id: item.id, speed }))
                  field.value = String(item.forceNoteSpeed ?? this.globalNoteSpeed);
              }}></md-outlined-text-field>
            ${item.forceNoteSpeed === undefined ? html`<span>${this.t("force_speed_inherit")}</span>` :
              item.forceNoteSpeed < 1 || item.forceNoteSpeed > 14 ? html`<span role="status">${this.t("force_speed_invalid")}</span>` : nothing}
          </div>` : nothing}
        <div class="chart-collections__row-actions chart-creation__actions">
          ${
            "visible" in item
              ? iconButton({
                  icon: visible ? "visibility" : "visibility_off",
                  label: this.t(visible ? "hide_layer" : "show_layer"),
                  toggle: true,
                  pressed: visible,
                  disabled: this.busy,
                  onClick: () => this.apply({ type: "visibility", id: item.id, visible: !visible }),
                })
              : nothing
          }
          ${iconButton({
            icon: "center_focus_strong",
            label: this.t("select_members"),
            disabled: this.busy || !members.length,
            onClick: () => {
              this.setScope(item.id);
              this.onSelect?.(members);
            },
          })}
          ${iconButton({
            icon: "arrow_upward",
            label: this.t("move_up"),
            disabled: this.busy || index === 0,
            onClick: () => this.apply({ type: "reorder", kind: this.kind, id: item.id, index: index - 1 }),
          })}
          ${iconButton({
            icon: "arrow_downward",
            label: this.t("move_down"),
            disabled: this.busy || index === length - 1,
            onClick: () => this.apply({ type: "reorder", kind: this.kind, id: item.id, index: index + 1 }),
          })}
          ${iconButton({
            icon: "delete",
            label: this.t(`delete_${this.kind}`),
            disabled: this.busy,
            onClick: () => {
              this.deleting = this.deleting === item.id ? "" : item.id;
            },
          })}
        </div>
        ${
          this.deleting === item.id
            ? html`
                <div class="chart-collections__delete" role="group" aria-label=${this.t(`delete_${this.kind}`)}>
                  <p>${this.t("delete_choice")}</p>
                  <button
                    class="button button--tonal"
                    ?disabled=${this.busy}
                    @click=${() => this.removeCollection(item.id, "detach")}
                  >
                    ${this.t("keep_notes")}
                  </button>
                  <button
                    class="button button--text"
                    ?disabled=${this.busy}
                    @click=${() => this.removeCollection(item.id, "delete")}
                  >
                    ${this.t("delete_notes")}
                  </button>
                  <button
                    class="button button--text"
                    @click=${() => {
                      this.deleting = "";
                    }}
                  >
                    ${this.c("cancel")}
                  </button>
                </div>
              `
            : nothing
        }
      </li>
    `;
  }
  render() {
    if (!this.project) return nothing;
    const state = readAuthorCollections(this.project);
    const items = this.kind === "group" ? state.groups : state.layers;
    return html`
      <section
        class="chart-collections"
        aria-label=${this.t("title")}
        @keydown=${(event: KeyboardEvent) => {
          if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            event.stopPropagation();
        }}
      >
        ${segmented({
          label: this.t("title"),
          value: this.kind,
          grow: true,
          options: [
            { value: "group", label: this.t("groups") },
            { value: "layer", label: this.t("layers") },
          ],
          onSelect: (kind) => {
            this.kind = kind;
            this.name = "";
            this.deleting = "";
          },
        })}
        <div class="chart-collections__scope chart-creation__actions">
          ${iconButton({
            icon: "chevron_left",
            label: this.t("previous"),
            disabled: this.busy || !items.length,
            onClick: () =>
              this.setScope(cycleAuthorCollection(this.project!, this.kind, this.scope[this.scopeKey], -1)),
          })}
          <button
            class="button button--tonal"
            aria-pressed=${String(!this.scope[this.scopeKey])}
            ?disabled=${this.busy}
            @click=${() => this.setScope()}
          >
            ${this.t(this.kind === "group" ? "all_groups" : "all_layers")}
          </button>
          ${iconButton({
            icon: "chevron_right",
            label: this.t("next"),
            disabled: this.busy || !items.length,
            onClick: () => this.setScope(cycleAuthorCollection(this.project!, this.kind, this.scope[this.scopeKey], 1)),
          })}
        </div>
        <ul class="chart-collections__list">
          ${repeat(
            items,
            (item) => item.id,
            (item, index) => this.row(item, index, items.length),
          )}
        </ul>
        ${
          !items.length
            ? html`
                <p class="chart-collections__hint">
                  ${this.t(this.kind === "group" ? "empty_groups" : "empty_layers")}
                </p>
              `
            : nothing
        }
        <form
          class="chart-collections__add chart-creation__form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.add();
          }}
        >
          <md-outlined-text-field
            label=${this.t(`${this.kind}_name`)}
            .value=${live(this.name)}
            ?disabled=${this.busy}
            @input=${(event: Event) => {
              this.name = (event.target as HTMLInputElement).value;
            }}
          ></md-outlined-text-field>
          <button type="submit" class="button button--tonal" ?disabled=${this.busy || !this.name.trim()}>
            ${this.t(`add_${this.kind}`)}
          </button>
        </form>
        <div class="chart-collections__assignment chart-creation__form">
          ${this.assignment(state, "group")} ${this.assignment(state, "layer")}
        </div>
      </section>
    `;
  }
}
if (!customElements.get("chart-creation-collections"))
  customElements.define("chart-creation-collections", ChartCreationCollections);
