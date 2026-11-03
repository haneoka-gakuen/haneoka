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
import { tile, tileMedia } from "../ui/tile";
import { cardGrowthIcons } from "../../lib/ui-marks";
import "@material/web/switch/switch.js";
import type { TeamBuilder } from "../team-builder";
import { renderResourceSort, sortedCards } from "./catalog-sort";
import { chooserGroup } from "../ui/chooser-filters";
import { actionMenu } from "../ui/action-menu";

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
  const open = () => {
    if (quick) { toggle(); return; }
    host.editing = { kind: row.kind, cardId: row.id };
    host.requestUpdate();
  };
  return html`
    <div class=${`tb-card${owned ? "" : " is-unowned"}${using ? " is-used" : ""}${quick && owned ? " is-selected" : ""}${owned?.lock ? " is-locked" : ""}`}>
      ${tile({
        ...(owned || quick ? options : { ...options, marks: [...(options.marks ?? []), { at: "bottom-start", text: host.t("notOwned", "Not owned") }] }),
        kind: row.kind === "members" ? "member" : "support",
        label: `${quick ? host.t("showOwned", "Owned") : host.t("editGrowth", "Edit growth")}: ${options.label}`,
        onOpen: open,
      })}
      <button class="tb-card__check" type="button" role="checkbox" aria-checked=${String(using)}
        aria-label=${`${quick ? host.t("showOwned", "Owned") : checkLabel}: ${options.label}`} title=${quick ? host.t("showOwned", "Owned") : checkLabel} @click=${toggle}>
        <span class="tb-card__selection" aria-hidden="true">${using ? icon("check", 16) : nothing}</span>
      </button>
      ${!quick && owned?.lock ? html`<span class="tb-card__lock" title=${host.t("required", "Always include")}>${icon("push_pin", 16)}</span>` : nothing}
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
  const compact = host.compactConditions;
  return html`
    <div class=${`tb-box${host.pt.showIssues && host.pt.issues.some((issue) => issue.code === "inventory") ? " pt-field--invalid" : ""}`} data-pt-field="inventory" tabindex="-1">
      
      <div class="tb-box__bar">
        <div class="tb-box__kind">${segmented({
          label: host.t("cardKind", "Card kind"),
          value: f.kind,
          grow: false,
          options: [
            { value: "members", label: `${host.t("members", "Members")} ${view.members.size}`, icon: "person" },
            { value: "snaps", label: `${host.t("snapshots", "Snaps")} ${view.snaps.size}`, icon: "photo" },
          ],
          onSelect: (kind) => {
            const presentation = kind === "members" ? "member" : "support";
            const inactive = new Set(CARD_SKILL_FACETS.filter((facet) => !(facet.kinds as readonly string[]).includes(presentation)).map((facet) => facet.key as string));
            set({kind, facets: Object.fromEntries(Object.entries(f.facets).filter(([key]) => !inactive.has(key)))});
          },
        })}</div>
        ${host.boxQuickEntry ? nothing : html`<div class="tb-box__show">${segmented({
          label: host.t("showCards", "Show"),
          value: f.show,
          grow: false,
          options: [
            { value: "owned", label: host.t("showOwned", "Owned") },
            { value: "all", label: host.t("showAll", "All") },
            { value: "unowned", label: host.t("showUnowned", "Not owned") },
          ],
          onSelect: (show) => set({ show }),
        })}</div>`}
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
        ${compact && !host.boxQuickEntry ? nothing : html`<span class="row__spacer"></span>
        ${segmented({
          label: host.t("boxImport.libraryServer", "Card library server"),
          value: host.data!.identity.server,
          grow: false,
          options: [
            { value: "jp", label: host.t("boxImport.servers.jp", "JP") },
            { value: "intl", label: host.t("boxImport.servers.intl", "Global") },
          ],
          onSelect: (server) => host.switchServer(server),
        })}
        ${host.boxQuickEntry ? nothing : html`
          <button class="button button--tonal" type="button" @click=${() => host.imports.openBox()}>${icon("upload_file", 18)}${host.t("importBox", "Import")}</button>
        `}`}
      </div>
      ${host.filtersOpen
        ? html`
            <div class="surface chooser-filters tb-box__filters">${renderCardFilters(host, f, set)}${chooserGroup(host.common("common.actions.sort", "Sort"), renderResourceSort(host, f.kind))}</div>
          `
        : nothing}
      <div class="tb-box__status">
        <span class="tb-results__meta">${host.boxQuickEntry
          ? host.t("quickEntrySummary", "{owned} owned / {shown} shown", { owned: ownedCount, shown: rows.length })
          : host.t("boxSummary", "{owned} owned / {used} in search / {shown} shown", { owned: ownedCount, used: usedCount, shown: rows.length })}</span>
        <span class="row__spacer"></span>
        ${host.boxQuickEntry
          ? html`<button class="button button--text" type="button" ?disabled=${!rows.length}
              @click=${() => bulk(host, host.t("bulkOwned", "Marked {count} cards as owned", { count: rows.length }), rows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.own`, value: true })))}>
              ${icon("library_add_check", 18)}${host.t("quickOwnAll", "Select all")}</button>`
          : actionMenu({
              id: "tb-box-actions",
              label: compact ? host.common("common.actions.moreActions", "More") : host.t("bulkActions", "Edit shown cards"),
              items: [
                ...(compact
                  ? [
                      { label: host.t("importBox", "Import"), icon: "upload_file", run: () => host.imports.openBox() },
                      ...(["jp", "intl"] as const).map((server) => ({
                        label: host.t("boxImport.libraryServerItem", "Card library: {server}", { server: host.t(`boxImport.servers.${server}`, server === "jp" ? "JP" : "Global") }),
                        icon: host.data!.identity.server === server ? "check" : "public",
                        disabled: host.data!.identity.server === server,
                        run: () => host.switchServer(server),
                      })),
                    ]
                  : []),
                { label: host.t("bulkOwn", "Own all shown"), icon: "library_add_check", disabled: !rows.length,
                  run: () => bulk(host, host.t("bulkOwned", "Marked {count} cards as owned", { count: rows.length }), rows.flatMap((row) => [{ key: `${prefix(row.kind)}.${row.id}.own`, value: true }, ...(row.owned ? [] : [{ key: `${prefix(row.kind)}.${row.id}.use`, value: true }])])) },
                { label: host.t("bulkUse", "Use all"), icon: "check_box", disabled: !ownedRows.length,
                  run: () => bulk(host, host.t("bulkUsedDone", "{count} cards take part", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: true }))) },
                { label: host.t("bulkUnuse", "Use none"), icon: "check_box_outline_blank", disabled: !ownedRows.length,
                  run: () => bulk(host, host.t("bulkUnusedDone", "{count} cards left out", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: false }))) },
                { label: host.t("bulkMax", "Full growth"), icon: "upgrade", disabled: !ownedRows.length,
                  run: () => bulk(host, host.t("bulkMaxDone", "Set {count} cards to full growth", { count: ownedRows.length }), ownedRows.flatMap((row) => maxChanges(host, row))) },
                { label: host.t("clearRequired", "Clear all required marks"), icon: "push_pin", disabled: !requiredCount,
                  run: () => {
                    const changes = clearRequiredChanges(host);
                    bulk(host, host.t("clearRequiredDone", "Cleared required marks on {count} cards", { count: changes.length }), changes);
                  } },
                { label: host.common("common.actions.export", "Export"), icon: "download", run: () => host.imports.exportJson() },
                { label: host.t("clearOwnership", "Mark all members and snapshots not owned"), icon: "remove_circle", disabled: !view.members.size && !view.snaps.size,
                  run: () => {
                    clearing.set(host, { store: host.store, owner: host.snapshot?.owner, changes: Object.entries(host.snapshot?.entries ?? {}).filter(([key, entry]) => /^[ms]\.[1-9]\d*\.own$/u.test(key) && entry.v === true).map(([key]) => ({ key, value: false })) });
                    host.requestUpdate();
                  } },
              ],
            })}
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
  const marks = cardGrowthIcons((name) => catalog.visuals?.marks.get(name) ?? "");
  const unset = host.t("growthUnset", "Not entered");
  /** One growth stage row: the game's own stage marks where it has them, numbers otherwise. */
  const stages = (
    label: string,
    field: string,
    value: number | null,
    max: number,
    face: (stage: number) => TemplateResult,
    leading?: string,
  ) => ptField(host, fieldKey(field), html`
    <div class="tb-growth-field">
      <span class="tb-growth-field__label">
        ${leading ? html`<img class="tb-growth-field__icon" src=${leading} alt="" width="24" height="24" />` : nothing}
        <span>${label}</span>
        <output>${value === null ? unset : nothing}</output>
      </span>
      <div class="tb-stages" role="radiogroup" aria-label=${label}>
        ${Array.from({ length: max }, (_, index) => index + 1).map((stage) => html`
          <button class="tb-stage" type="button" role="radio" aria-checked=${String(value === stage)}
            @click=${() => write(field, stage)}>${face(stage)}</button>
        `)}
      </div>
    </div>
  `);
  const number = (stage: number) => html`<span class="tb-stage__number">${stage}</span>`;
  const rankFace = (images: string[], label: string, shown: (stage: number) => number) => (stage: number) =>
    images[stage]
      ? html`<img class="tb-stage__mark" src=${images[stage]} alt=${`${label} ${shown(stage)}`} title=${String(shown(stage))} width="40" height="40" />`
      : number(shown(stage));
  const trainingFace = (stage: number) => html`${marks.training ? html`<img class="tb-stage__mark tb-stage__mark--small" src=${marks.training} alt="" width="24" height="24" />` : nothing}<span>${stage}</span>`;
  const levelField = (value: number | null, cap: number) => ptField(host, fieldKey("lvl"), html`
    <div class="tb-growth-field">
      <span class="tb-growth-field__label">
        <span>${host.t("level", "Level")}</span>
        <output>${value === null ? unset : html`Lv.<strong>${Math.min(value, cap)}</strong> / ${cap}`}</output>
      </span>
      <div class="tb-level">
        ${iconButton({ icon: "remove", label: `${host.t("level", "Level")} −1`, disabled: value !== null && value <= 1, onClick: () => write("lvl", Math.max(1, Math.min(cap, (value ?? 2) - 1))) })}
        <input class="tb-level__value" type="number" inputmode="numeric" min="1" max=${cap} step="1" placeholder="—" aria-label=${host.t("level", "Level")}
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
        ${iconButton({ icon: "add", label: `${host.t("level", "Level")} +1`, disabled: value !== null && value >= cap, onClick: () => write("lvl", Math.min(cap, (value ?? 0) + 1)) })}
        <md-slider class="md3-slider" min="1" max=${cap} .value=${live(Math.min(value ?? cap, cap))} aria-label=${host.t("level", "Level")}
          @change=${(event: Event) => write("lvl", Number((event.currentTarget as HTMLInputElement).value))}></md-slider>
        <button class="button button--tonal button--small" type="button" ?disabled=${value === cap} @click=${() => write("lvl", cap)}>MAX</button>
      </div>
    </div>
  `);
  let fields: TemplateResult;
  if (kind === "members") {
    const row = owned as OwnedMember | undefined;
    const limits = catalog.memberLimits(cardId, row?.awake ?? null)!;
    const card = catalog.member(cardId);
    const skillIcon = (group: "live" | "gekiso", id: number | undefined) => String(catalog.data.skills[group]?.[String(id)]?.icon ?? "") || undefined;
    fields = html`
      ${stages(host.t("training", "Training"), "awk", row?.awake ?? null, limits.awake, trainingFace)}
      ${levelField(row?.level ?? null, limits.levelCap)}
      ${stages(host.t("awakening", "Awakening"), "rnk", row?.rank ?? null, limits.rank, rankFace(marks.memberRanks, host.t("awakening", "Awakening"), (stage) => stage))}
      ${stages(host.t("liveSkill", "Live skill"), "sk", row?.skill ?? null, limits.liveSkillLevel, number, skillIcon("live", card?.liveSkillId))}
      ${host.master!.members.get(cardId)?.gekisoSkillId ? stages(host.t("gekisoSkill", "GEKISO skill"), "gsk", row?.gekisoSkill ?? null, limits.gekisoSkillLevel, number, skillIcon("gekiso", card?.gekisoSkillId)) : nothing}
    `;
  } else {
    const row = owned as OwnedSnap | undefined;
    const limits = catalog.snapLimits(cardId, row?.rank ?? null)!;
    fields = html`${stages(host.t("limitBreak", "Limit break"), "rnk", row?.rank ?? null, limits.rank, rankFace(marks.supportRanks, host.t("limitBreak", "Limit break"), (stage) => stage - 1))}${levelField(row?.level ?? null, limits.levelCap)}`;
  }
  const flag = (label: string, field: "use" | "lock", value: boolean, disabled = false) => html`
    <label class="tb-switch-row">
      <span>${label}</span>
      <md-switch ?disabled=${disabled} .selected=${live(value)} aria-label=${label}
        @change=${(event: Event) => write(field, (event.target as HTMLInputElement & { selected: boolean }).selected)}></md-switch>
    </label>
  `;
  return html`
    <dialog ${modal(close)} class="dialog tb-editor" aria-labelledby="tb-editor-title">
      <header class="tb-editor__header">
        <span class=${`tb-editor__art tb-editor__art--${kind}`}>${tileMedia(options)}</span>
        <div class="tb-editor__heading">
          <h2 id="tb-editor-title" class="tb-editor__title" lang=${options.titleLanguage || nothing}>${options.title}</h2>
          <span class="tb-editor__subtitle">${options.subtitle}</span>
          ${owned ? nothing : html`<span class="badge badge--primary tb-editor__state">${host.t("notOwned", "Not owned")}</span>`}
        </div>
        ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: close })}
      </header>
      <div class="tb-editor__body">
        <div class="tb-editor__fields">${fields}</div>
        ${ptField(host, fieldKey("use"), html`<div class="tb-editor__flags">
          ${flag(host.t("useInSearch", "Use in team search"), "use", owned?.use ?? false)}
          ${flag(characterRequired ? host.t("requiredOnePerCharacter", "One required card per character") : host.t("required", "Always include"), "lock", owned?.lock ?? false, characterRequired)}
        </div>`)}
      </div>
      <footer class="tb-editor__actions">
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
    </dialog>
  `;
}
