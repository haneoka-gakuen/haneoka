// L3 — GEB
// Input: Scene-specific chart choices, catalogue and browse preferences.
// Output: Explicit apply/cancel selection transaction with per-chart filters.
// Pos: [Map](../L2-2.md); shared team workspace chart chooser.
// Effects/Dependencies: Lit modal, page-local preferences, lazy metadata reads.
import { matchesSongMissions, matchesSelections } from "../../lib/catalog-filters";
import {
  catalogQueryNames,
  parseCatalogQuery,
  removeCatalogQueryFacets,
  type CatalogQueryContext,
} from "../../lib/catalog-query";
import { html, nothing, type TemplateResult } from "lit";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { chooserFacet } from "../ui/chooser-filters";
import { filterChip, inputChip, segmented } from "../ui/controls";
import { actionMenu } from "../ui/action-menu";
import { asyncRegion } from "../ui/async-region";
import { chartDuration } from "./result-metric";
import { missionSummary } from "./workspace-state";
import { songMissions } from "../../lib/catalog-filters";
import { snackbar } from "../../lib/snackbar";
import { selectionPane } from "../ui/selection-pane";
import { chartKey, uniqueCharts } from "./workspace-state";
import type { TeamBuilder } from "../team-builder";

export interface SongPickerState {
  songs: SongRef[];
  single: boolean;
  query: string;
  filtersOpen: boolean;
  bands: number[];
  attributes: number[];
  gekisouTypes: string[];
  gekisouMatch?: "only" | "contains";
  difficulty: number;
  difficulties?: number[];
  minLevel?: number | null;
  maxLevel?: number | null;
  maxSeconds?: number | null;
  allowedSongIds?: number[];
  title?: string;
  context?: string;
  initialized?: boolean;
  view?: "all" | "outside" | "unavailable";
  undo?: SongRef[];
  opener?: HTMLElement;
  change: (songs: SongRef[]) => void;
}
const DIFFICULTIES = ["EASY", "NORMAL", "HARD", "EXPERT", "SPECIAL"];
export function renderSongPicker(host: TeamBuilder): TemplateResult {
  let state = host.songPicker!;
  const catalog = host.catalog!;
  const context = state.context ?? `${host.tab}:${state.single ? "single" : "charts"}`;
  if (!state.initialized) {
    state = host.songPicker = {
      ...state,
      ...host.songPickerPreferences.get(context),
      initialized: true,
      opener: typeof document === "undefined" ? undefined : (document.activeElement as HTMLElement),
    };
  }
  const update = (patch: Partial<SongPickerState>) => {
    const next = (host.songPicker = { ...host.songPicker!, ...patch });
    const { query, bands, attributes, gekisouTypes, gekisouMatch, difficulties, minLevel, maxLevel, maxSeconds } = next;
    host.songPickerPreferences.set(context, {
      query,
      bands,
      attributes,
      gekisouTypes,
      gekisouMatch,
      difficulties,
      minLevel,
      maxLevel,
      maxSeconds,
    });
    host.requestUpdate();
  };
  const close = () => {
    host.songPicker = null;
    host.requestUpdate();
    void host.updateComplete.then(() => state.opener?.isConnected && state.opener.focus());
  };
  const queryContext: CatalogQueryContext = {
    game: "our-notes",
    kind: "song",
    aliases: [
      ...Object.entries(catalog.data.characters).map(([id, row]) => ({
        key: "character",
        value: id,
        names: catalogQueryNames(row, "character"),
      })),
      ...Object.entries(catalog.data.bands).map(([id, row]) => ({
        key: "collectionBand",
        value: id,
        names: catalogQueryNames({ ...row, bandName: row.bandName ?? row.name }, "band"),
      })),
    ],
  };
  const plan = parseCatalogQuery(state.query, queryContext);
  const query = plan.text.normalize("NFKC").toLocaleLowerCase(host.locale);
  const facets = plan.facets;
  const lower = [state.minLevel, ...(facets.minLevel?.map(Number) ?? [])].filter((v): v is number => v != null);
  const upper = [state.maxLevel, ...(facets.maxLevel?.map(Number) ?? [])].filter((v): v is number => v != null);
  const minLevel = lower.length ? Math.max(...lower) : null;
  const maxLevel = upper.length ? Math.min(...upper) : null;
  const missionMode = facets.gekisouMatch?.[0] ?? state.gekisouMatch;
  const difficulties = state.difficulties ?? [state.difficulty];
  const legal = (song: SongRef) =>
    (!state.allowedSongIds || state.allowedSongIds.includes(song.songId)) &&
    catalog.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty);
  const allCharts = Object.keys(catalog.data.songs)
    .map(Number)
    .sort((a, b) => b - a)
    .flatMap((songId) =>
      catalog
        .difficultyRows(songId)
        .map((row) => ({ songId, difficulty: Number(row.difficulty) }))
        .filter(legal),
    );
  catalog.loadSongMetadata(allCharts.map((song) => song.songId));
  const durationLoading =
    state.maxSeconds != null && allCharts.some((song) => catalog.metadataStatus(song.songId) === "loading");
  const durationError =
    state.maxSeconds != null && allCharts.some((song) => catalog.metadataStatus(song.songId) === "error");
  const incomplete = durationLoading || durationError;
  const visible = allCharts.filter((ref) => {
    const id = ref.songId,
      song = catalog.song(id);
    if (!difficulties.includes(ref.difficulty)) return false;
    if (state.bands.length && !catalog.songBands(id).some((band) => state.bands.includes(band))) return false;
    if (state.attributes.length && !state.attributes.includes(Number(song.musicType))) return false;
    if (!matchesSongMissions(song, state.gekisouTypes, missionMode)) return false;
    if (
      !matchesSelections(catalog.songBands(id).map(String), facets.collectionBand || []) ||
      !matchesSelections(
        (Array.isArray(song.vocalCharacterIds) ? song.vocalCharacterIds : []).map(String),
        facets.character || [],
      ) ||
      !matchesSelections([String(song.musicType)], facets.type || []) ||
      !matchesSongMissions(song, facets.gekisouType || [], missionMode)
    )
      return false;
    const row = catalog.difficultyRows(id).find((row) => Number(row.difficulty) === ref.difficulty)!;
    const level = Number(row.displayLevel ?? row.playLevel ?? row.sortLevel);
    if ((minLevel !== null || maxLevel !== null) && !Number.isFinite(level)) return false;
    if ((minLevel !== null && level < minLevel) || (maxLevel !== null && level > maxLevel)) return false;
    if (state.maxSeconds != null) {
      const time = catalog.chartMetadata(ref)?.time;
      if (typeof time !== "number" || !Number.isFinite(time) || time > state.maxSeconds) return false;
    }
    return (
      !query ||
      `${catalog.songTitle(id)} ${catalog.songArtist(id)}`
        .normalize("NFKC")
        .toLocaleLowerCase(host.locale)
        .includes(query)
    );
  });
  const visibleKeys = new Set(visible.map(chartKey));
  const validSelected = state.songs.filter(legal);
  const unavailable = state.songs.filter((song) => !legal(song));
  const outside = validSelected.filter((song) => !visibleKeys.has(chartKey(song)));
  const shown = state.view === "outside" ? outside : state.view === "unavailable" ? unavailable : visible;
  const selected = new Set(state.songs.map(chartKey));
  const replace = (songs: SongRef[]) => {
    update({ songs: uniqueCharts(songs), undo: state.songs });
    snackbar(host.t("selectionUpdated", "Selection updated"));
  };
  const toggle = (key: string) => {
    const song = shown.find((song) => chartKey(song) === key)!;
    update({
      songs: selected.has(key)
        ? state.songs.filter((song) => chartKey(song) !== key)
        : state.single
          ? [song]
          : [...state.songs, song],
    });
  };
  const gekiso =
    host.tab === "song-comparison" ||
    host.searchSettings.goal === "gekiso" ||
    (host.tab === "pt" && host.settings.rewardMode === "recommendation" && host.searchSettings.ptMode === "gekiso");
  const missionFilters = html`
    <div class="cluster">
      ${["Combo", "Luck", "JustCount", "Mix"].map((value, i) =>
        filterChip({
          label: ["COMBO", "LUCK", "JUST", host.common("catalog.songs.gekisou.mixed", "Mixed")][i]!,
          selected: state.gekisouTypes.includes(value),
          onToggle: () =>
            update({
              gekisouTypes: state.gekisouTypes.includes(value)
                ? state.gekisouTypes.filter((type) => type !== value)
                : [...state.gekisouTypes, value],
            }),
        }),
      )}
    </div>
  `;
  const missionMatch = segmented({
    label: host.common("catalog.songs.gekisou.matchMode", "Match mode"),
    value: state.gekisouMatch ?? "only",
    options: [
      { value: "only", label: host.common("catalog.songs.gekisou.only", "Only selected types") },
      { value: "contains", label: host.common("catalog.songs.gekisou.contains", "Contains a selected type") },
    ],
    onSelect: (gekisouMatch) => update({ gekisouMatch }),
  });
  const levelField = (key: "minLevel" | "maxLevel", value: number | null, label: string) => html`
    <md-outlined-text-field
      type="number"
      min="1"
      label=${label}
      .value=${value == null ? "" : String(value)}
      @input=${(event: Event) => {
        const raw = (event.target as HTMLInputElement).value;
        update({ [key]: raw === "" ? null : Number(raw) });
      }}
    ></md-outlined-text-field>
  `;
  const all = host.common("common.states.all", "All");
  const clearDimension = (keys: string[], patch: Partial<SongPickerState>) =>
    update({ ...patch, query: removeCatalogQueryFacets(state.query, queryContext, keys) });
  const applied: { label: string; clear: () => void }[] = [];
  if (minLevel != null || maxLevel != null)
    applied.push({
      label: `Lv. ${minLevel ?? "—"}–${maxLevel ?? "—"}`,
      clear: () => clearDimension(["minLevel", "maxLevel"], { minLevel: null, maxLevel: null }),
    });
  if (state.maxSeconds != null)
    applied.push({ label: `≤ ${chartDuration(state.maxSeconds)}`, clear: () => update({ maxSeconds: null }) });
  for (const [key, values, patch, label] of [
    [
      "collectionBand",
      [...state.bands.map(String), ...(facets.collectionBand ?? [])],
      { bands: [] },
      (v: string) => catalog.bandName(Number(v)),
    ],
    [
      "type",
      [...state.attributes.map(String), ...(facets.type ?? [])],
      { attributes: [] },
      (v: string) => catalog.attributeName(Number(v)),
    ],
    ["character", facets.character ?? [], {}, (v: string) => catalog.characterName(Number(v))],
    [
      "gekisouType",
      [...state.gekisouTypes, ...(facets.gekisouType ?? [])],
      { gekisouTypes: [], gekisouMatch: "only" },
      (v: string) =>
        v === "Mix"
          ? host.common("catalog.songs.gekisou.mixed", "Mixed")
          : v === "JustCount"
            ? "JUST"
            : v.toUpperCase(),
    ],
  ] as [string, string[], Partial<SongPickerState>, (value: string) => string][]) {
    if (values.length)
      applied.push({
        label:
          [...new Set(values)].map(label).join(" / ") +
          (key === "gekisouType"
            ? ` · ${missionMode === "contains" ? host.common("catalog.songs.gekisou.contains", "Contains a selected type") : host.common("catalog.songs.gekisou.only", "Only selected types")}`
            : ""),
        clear: () => clearDimension(key === "gekisouType" ? [key, "gekisouMatch"] : [key], patch),
      });
  }
  const clearFilters = () =>
    update({
      bands: [],
      attributes: [],
      gekisouTypes: [],
      gekisouMatch: "only",
      minLevel: null,
      maxLevel: null,
      maxSeconds: null,
      difficulties: [state.difficulty],
      query: removeCatalogQueryFacets(state.query, queryContext),
    });
  return selectionPane({
    id: "tb-song-picker",
    title: state.title ?? host.t("chooseSongs", "Choose songs"),
    closeLabel: host.common("common.actions.close", "Close"),
    close,
    searchLabel: host.common("common.actions.search", "Search"),
    query: state.query,
    search: (query) => update({ query }),
    filterLabel: `${host.t("filters", "Filters")}${applied.length ? ` · ${applied.length}` : ""}`,
    filtersOpen: state.filtersOpen,
    layout: "list",
    filterCount: applied.length,
    toggleFilters: () => update({ filtersOpen: !state.filtersOpen }),
    filterLayout: "facets",
    quickFilters: html`
      <div class="stack tb-picker-quick">
        <div class="cluster" role="group" aria-label=${host.t("difficulty", "Difficulty")}>
          ${DIFFICULTIES.map((label, value) =>
            filterChip({
              label,
              selected: difficulties.includes(value),
              onToggle: () =>
                update({
                  difficulties: difficulties.includes(value)
                    ? difficulties.filter((d) => d !== value)
                    : [...difficulties, value],
                }),
            }),
          )}
        </div>
        <div class="cluster tb-picker-applied">
          ${applied.map((item) => inputChip(item.label, host.common("common.actions.remove", "Remove"), item.clear))}
          ${
            applied.length
              ? html`
                  <button class="button button--text" @click=${clearFilters}>
                    ${host.t("clearFilters", "Clear filters")}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    `,
    filters: html`
      <div class="stack">
        ${missionFilters}${missionMatch} ${levelField("minLevel", minLevel, host.t("sc.minLevel", "Minimum level"))}
        ${levelField("maxLevel", maxLevel, host.t("sc.maxLevel", "Maximum level"))}
        <md-outlined-text-field
          type="number"
          min="1"
          label=${host.t("maxDuration", "Maximum chart duration (seconds)")}
          .value=${state.maxSeconds == null ? "" : String(state.maxSeconds)}
          @input=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            update({ maxSeconds: raw === "" ? null : Number(raw) });
          }}
        ></md-outlined-text-field>
        ${chooserFacet({
          label: host.common("catalog.fields.band", "Band"),
          value: state.bands[0] == null ? "" : String(state.bands[0]),
          allLabel: all,
          options: Object.keys(catalog.data.bands)
            .map(Number)
            .filter((id) => catalog.bandName(id))
            .map((id) => ({ value: String(id), label: catalog.bandName(id) })),
          change: (value) => update({ bands: value ? [Number(value)] : [] }),
        })}
        ${chooserFacet({
          label: host.common("catalog.fields.attribute", "Attribute"),
          value: state.attributes[0] == null ? "" : String(state.attributes[0]),
          allLabel: all,
          options: [1, 2, 3, 4, 5].map((id) => ({ value: String(id), label: catalog.attributeName(id) })),
          change: (value) => update({ attributes: value ? [Number(value)] : [] }),
        })}
      </div>
    `,
    kind: "song",
    items: shown.map((song) => ({
      ...catalog.songOptions(song.songId, song.difficulty),
      marks: [],
      value: chartKey(song),
      adornment: nothing,
      subtitle: html`
        <span class="tb-picker-chart">
          ${catalog.difficultyLabel(song.songId, song.difficulty)} · ${chartDuration(catalog.chartMetadata(song)?.time)}
        </span>
        <span class="tb-picker-artist">
          ${catalog.songArtist(song.songId)} ·
          ${catalog.attributeName(Number(catalog.song(song.songId).musicType))}${gekiso ? ` · ${missionSummary(songMissions(catalog.song(song.songId)))}` : ""}
        </span>
      `,
    })),
    selected: "",
    selectedValues: selected,
    select: toggle,
    countLabel: host.t("chartCount", "{count} charts", { count: shown.length }),
    emptyLabel: incomplete ? "" : host.t("noSongs", "No songs match"),
    status: durationError
      ? asyncRegion({
          state: "error",
          message: host.t("durationFailed", "Duration could not be loaded"),
          retryLabel: host.common("common.actions.retry", "Retry"),
          onRetry: () => catalog.retrySongMetadata(allCharts.map((song) => song.songId)),
        })
      : html`
          <span role="status">
            ${durationLoading ? host.t("durationLoading", "Loading durations") : state.maxSeconds != null ? host.t("unknownDuration", "Unknown duration {count}", { count: allCharts.filter((song) => catalog.metadataStatus(song.songId) === "ready" && typeof catalog.chartMetadata(song)?.time !== "number").length }) : ""}
          </span>
          ${
            !shown.length && !incomplete
              ? html`
                  <button class="button button--text" @click=${clearFilters}>
                    ${host.t("clearFilters", "Clear filters")}
                  </button>
                `
              : nothing
          }
        `,
    preview: html`
      <div class="stack tb-picker-footer">
        <div class="tb-picker-tools">
          <div class="cluster tb-picker-count" role="status">
            <span>${host.t("selectedCharts", "Selected {count}", { count: validSelected.length })}</span>
            ${
              outside.length || state.view === "outside"
                ? html`
                    <button
                      class="button button--text"
                      @click=${() => update({ view: state.view === "outside" ? "all" : "outside" })}
                      aria-pressed=${String(state.view === "outside")}
                    >
                      ${host.t("outsideCharts", "Outside filters {count}", { count: outside.length })}
                    </button>
                  `
                : nothing
            }
            ${
              unavailable.length || state.view === "unavailable"
                ? html`
                    <button
                      class="button button--text"
                      @click=${() => update({ view: state.view === "unavailable" ? "all" : "unavailable" })}
                      aria-pressed=${String(state.view === "unavailable")}
                    >
                      ${host.t("unavailableCharts", "Unavailable {count}", { count: unavailable.length })}
                    </button>
                  `
                : nothing
            }
          </div>
          <div class="cluster tb-picker-actions">
            ${actionMenu({
              id: "tb-selection-actions",
              label: host.t("selectionActions", "Selection actions"),
              items: [
                ...(state.single
                  ? []
                  : [
                      {
                        label: host.t("appendMatching", "Add matching charts"),
                        disabled: incomplete,
                        run: () => replace([...state.songs, ...visible]),
                      },
                      {
                        label: host.t("replaceSelection", "Use only filtered charts"),
                        disabled: incomplete,
                        run: () => replace(visible),
                      },
                    ]),
                { label: host.t("clearSelection", "Clear selection"), run: () => replace([]) },
              ],
            })}
            ${
              state.undo
                ? html`
                    <button class="button button--text" @click=${() => update({ songs: state.undo!, undo: undefined })}>
                      ${host.t("undoSelection", "Undo")}
                    </button>
                  `
                : nothing
            }
          </div>
        </div>
        <button
          class="button"
          @click=${() => {
            state.change(uniqueCharts(validSelected));
            close();
          }}
        >
          ${host.t("applyCharts", "Use {count} charts", { count: validSelected.length })}
        </button>
      </div>
    `,
  });
}
