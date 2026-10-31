// L3 — GEB
// Input: Team slot or manual event card selection, catalogue and shared card filters.
// Output: The existing native card chooser with single-slot or multiple bonus-card selection.
// Pos: [Map](../L2-2.md); shared team workspace card picker.
// Effects/Dependencies: Uses selectionPane; changes a team slot or applies the selected bonus cards on confirmation.
import { html, nothing, type TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { matchesCardFilters, renderCardFilters } from "./card-filters";
import { manualEventTemplate } from "../../lib/team-builder/manual-event";
import { selectionPane } from "../ui/selection-pane";
import { icon } from "../ui/icon";
import { renderResourceSort, sortedCards } from "./catalog-sort";
import { chooserGroup } from "../ui/chooser-filters";

export function renderCardPicker(host: TeamBuilder): TemplateResult | typeof nothing {
  const picker = host.slotPicker;
  if (!picker) return nothing;
  const catalog = host.catalog!;
  const kind = picker.kind;
  const event = "target" in picker;
  const draft = host.settings.manualEvent;
  const template = host.master!.events.get(draft.templateId!);
  const profiles = event && template ? manualEventTemplate(template, host.master!)?.[kind] ?? [] : [];
  const selected = event ? new Set(picker.ids.map(String)) : undefined;
  const close = () => {
    host.slotPicker = null;
    host.slotFilters = {
      ...host.slotFilters,
      query: "",
      bands: [],
      characters: [],
      attributes: [],
      rarities: [],
      facets: {},
    };
    host.slotFiltersOpen = false;
    host.requestUpdate();
  };
  const filters = { ...host.slotFilters, kind };
  const set = (patch: Partial<typeof filters>) => {
    host.slotFilters = { ...filters, ...patch };
    host.requestUpdate();
  };
  const theoretical = event || host.tab !== "song-comparison" && host.searchSettings.scope === "theoretical";
  const owned = kind === "members" ? host.view!.members : host.view!.snaps;
  const ids = sortedCards(host, kind, (
    theoretical
      ? Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number)
      : [...owned.keys()]
  )
    .filter((id) => matchesCardFilters(host, kind, id, filters)));
  const current = "slot" in picker ? (kind === "members" ? host.manual.members[picker.slot] : host.manual.snaps[picker.slot]) : null;
  return selectionPane({
    id: "tb-slot-picker",
    title: kind === "members" ? host.t("pickMember", "Choose a member") : host.t("pickSnap", "Choose a snap"),
    closeLabel: host.common("common.actions.close", "Close"),
    close,
    searchLabel: host.common("common.actions.search", "Search"),
    filterLabel: host.t("filters", "Filters"),
    filtersOpen: host.slotFiltersOpen,
    toggleFilters: () => {
      host.slotFiltersOpen = !host.slotFiltersOpen;
      host.requestUpdate();
    },
    query: filters.query,
    search: (value) => set({ query: value }),
    filterLayout: "facets",
    filters: html`${renderCardFilters(host, filters, set)}${chooserGroup(host.common("common.actions.sort", "Sort"), renderResourceSort(host, kind))}`,
    kind: kind === "members" ? "member" : "support",
    items: ids.map((id) => ({ ...catalog.cardOptions(kind, id)!, value: String(id) })),
    selected: current === null || current === undefined ? "" : String(current),
    selectedValues: selected,
    select: (value) => {
      const id = Number(value);
      if ("target" in picker) {
        host.slotPicker = { ...picker, ids: picker.ids.includes(id) ? picker.ids.filter(value => value !== id) : [...picker.ids, id] };
        host.requestUpdate();
        return;
      }
      const list = kind === "members" ? [...host.manual.members] : [...host.manual.snaps];
      // A card can sit in one slot only; picking it again moves it.
      for (let index = 0; index < list.length; index++) if (list[index] === id) list[index] = null;
      list[picker.slot] = id;
      host.manual = kind === "members" ? { ...host.manual, members: list } : { ...host.manual, snaps: list };
      host.manualResults = null;
      host.manualSuggestions = null;
      close();
    },
    countLabel: host.t("cardCount", "{count} cards", { count: ids.length }),
    emptyLabel: host.t("noMatches", "No cards match"),
    preview: "target" in picker
      ? html`<button class="button button--full" @click=${() => {
          if (!profiles.length) return;
          const cards = picker.ids.map(cardId => draft[kind].find(row => row.cardId === cardId) ?? {cardId, tier: profiles[0]!.key});
          host.updateSettings({manualEvent: {...draft, [kind]: cards}});
          close();
        }}>${host.common("common.actions.confirm", "Confirm")} / ${host.t("cardCount", "{count} cards", {count: picker.ids.length})}</button>`
      : kind === "snaps"
        ? html`
            <button
              class="button button--text"
              type="button"
              @click=${() => {
                const snaps = [...host.manual.snaps];
                snaps[picker.slot] = null;
                host.manual = { ...host.manual, snaps };
                host.manualResults = null;
                close();
              }}
            >
              ${icon("hide_image", 18)}${host.t("noSnap", "No snap")}
            </button>
          `
        : html``,
  });
}
