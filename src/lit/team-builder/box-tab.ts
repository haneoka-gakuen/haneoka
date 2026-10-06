/** My cards: ownership, participation and growth, with filters and bulk edits. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import { ownMemberChanges, ownSnapChanges, type OwnedMember, type OwnedSnap } from "../../lib/team-builder/sync/box-view";
import { cardRarityName } from "../shared/rarity-icon";
import { filterChip, iconButton, segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";
import { tileMedia } from "../ui/tile";
import type { TeamBuilder } from "../team-builder";

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
  const query = f.query.normalize("NFKC").toLocaleLowerCase(host.locale).trim();
  return ids
    .filter((id) => (f.show === "owned" ? owned.has(id) : f.show === "unowned" ? !owned.has(id) : true))
    .filter((id) => {
      const card = kind === "members" ? catalog.member(id) : catalog.snap(id);
      if (!card) return false;
      if (f.attributes.length && !f.attributes.includes(card.attribute)) return false;
      if (f.rarities.length && !f.rarities.includes(card.rarity)) return false;
      if (f.bands.length && !catalog.bandIds(kind, id).some((band) => f.bands.includes(band))) return false;
      if (f.characters.length && !catalog.characterIds(kind, id).some((character) => f.characters.includes(character))) return false;
      if (!query) return true;
      const haystack = [
        `#${id}`,
        catalog.cardName(kind, id),
        ...catalog.characterIds(kind, id).map((character) => catalog.characterName(character)),
        ...catalog.bandIds(kind, id).map((band) => catalog.bandName(band)),
      ]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase(host.locale);
      return haystack.includes(query);
    })
    .sort((a, b) => {
      const ca = kind === "members" ? catalog.member(a) : catalog.snap(a);
      const cb = kind === "members" ? catalog.member(b) : catalog.snap(b);
      return (cb?.rarity ?? 0) - (ca?.rarity ?? 0) || b - a;
    })
    .map((id) => ({ kind, id, owned: owned.get(id) }));
}

const prefix = (kind: Kind) => (kind === "members" ? "m" : "s");
/** Bulk edits keep the previous values for one undo. */
function bulk(host: TeamBuilder, label: string, changes: { key: string; value: BoxValue }[]) {
  if (!changes.length || !host.snapshot) return;
  const previous = changes.map(({ key }) => ({ key, value: (host.snapshot!.entries[key]?.v ?? null) as BoxValue }));
  host.write(changes);
  host.notice = label;
  undoStack = previous;
  host.requestUpdate();
}
let undoStack: { key: string; value: BoxValue }[] | null = null;

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
  const options = catalog.cardOptions(row.kind, row.id);
  if (!options) return html``;
  const owned = row.owned;
  const using = !!owned && owned.use;
  const caption = owned ? catalog.growthCaption(row.kind, owned, host.settings.unknownPolicy) : host.t("notOwned", "Not owned");
  const toggle = () => {
    const p = prefix(row.kind);
    if (!owned) host.write([{ key: `${p}.${row.id}.own`, value: true }, { key: `${p}.${row.id}.use`, value: true }]);
    else host.write([{ key: `${p}.${row.id}.use`, value: !owned.use }]);
  };
  const checkLabel = owned ? host.t("useInSearch", "Use in team search") : host.t("markOwned", "Mark as owned");
  return html`
    <div class=${`tile tile--${row.kind === "members" ? "member" : "support"} tb-card${owned ? "" : " is-unowned"}${using ? " is-used" : ""}${owned?.lock ? " is-locked" : ""}`}>
      <span class="tb-card__media">
        <button class="tb-card__open" type="button" aria-label=${`${host.t("editGrowth", "Edit growth")}: ${options.label}`}
          @click=${() => {
            host.editing = { kind: row.kind, cardId: row.id };
            host.requestUpdate();
          }}>
          ${tileMedia({ ...options, marks: [...(options.marks ?? []), { at: "bottom-start", text: caption }] })}
        </button>
        <md-checkbox class="tb-card__check" touch-target="wrapper" aria-label=${`${checkLabel}: ${options.label}`} title=${checkLabel}
          .checked=${live(using)} @change=${toggle}></md-checkbox>
        ${owned?.lock ? html`<span class="tb-card__lock" title=${host.t("required", "Always include")}>${icon("push_pin", 16)}</span>` : nothing}
      </span>
      <span class="tile__identity">
        <strong class="tile__title" lang=${options.titleLanguage || nothing}>${options.title}</strong>
        <small class="tile__subtitle">${options.adornment ?? nothing}<span>${options.subtitle}</span></small>
      </span>
    </div>
  `;
}

export function renderBoxTab(host: TeamBuilder): TemplateResult {
  const catalog = host.catalog!;
  const view = host.view!;
  const f = host.filters;
  const rows = visibleCards(host);
  const set = (patch: Partial<typeof f>) => {
    host.filters = { ...f, ...patch };
    host.requestUpdate();
  };
  const toggleIn = (list: number[], value: number) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const kinds = [...Object.values(catalog.data.members), ...Object.values(catalog.data.snapshots)];
  const attributes = [...new Set(kinds.map((card) => card.attribute))].filter((value) => value >= 1 && value <= 5).sort();
  const rarities = [...new Set(kinds.map((card) => card.rarity))].sort((a, b) => b - a);
  const bands = Object.keys(catalog.data.bands).map(Number).filter((id) => catalog.bandName(id));
  const characters = Object.keys(catalog.data.characters).map(Number).filter((id) => !f.bands.length || f.bands.includes(Number(catalog.data.characters[String(id)]?.bandId)));
  const ownedRows = rows.filter((row) => row.owned);
  const activeFilters = f.bands.length + f.characters.length + f.attributes.length + f.rarities.length;
  const ownedCount = f.kind === "members" ? view.members.size : view.snaps.size;
  const usedCount = [...(f.kind === "members" ? view.members : view.snaps).values()].filter((row) => row.use).length;
  return html`
    <div class="tb-box">
      <div class="surface tb-toolbar">
        <div class="row row--wrap tb-toolbar__row">
          ${segmented({
            label: host.t("cardKind", "Card kind"),
            value: f.kind,
            grow: false,
            options: [
              { value: "members", label: `${host.t("members", "Members")} ${view.members.size}`, icon: "person" },
              { value: "snaps", label: `${host.t("snapshots", "Snaps")} ${view.snaps.size}`, icon: "photo" },
            ],
            onSelect: (kind) => set({ kind }),
          })}
          ${segmented({
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
          <md-outlined-text-field class="tb-search" type="search" label=${host.common("search", "Search")} .value=${live(f.query)}
            @input=${(event: Event) => set({ query: (event.target as HTMLInputElement).value })}>
            <span slot="leading-icon">${icon("search", 20)}</span>
          </md-outlined-text-field>
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
              <div class="tb-facets">
                <div class="tb-facet" role="group" aria-label=${host.common("band", "Band")}>
                  <span class="tb-facet__label">${host.common("band", "Band")}</span>
                  <div class="cluster">${bands.map((id) => filterChip({ label: catalog.bandName(id), image: catalog.bandIcon(id) || undefined, selected: f.bands.includes(id), onToggle: () => set({ bands: toggleIn(f.bands, id), characters: [] }) }))}</div>
                </div>
                <div class="tb-facet" role="group" aria-label=${host.common("characters", "Characters")}>
                  <span class="tb-facet__label">${host.t("character", "Character")}</span>
                  <div class="cluster">${characters.map((id) => filterChip({ label: catalog.characterName(id), image: catalog.characterFace(id) || undefined, selected: f.characters.includes(id), onToggle: () => set({ characters: toggleIn(f.characters, id) }) }))}</div>
                </div>
                <div class="tb-facet" role="group" aria-label=${host.common("attribute", "Attribute")}>
                  <span class="tb-facet__label">${host.common("attribute", "Attribute")}</span>
                  <div class="cluster">${attributes.map((id) => filterChip({ label: catalog.attributeName(id), image: catalog.attributeIcon(id) || undefined, selected: f.attributes.includes(id), onToggle: () => set({ attributes: toggleIn(f.attributes, id) }) }))}</div>
                </div>
                <div class="tb-facet" role="group" aria-label=${host.t("rarity", "Rarity")}>
                  <span class="tb-facet__label">${host.t("rarity", "Rarity")}</span>
                  <div class="cluster">${rarities.map((id) => filterChip({ label: cardRarityName(id), image: catalog.rarityIcon(id) || undefined, imageOnly: !!catalog.rarityIcon(id), selected: f.rarities.includes(id), onToggle: () => set({ rarities: toggleIn(f.rarities, id) }) }))}</div>
                </div>
                ${activeFilters ? html`<button class="button button--text" type="button" @click=${() => set({ bands: [], characters: [], attributes: [], rarities: [] })}>${host.t("clearFilters", "Clear filters")}</button>` : nothing}
              </div>
            `
          : nothing}
        <div class="row row--wrap tb-toolbar__row tb-bulk">
          <span class="tb-bulk__summary">${host.t("boxSummary", "{owned} owned · {used} in search · {shown} shown", { owned: ownedCount, used: usedCount, shown: rows.length })}</span>
          <span class="row__spacer"></span>
          <button class="button button--text button--small" type="button" ?disabled=${!rows.length}
            @click=${() => bulk(host, host.t("bulkOwned", "Marked {count} cards as owned", { count: rows.length }), rows.flatMap((row) => [{ key: `${prefix(row.kind)}.${row.id}.own`, value: true }, ...(row.owned ? [] : [{ key: `${prefix(row.kind)}.${row.id}.use`, value: true }])]))}>
            ${icon("library_add_check", 18)}${host.t("bulkOwn", "Own all shown")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkUsedDone", "{count} cards take part", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: true })))}>
            ${icon("check_box", 18)}${host.t("bulkUse", "Use all")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkUnusedDone", "{count} cards left out", { count: ownedRows.length }), ownedRows.map((row) => ({ key: `${prefix(row.kind)}.${row.id}.use`, value: false })))}>
            ${icon("check_box_outline_blank", 18)}${host.t("bulkUnuse", "Use none")}</button>
          <button class="button button--text button--small" type="button" ?disabled=${!ownedRows.length}
            @click=${() => bulk(host, host.t("bulkMaxDone", "Set {count} cards to full growth", { count: ownedRows.length }), ownedRows.flatMap((row) => maxChanges(host, row)))}>
            ${icon("upgrade", 18)}${host.t("bulkMax", "Full growth")}</button>
          <button class="button button--tonal button--small" type="button" @click=${() => host.imports.openBox()}>${icon("upload_file", 18)}${host.t("importBox", "Import")}</button>
          <button class="button button--tonal button--small" type="button" @click=${() => host.imports.openScreenshots()}>${icon("photo_camera", 18)}${host.t("importScreens", "Screenshots")}</button>
          <button class="button button--text button--small" type="button" @click=${() => host.imports.exportJson()}>${icon("download", 18)}${host.common("export", "Export")}</button>
        </div>
        ${host.notice && undoStack
          ? html`<div class="banner tb-undo" role="status"><span>${host.notice}</span><div class="banner__actions">
              <button class="button button--text" type="button" @click=${() => { host.write(undoStack ?? []); undoStack = null; host.notice = ""; host.requestUpdate(); }}>${host.t("undo", "Undo")}</button></div></div>`
          : nothing}
      </div>
      ${rows.length
        ? html`<div class=${`collection collection--${f.kind === "members" ? "member" : "support"} tb-grid`}>${rows.map((row) => renderCard(host, row))}</div>`
        : html`<div class="state"><p class="state__title">${f.show === "owned" && !ownedCount ? host.t("emptyBox", "No cards yet") : host.t("noMatches", "No cards match")}</p>
            ${f.show === "owned" && !ownedCount ? html`<div class="state__actions"><button class="button" type="button" @click=${() => set({ show: "all" })}>${host.t("showAll", "All")}</button><button class="button button--tonal" type="button" @click=${() => host.imports.openBox()}>${host.t("importBox", "Import")}</button></div>` : nothing}</div>`}
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
  const write = (field: string, value: BoxValue) =>
    host.write([...(owned ? [] : [{ key: `${p}.${cardId}.own`, value: true }, { key: `${p}.${cardId}.use`, value: true }]), { key: `${p}.${cardId}.${field}`, value }]);
  const steps = (label: string, field: string, value: number | null, max: number) => html`
    <div class="tb-field">
      <span class="tb-field__label">${label}</span>
      ${segmented({
        label,
        value: value === null ? "" : String(value),
        grow: false,
        options: Array.from({ length: max }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
        onSelect: (next) => write(field, Number(next)),
      })}
    </div>
  `;
  const levelField = (value: number | null, cap: number) => html`
    <div class="tb-field">
      <span class="tb-field__label">${host.t("level", "Level")}<output>${value ?? "—"} / ${cap}</output></span>
      <md-slider class="md3-slider" labeled min="1" max=${cap} .value=${Math.min(value ?? cap, cap)} aria-label=${host.t("level", "Level")}
        @change=${(event: Event) => write("lvl", Number((event.target as HTMLInputElement).value))}></md-slider>
    </div>
  `;
  let fields: TemplateResult;
  if (kind === "members") {
    const row = owned as OwnedMember | undefined;
    const limits = catalog.memberLimits(cardId, row?.awake ?? null)!;
    fields = html`
      ${steps(host.t("training", "Training"), "awk", row?.awake ?? null, limits.awake)}
      ${levelField(row?.level ?? null, limits.levelCap)}
      ${steps(host.t("awakening", "Awakening"), "rnk", row?.rank ?? null, limits.rank)}
      ${steps(host.t("liveSkill", "Live skill"), "sk", row?.skill ?? null, limits.liveSkillLevel)}
      ${limits.gekisoSkillLevel > 1 ? steps(host.t("gekisoSkill", "Gekiso skill"), "gsk", row?.gekisoSkill ?? null, limits.gekisoSkillLevel) : nothing}
    `;
  } else {
    const row = owned as OwnedSnap | undefined;
    const limits = catalog.snapLimits(cardId, row?.rank ?? null)!;
    fields = html`${steps(host.t("limitBreak", "Limit break"), "rnk", row?.rank ?? null, limits.rank)}${levelField(row?.level ?? null, limits.levelCap)}`;
  }
  const flag = (label: string, field: "use" | "lock", value: boolean) => html`
    <label class="tb-check"><md-checkbox touch-target="wrapper" .checked=${live(value)} @change=${(event: Event) => write(field, (event.target as HTMLInputElement).checked)}></md-checkbox><span>${label}</span></label>
  `;
  return html`
    <dialog ${modal(close)} class="dialog-host" aria-labelledby="tb-editor-title" @click=${close}>
      <section class="surface tb-editor" data-overlay-pane tabindex="-1" @click=${(event: Event) => event.stopPropagation()}>
        <header class="tb-editor__header">
          <span class=${`tb-editor__art tb-editor__art--${kind}`}>${tileMedia(options)}</span>
          <div class="stack stack--tight">
            <h2 id="tb-editor-title" class="tb-editor__title">${options.title}</h2>
            <span class="tb-editor__subtitle">${options.subtitle}</span>
            ${owned ? nothing : html`<span class="badge badge--primary">${host.t("notOwnedYet", "Not owned yet: any change adds it")}</span>`}
          </div>
          ${iconButton({ icon: "close", label: host.common("close", "Close"), onClick: close })}
        </header>
        <div class="tb-editor__fields">${fields}</div>
        <div class="cluster">
          ${flag(host.t("useInSearch", "Use in team search"), "use", owned?.use ?? false)}
          ${flag(host.t("required", "Always include"), "lock", owned?.lock ?? false)}
        </div>
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
