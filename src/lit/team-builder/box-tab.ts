import { CARD_SKILL_FACETS } from "../../lib/catalog-filters";
import { matchesCardFilters, renderCardFilters } from "./card-filters";
import { ptField } from "./pt-fields";
/** My cards: quick ownership entry, participation and growth, with filters and bulk edits. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import { ownMemberChanges, ownSnapChanges, type OwnedMember, type OwnedSnap } from "../../lib/team-builder/sync/box-view";
import { iconButton, segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";
import { tileMedia } from "../ui/tile";
import { growthSteps } from "../ui/growth-steps";
import type { TeamBuilder } from "../team-builder";
import { renderResourceSort, sortedCards } from "./catalog-sort";
import { chooserGroup } from "../ui/chooser-filters";

type Kind = "members" | "snaps";
interface Row {
  kind: Kind;
  id: number;
  owned: OwnedMember | OwnedSnap | undefined;
}

export function visibleCards(host: TeamBuilder): Row[] {
  const catalog = host.catalog!;
  const view = host.view!;
  const f = host.filters;
  const kind = f.kind;
  const ids = Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number);
  const owned = kind === "members" ? view.members : view.snaps;
  return sortedCards(host, kind, ids
    .filter((id) => host.boxQuickEntry || (f.show === "owned" ? owned.has(id) : f.show === "unowned" ? !owned.has(id) : true))
    .filter((id) => matchesCardFilters(host, kind, id, f)))
    .map((id) => ({ kind, id, owned: owned.get(id) }));
}

const prefix = (kind: Kind) => (kind === "members" ? "m" : "s");
function clearRequiredChanges(host: TeamBuilder) {
  return Object.entries(host.snapshot?.entries ?? {})
    .filter(([key, entry]) => /^[ms]\.[1-9]\d*\.lock$/u.test(key) && entry.v === true)
    .map(([key]) => ({ key, value: false }));
}
/** Bulk edits keep the previous values for one undo. */
function bulk(host: TeamBuilder, label: string, changes: { key: string; value: BoxValue }[]) {
  if (!changes.length || !host.snapshot) return;
  const previous = changes.map(({ key }) => ({ key, value: (host.snapshot!.entries[key]?.v ?? null) as BoxValue }));
  host.write(changes);
  host.notice = label;
  undo = { notice: label, changes: previous, store: host.store, owner: host.snapshot.owner };
  host.requestUpdate();
}
/** The last bulk edit's previous values, offered while its snackbar shows. */
let undo: { notice: string; changes: { key: string; value: BoxValue }[]; store: TeamBuilder["store"]; owner: string | null | undefined } | null = null;

export function renderUndoAction(host: TeamBuilder) {
  if (!undo || undo.notice !== host.notice || undo.store !== host.store || undo.owner !== host.snapshot?.owner) return nothing;
  const changes = undo.changes;
  return html`<button class="button button--text" type="button" @click=${() => {
    host.write(changes);
    undo = null;
    host.notice = "";
    host.requestUpdate();
  }}>${host.t("undo", "Undo")}</button>`;
}

function maxChanges(host: TeamBuilder, row: Row): { key: string; value: BoxValue }[] {
  const catalog = host.catalog!;
  if (row.kind === "members") {
    const limits = catalog.memberLimits(row.id, null);
    if (!limits) return [];
    return ownMemberChanges(row.id, { level: limits.level, awake: limits.awake, rank: limits.rank, skill: limits.liveSkillLevel, gekisoSkill: limits.gekisoSkillLevel });
  }
  const limits = catalog.snapLimits(row.id, null);
  return limits ? ownSnapChanges(row.id, { level: limits.level, rank: limits.rank }) : [];
}

function renderCard(host: TeamBuilder, row: Row): TemplateResult {
  const catalog = host.catalog!;
  const quick = host.boxQuickEntry;
  const options = catalog.cardOptions(row.kind, row.id, quick ? null : undefined);
  if (!options) return html``;
  const owned = row.owned;
  const using = !!owned && (quick || owned.use);
  const toggle = () => {
    const p = prefix(row.kind);
    if (quick) host.write([{ key: `${p}.${row.id}.own`, value: !owned }]);
    else if (!owned) host.write([{ key: `${p}.${row.id}.own`, value: true }, { key: `${p}.${row.id}.use`, value: true }]);
    else host.write([{ key: `${p}.${row.id}.use`, value: !owned.use }]);
  };
  const checkLabel = owned ? host.t("useInSearch", "Use in team search") : host.t("markOwned", "Mark as owned");
  return html`
    <div class=${`tile tile--${row.kind === "members" ? "member" : "support"} tb-card${owned ? "" : " is-unowned"}${using ? " is-used" : ""}${quick && owned ? " is-selected" : ""}${owned?.lock ? " is-locked" : ""}`}>
      <span class="tb-card__media">
        <button class="tb-card__open" type="button" aria-pressed=${quick ? String(!!owned) : nothing}
          aria-label=${`${quick ? host.t("showOwned", "Owned") : host.t("editGrowth", "Edit growth")}: ${options.label}`}
          @click=${() => {
            if (quick) { toggle(); return; }
            host.editing = { kind: row.kind, cardId: row.id };
            host.requestUpdate();
          }}>
          ${tileMedia(owned || quick ? options : { ...options, marks: [...(options.marks ?? []), { at: "bottom-start", text: host.t("notOwned", "Not owned") }] })}
          ${quick ? html`<span class="tb-card__selection" aria-hidden="true">${owned ? icon("check", 16) : nothing}</span>` : nothing}
        </button>
        ${quick ? nothing : html`<button class="tb-card__check" type="button" role="checkbox" aria-checked=${String(using)}
          aria-label=${`${checkLabel}: ${options.label}`} title=${checkLabel} @click=${toggle}>
          <span class="tb-card__selection" aria-hidden="true">${using ? icon("check", 16) : nothing}</span>
        </button>`}
        ${!quick && owned?.lock ? html`<span class="tb-card__lock" title=${host.t("required", "Always include")}>${icon("push_pin", 16)}</span>` : nothing}
      </span>
      <span class="tile__identity">
        <strong class="tile__title" lang=${options.titleLanguage || nothing}>${options.title}</strong>
        <small class="tile__subtitle">${options.adornment ?? nothing}<span>${options.subtitle}</span></small>
      </span>
    </div>
  `;
}

const clearing = new WeakMap<
  TeamBuilder,
  { store: TeamBuilder["store"]; owner: string | null | undefined; changes: { key: string; value: BoxValue }[] }
>();

function clearOwnershipDialog(host: TeamBuilder) {
  const pending = clearing.get(host);
  if (!pending) return nothing;
  const close = () => {
    clearing.delete(host);
    host.requestUpdate();
  };
  return html`
    <dialog ${modal(close)} class="dialog" aria-labelledby="tb-clear-ownership-title">
      <header class="dialog__header"><h2 id="tb-clear-ownership-title">${host.t("clearOwnership", "Mark all members and snapshots not owned")}</h2></header>
      <p class="dialog__body">
        ${host.t("clearOwnershipScope", "{count} owned cards. Training values, account bonuses, teams and preferences stay saved.", { count: pending.changes.length })}
      </p>
      <div class="dialog__actions">
        <button class="button button--text" type="button" @click=${close}>
          ${host.common("common.actions.cancel", "Cancel")}
        </button>
        <button
          class="button"
          type="button"
          @click=${() => {
        if (host.store === pending.store && host.snapshot?.owner === pending.owner)
          bulk(
            host,
            host.t("clearedOwnership", "Marked {count} members and snapshots not owned", {
              count: pending.changes.length,
            }),
            pending.changes,
          );
        close();
      }}
        >
          ${host.t("clearOwnershipConfirm", "Mark all not owned")}
        </button>
      </div>
    </dialog>
  `;
}

export function renderBoxTab(host: TeamBuilder): TemplateResult {
  const view = host.view!;
  const f = host.filters;
  const rows = visibleCards(host);
  const set = (patch: Partial<typeof f>) => {
    host.filters = { ...f, ...patch };
    host.requestUpdate();
  };
  const ownedRows = rows.filter((row) => row.owned);
  const activeFilters = f.bands.length + f.characters.length + f.attributes.length + f.rarities.length + Object.values(f.facets).reduce((sum, values) => sum + values.length, 0);
  const ownedCount = f.kind === "members" ? view.members.size : view.snaps.size;
  const usedCount = [...(f.kind === "members" ? view.members : view.snaps).values()].filter((row) => row.use).length;
  const requiredCount = clearRequiredChanges(host).length;
  return html`
    <div class=${`tb-box${host.pt.showIssues && host.pt.issues.some((issue) => issue.code === "inventory") ? " pt-field--invalid" : ""}`} data-pt-field="inventory" tabindex="-1">
      
      <div class="row row--wrap tb-box__import-entry">
        ${segmented({
          label: host.t("boxImport.libraryServer", "Card library server"),
          value: host.data!.identity.server,
          grow: false,
          options: [
            { value: "jp", label: host.t("boxImport.servers.jp", "Japan") },
            { value: "intl", label: host.t("boxImport.servers.intl", "International") },
          ],
          onSelect: (server) => host.switchServer(server),
        })}
        <span class="row__spacer"></span>
        ${host.boxQuickEntry ? nothing : html`
          <button class="button button--tonal" type="button" @click=${() => host.imports.openBox()}>${icon("upload_file", 18)}${host.t("importBox", "Import")}</button>
          <button class="button button--text" type="button" @click=${() => host.imports.exportJson()}>${icon("download", 18)}${host.common("common.actions.export", "Export")}</button>
        `}
      </div>
      <div class="surface tb-toolbar">
        <div class="row row--wrap tb-toolbar__row">
          ${segmented({
            label: host.t("cardKind", "Card kind"),
            value: f.kind,
            grow: false,
            options: [
              { value: "members", label: host.t("members", "Members"), icon: "person" },
              { value: "snaps", label: host.t("snapshots", "Snaps"), icon: "photo" },
            ],
            onSelect: (kind) => {
              const presentation = kind === "members" ? "member" : "support";
              const inactive = new Set(CARD_SKILL_FACETS.filter((facet) => !(facet.kinds as readonly string[]).includes(presentation)).map((facet) => facet.key as string));
              set({kind, facets: Object.fromEntries(Object.entries(f.facets).filter(([key]) => !inactive.has(key)))});
            },
          })}
          ${host.boxQuickEntry ? nothing : segmented({
            label: host.t("showCards", "Show"),
            value: f.show,
            grow: false,
            options: [
              { value: "owned", label: host.t("showOwned", "Owned") },
              { value: "all", label: host.t("showAll", "All") },
              { value: "unowned", label: host.t("showUnowned", "Not owned") },
            ],
            onSelect: (show) => set({ show }),
          })}
          ${iconButton({
            icon: "filter_list",
            label: host.t("filters", "Filters"),
            toggle: true,
            pressed: host.filtersOpen,
            badge: activeFilters,
            onClick: () => {
              host.filtersOpen = !host.filtersOpen;
              host.requestUpdate();
            },
          })}
        </div>
        ${host.filtersOpen
          ? html`
              <div class="chooser-filters">${renderCardFilters(host, f, set)}${chooserGroup(host.common("common.actions.sort", "Sort"), renderResourceSort(host, f.kind))}</div>
            `
          : nothing}
        <div class="row row--wrap tb-toolbar__row tb-bulk">
          <span class="tb-bulk__summary">${host.boxQuickEntry
            ? host.t("quickEntrySummary", "{owned} owned · {shown} shown", { owned: ownedCount, shown: rows.length })
            : host.t("boxSummary", "{owned} owned · {used} in search · {shown} shown", { owned: ownedCount, used: usedCount, shown: rows.length })}</span>
          <span class="row__spacer"></span>
          <button class="button button--text button--small" type="button" ?disabled=${!rows.length}
            @click=${() => bulk(host, host.t("bulkOwned", "Marked {count} cards as owned", { count: rows.length }), rows.flatMap((row) => [{ key: `${prefix(row.kind)}.${row.id}.own`, value: true }, ...(row.owned || host.boxQuickEntry ? [] : [{ key: `${prefix(row.kind)}.${row.id}.use`, value: true }])]))}>
            ${icon("library_add_check", 18)}${host.boxQuickEntry ? host.t("quickOwnAll", "Select all") : host.t("bulkOwn", "Own all shown")}</button>
          ${host.boxQuickEntry ? nothing : html`
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkUsedDone", "{count} cards take part", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: true })))}>
            ${icon("check_box", 18)}${host.t("bulkUse", "Use all")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkUnusedDone", "{count} cards left out", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: false })))}>
            ${icon("check_box_outline_blank", 18)}${host.t("bulkUnuse", "Use none")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkMaxDone", "Set {count} cards to full growth", { count: ownedRows.length }), ownedRows.flatMap((row) => maxChanges(host, row)))}>
            ${icon("upgrade", 18)}${host.t("bulkMax", "Full growth")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!requiredCount} @click=${() => {
            const changes = clearRequiredChanges(host);
            bulk(host, host.t("clearRequiredDone", "Cleared required marks on {count} cards", { count: changes.length }), changes);
          }}>${host.t("clearRequired", "Clear all required marks")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!view.members.size && !view.snaps.size} @click=${() => {
            clearing.set(host, { store: host.store, owner: host.snapshot?.owner, changes: Object.entries(host.snapshot?.entries ?? {}).filter(([key, entry]) => /^[ms]\.[1-9]\d*\.own$/u.test(key) && entry.v === true).map(([key]) => ({ key, value: false })) });
            host.requestUpdate();
          }}>${host.t("clearOwnership", "Mark all members and snapshots not owned")}</button>
          `}
        </div>
      </div>
      ${clearOwnershipDialog(host)}
      ${rows.length
        ? html`<div class=${`collection collection--${f.kind === "members" ? "member" : "support"} tb-grid${host.boxQuickEntry ? " tb-grid--quick" : ""}`}>${rows.map((row) => renderCard(host, row))}</div>`
        : html`<div class="state"><p class="state__title">${!host.boxQuickEntry && f.show === "owned" && !ownedCount ? host.t("emptyBox", "No cards yet") : host.t("noMatches", "No cards match")}</p>
            ${!host.boxQuickEntry && f.show === "owned" && !ownedCount ? html`<div class="state__actions"><button class="button" type="button" @click=${() => set({ show: "all" })}>${host.t("showAll", "All")}</button><button class="button button--tonal" type="button" @click=${() => host.imports.openBox()}>${host.t("importBox", "Import")}</button></div>` : nothing}</div>`}
    </div>
  `;
}

/** Growth editor; every change is saved at once. */
export function renderCardEditor(host: TeamBuilder): TemplateResult | typeof nothing {
  const editing = host.editing;
  if (!editing || !host.catalog || !host.view) return nothing;
  const catalog = host.catalog;
  const { kind, cardId } = editing;
  const options = catalog.cardOptions(kind, cardId);
  if (!options) return nothing;
  const close = () => {
    host.editing = null;
    host.requestUpdate();
  };
  const p = prefix(kind);
  const owned = kind === "members" ? host.view.members.get(cardId) : host.view.snaps.get(cardId);
  const characterId = kind === "members" ? catalog.member(cardId)?.characterId : undefined;
  const characterRequired = characterId !== undefined && !owned?.lock && [...host.view.members.values()].some(
    (row) => row.cardId !== cardId && row.lock && catalog.member(row.cardId)?.characterId === characterId,
  );
  const write = (field: string, value: BoxValue) => {
    const changes = [{ key: `${p}.${cardId}.${field}`, value }];
    // Lowering training or limit break lowers the cap; a level above it cannot exist in the game.
    const capField = kind === "members" ? "awk" : "rnk";
    if (field === capField && typeof value === "number" && owned?.level != null) {
      const cap = (kind === "members" ? catalog.memberLimits(cardId, value) : catalog.snapLimits(cardId, value))?.levelCap;
      if (cap !== undefined && owned.level > cap) changes.push({ key: `${p}.${cardId}.lvl`, value: cap });
    }
    host.write([...(owned ? [] : [{ key: `${p}.${cardId}.own`, value: true }, { key: `${p}.${cardId}.use`, value: true }]), ...changes]);
  };
  const fieldKey = (field: string) => `${kind === "members" ? "m" : "s"}${cardId}.${({ awk: "awake", lvl: "level", rnk: "rank", sk: "liveSkillLevel", gsk: "gekisoSkillLevel" } as Record<string,string>)[field] ?? field}`;
  const steps = (label: string, field: string, value: number | null, max: number) => ptField(host, fieldKey(field),
    growthSteps(label, value, Array.from({ length: max }, (_, index) => index + 1), kind === "snaps" && field === "rnk", next => write(field, next)));
  const levelField = (value: number | null, cap: number) => ptField(host, fieldKey("lvl"), html`
    <div class="tb-field">
      <span class="tb-field__label">${host.t("level", "Level")}<output>${value === null ? "—" : Math.min(value, cap)} / ${cap}</output></span>
      <div class="tb-field__level">
        <input class="tb-stepper__value" type="number" inputmode="numeric" min="1" max=${cap} step="1" placeholder="—" aria-label=${host.t("level", "Level")}
          .value=${live(value === null ? "" : String(Math.min(value, cap)))}
          @input=${(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            if (input.validity.valid) write("lvl", input.value === "" ? null : input.valueAsNumber);
          }}
          @change=${(event: Event) => {
            const input = event.currentTarget as HTMLInputElement;
            if (input.validity.badInput) {
              input.value = value === null ? "" : String(Math.min(value, cap));
              return;
            }
            const next = input.value === "" ? null : Math.max(1, Math.min(cap, Math.round(input.valueAsNumber)));
            input.value = next === null ? "" : String(next);
            write("lvl", next);
          }} />
        <md-slider class="md3-slider" labeled min="1" max=${cap} .value=${live(Math.min(value ?? cap, cap))} aria-label=${host.t("level", "Level")}
          @input=${(event: Event) => write("lvl", Number((event.currentTarget as HTMLInputElement).value))}
          @change=${(event: Event) => write("lvl", Number((event.currentTarget as HTMLInputElement).value))}
          @click=${(event: Event) => write("lvl", Number((event.currentTarget as HTMLInputElement).value))}
          @keyup=${(event: KeyboardEvent) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key))
              write("lvl", Number((event.currentTarget as HTMLInputElement).value));
          }}></md-slider>
        ${iconButton({ icon: "vertical_align_top", label: host.t("maxLevel", "Max level"), disabled: value === cap, onClick: () => write("lvl", cap) })}
      </div>
    </div>
  `);
  let fields: TemplateResult;
  if (kind === "members") {
    const row = owned as OwnedMember | undefined;
    const limits = catalog.memberLimits(cardId, row?.awake ?? null)!;
    fields = html`
      ${steps(host.t("training", "Training"), "awk", row?.awake ?? null, limits.awake)}
      ${levelField(row?.level ?? null, limits.levelCap)}
      ${steps(host.t("awakening", "Awakening"), "rnk", row?.rank ?? null, limits.rank)}
      ${steps(host.t("liveSkill", "Live skill"), "sk", row?.skill ?? null, limits.liveSkillLevel)}
      ${host.master!.members.get(cardId)?.gekisoSkillId ? steps(host.t("gekisoSkill", "Gekiso skill"), "gsk", row?.gekisoSkill ?? null, limits.gekisoSkillLevel) : nothing}
    `;
  } else {
    const row = owned as OwnedSnap | undefined;
    const limits = catalog.snapLimits(cardId, row?.rank ?? null)!;
    fields = html`${steps(host.t("limitBreak", "Limit break"), "rnk", row?.rank ?? null, limits.rank)}${levelField(row?.level ?? null, limits.levelCap)}`;
  }
  const flag = (label: string, field: "use" | "lock", value: boolean, disabled = false) => html`
    <label class="tb-check"><md-checkbox touch-target="wrapper" ?disabled=${disabled} .checked=${live(value)} @change=${(event: Event) => write(field, (event.target as HTMLInputElement).checked)}></md-checkbox><span>${label}</span></label>
  `;
  return html`
    <dialog ${modal(close)} class="dialog-host" aria-labelledby="tb-editor-title" @click=${close}>
      <section class="surface tb-editor" data-overlay-pane tabindex="-1" @click=${(event: Event) => event.stopPropagation()}>
        <header class="tb-editor__header">
          <span class=${`tb-editor__art tb-editor__art--${kind}`}>${tileMedia(options)}</span>
          <div class="stack stack--tight">
            <h2 id="tb-editor-title" class="tb-editor__title">${options.title}</h2>
            <span class="tb-editor__subtitle">${options.subtitle}</span>
            ${owned ? nothing : html`<span class="badge badge--primary">${host.t("notOwned", "Not owned")}</span>`}
          </div>
          ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: close })}
        </header>
        <div class="tb-editor__fields">${fields}</div>
        ${ptField(host, fieldKey("use"), html`<div class="cluster">
          ${flag(host.t("useInSearch", "Use in team search"), "use", owned?.use ?? false)}
          ${flag(characterRequired ? host.t("requiredOnePerCharacter", "One required card per character") : host.t("required", "Always include"), "lock", owned?.lock ?? false, characterRequired)}
        </div>`)}
        <footer class="row row--wrap tb-editor__actions">
          <button class="button button--text" type="button" @click=${() => host.write(maxChanges(host, { kind, id: cardId, owned }))}>${icon("upgrade", 18)}${host.t("fullGrowth", "Full growth")}</button>
          ${owned
            ? html`<button class="button button--text button--danger" type="button" @click=${() => {
                bulk(host, host.t("removedCard", "Removed from your cards"), [{ key: `${p}.${cardId}.own`, value: false }, { key: `${p}.${cardId}.lock`, value: false }]);
                close();
              }}>${icon("remove_circle", 18)}${host.t("removeOwned", "Not owned")}</button>`
            : nothing}
          <span class="row__spacer"></span>
          <button class="button" type="button" @click=${close}>${host.t("done", "Done")}</button>
        </footer>
      </section>
    </dialog>
  `;
}
