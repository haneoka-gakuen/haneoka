// L3 — GEB
// Input: Scene-specific chart choices, catalogue and browse preferences.
// Output: Grid chart selection, ordinary Live recommendations and explicit apply/cancel.
// Pos: [Map](../L2-2.md); shared team workspace chart chooser.
// Effects/Dependencies: Lit modal, Box-persisted difficulty selection and lazy reads of release-pinned metadata and rates.
import { matchesSongMissions, matchesSelections } from "../../lib/catalog-filters";
import {
  catalogQueryNames,
  parseCatalogQuery,
  removeCatalogQueryFacets,
  type CatalogQueryContext,
} from "../../lib/catalog-query";
import { html, nothing, type TemplateResult } from "lit";
import { CHART_RATE_SCHEMA, type ChartRateTable } from "../../lib/chart-rates";
import type { EngineRequest, SongRef } from "../../lib/team-builder/engine/api";
import { arenaSongView, type ArenaRule } from "../../lib/team-builder/arena";
import { chooserFacet, chooserGroup } from "../ui/chooser-filters";
import { filterChip, inputChip, segmented } from "../ui/controls";
import { actionMenu } from "../ui/action-menu";
import { asyncRegion } from "../ui/async-region";
import { chartDuration } from "./result-metric";
import { snackbar } from "../../lib/snackbar";
import { selectionPane } from "../ui/selection-pane";
import { chartKey, uniqueCharts } from "./workspace-state";
import type { TeamBuilder } from "../team-builder";
import { renderResourceSort, sortedCharts, songMetricSort } from "./catalog-sort";

export interface SongPickerState {
  songs: SongRef[];
  single: boolean;
  recommend?: boolean;
  recommendation?: { input: string; charts: SongRef[]; count: number; adopted: boolean };
  recommendationRequest?: AbortController;
  recommendationError?: "data" | "team";
  query: string;
  filtersOpen: boolean;
  bands: (number | string)[];
  categories?: number[];
  attributes: number[];
  gekisouTypes: string[];
  gekisouMatch?: "only" | "contains";
  difficulty: number;
  difficulties?: number[];
  minLevel?: number | null;
  maxLevel?: number | null;
  maxSeconds?: number | null;
  allowedSongIds?: number[];
  allowedCharts?: SongRef[];
  songRules?: ArenaRule;
  title?: string;
  context?: string;
  initialized?: boolean;
  view?: "all" | "outside" | "unavailable" | "recommended";
  undo?: SongRef[];
  opener?: HTMLElement;
  change: (songs: SongRef[]) => void;
}
type PickerCatalog = NonNullable<TeamBuilder["catalog"]>;
type PublishedRates = ChartRateTable & { schema: string; sourceId: string };
const rateTables = new WeakMap<PickerCatalog, Map<string, ChartRateTable>>();
const rateKey = (identity: ReturnType<PickerCatalog["songIdentity"]>) =>
  `${identity.server}:${identity.releaseId}:${identity.sourceId}`;

async function pickerRates(catalog: PickerCatalog, charts: readonly SongRef[], signal: AbortSignal) {
  let tables = rateTables.get(catalog);
  if (!tables) rateTables.set(catalog, (tables = new Map()));
  const identities = new Map(charts.map(({ songId }) => {
    const identity = catalog.songIdentity(songId);
    return [rateKey(identity), identity] as const;
  }));
  await Promise.all([...identities].map(async ([key, identity]) => {
    if (tables.has(key) || !identity.sourceId || (identity.server !== "intl" && identity.server !== "jp")) return;
    const response = await fetch(`/data/chart-rates/${identity.server}.json`, { signal });
    if (!response.ok) return;
    const table = (await response.json()) as PublishedRates | null;
    if (!signal.aborted && table?.schema === CHART_RATE_SCHEMA && table.releaseId === identity.releaseId &&
        table.sourceId === identity.sourceId && table.charts && typeof table.charts === "object") tables.set(key, table);
  }));
  return (song: SongRef) => tables.get(rateKey(catalog.songIdentity(song.songId)));
}

const DEFAULT_RECOMMENDATIONS = 5;
const MAX_RECOMMENDATIONS = 10;
const FILTER_KEYS = ["query", "bands", "categories", "attributes", "gekisouTypes", "gekisouMatch",
  "difficulties", "minLevel", "maxLevel", "maxSeconds"] as const;
const DIFFICULTIES = ["EASY", "NORMAL", "HARD", "EXPERT", "SPECIAL"];
export function renderSongPicker(host: TeamBuilder): TemplateResult {
  let state = host.songPicker!;
  const catalog = host.catalog!;
  const songView = (id: number) =>
    state.songRules ? arenaSongView(catalog.song(id), state.songRules) : catalog.song(id);
  const context = state.context ?? `${host.tab}:${state.single ? "single" : "charts"}`;
  if (!state.initialized) {
    state = host.songPicker = {
      ...state,
      ...host.songPickerPreferences.get(context),
      difficulties: host.songDifficulties,
      initialized: true,
      opener: typeof document === "undefined" ? undefined : (document.activeElement as HTMLElement),
    };
  }
  const update = (patch: Partial<SongPickerState>) => {
    const current = host.songPicker!;
    const changesFilters = FILTER_KEYS.some((key) => key in patch);
    if (changesFilters) current.recommendationRequest?.abort();
    const next = (host.songPicker = {
      ...current,
      ...(changesFilters ? {
        recommendation: undefined,
        recommendationRequest: undefined,
        recommendationError: undefined,
        ...(current.view === "recommended" ? { view: "all" as const } : {}),
      } : {}),
      ...patch,
    });
    const { query, bands, categories, attributes, gekisouTypes, gekisouMatch, difficulties, minLevel, maxLevel, maxSeconds } = next;
    host.songPickerPreferences.set(context, {
      query,
      bands,
      categories,
      attributes,
      gekisouTypes,
      gekisouMatch,
      difficulties,
      minLevel,
      maxLevel,
      maxSeconds,
    });
    if (patch.difficulties) host.write([{ key: "pref.song-picker", value: { difficulties: patch.difficulties } }]);
    host.requestUpdate();
  };
  const close = () => {
    host.songPicker?.recommendationRequest?.abort();
    host.songPicker = null;
    host.requestUpdate();
    void host.updateComplete.then(() => state.opener?.isConnected && state.opener.focus());
  };
  const bandValues = (id: number): string[] => {
    const ids = catalog.songBands(id).map(String);
    if (ids.length) return ids;
    const row = catalog.song(id);
    const names = Array.isArray(row.artistName ?? row.bandName) ? row.artistName ?? row.bandName : [row.artistName ?? row.bandName];
    const credit = String(row.artistId || (names as unknown[]).find(value => typeof value === "string" && value.trim()) || "").normalize("NFKC");
    return credit ? [`credit:${credit}`] : [];
  };
  const bandOptions = new Map(Object.keys(catalog.data.bands).map(id => [id, { value: id, label: catalog.bandName(Number(id)) }]));
  const categoryName = (value: string) => {
    const key = ["original", "virtual", "jpop", "anime", "game"][Number(value) - 1];
    return key ? host.common(`catalog.songs.types.${key}`, value) : value;
  };
  const categoryValues = (id: number): string[] => ((catalog.song(id).musicCategories as number[] | undefined) ?? []).map(String);
  const categoryOptions = [...new Set(Object.keys(catalog.data.songs).flatMap(id => categoryValues(Number(id))))]
    .sort((a, b) => Number(a) - Number(b))
    .map(value => ({ value, label: categoryName(value) }));
  const credits = new Map<string, number>();
  for (const id of Object.keys(catalog.data.songs).map(Number)) for (const value of bandValues(id)) {
    if (!value.startsWith("credit:")) continue;
    credits.set(value, id);
    bandOptions.set(value, { value, label: catalog.songArtist(id) });
  }
  const queryContext: CatalogQueryContext = {
    game: "our-notes",
    kind: "song",
    aliases: [
      ...[...credits].map(([value, id]) => ({ key: "collectionBand", value, names: catalogQueryNames({ bandName: catalog.song(id).artistName ?? catalog.song(id).bandName }, "band") })),
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
    (!state.allowedCharts ||
      state.allowedCharts.some((ref) => ref.songId === song.songId && ref.difficulty === song.difficulty)) &&
    catalog.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty);
  const allCharts = Object.keys(catalog.data.songs)
    .map(Number)
    .filter((id) => catalog.songVisible(id))
    .sort((a, b) => b - a)
    .flatMap((songId) =>
      catalog
        .difficultyRows(songId)
        .map((row) => ({ songId, difficulty: Number(row.difficulty) }))
        .filter(legal),
    );
  catalog.loadSongMetadata(allCharts.map((song) => song.songId));
  const metricSort = songMetricSort(host);
  const needsMetadata = state.maxSeconds != null || metricSort;
  const durationLoading =
    needsMetadata && allCharts.some((song) => catalog.metadataStatus(song.songId) === "loading");
  const durationError =
    needsMetadata && allCharts.some((song) => catalog.metadataStatus(song.songId) === "error");
  const incomplete = state.maxSeconds != null && (durationLoading || durationError);
  const visible = allCharts.filter((ref) => {
    const id = ref.songId,
      song = songView(id);
    if (!difficulties.includes(ref.difficulty)) return false;
    if (state.bands.length && !bandValues(id).some(value => state.bands.map(String).includes(value))) return false;
    if (!matchesSelections(categoryValues(id), (state.categories ?? []).map(String))) return false;
    if (state.attributes.length && !state.attributes.includes(Number(song.musicType))) return false;
    if (!matchesSongMissions(song, state.gekisouTypes, missionMode)) return false;
    if (
      !matchesSelections(bandValues(id), facets.collectionBand || []) ||
      !matchesSelections(categoryValues(id), facets.category || []) ||
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
  const offersRecommendations = state.recommend && host.canRecommendCharts;
  const signature = (request: EngineRequest | null) => request && JSON.stringify([host.snapshot?.owner, request]);
  const cachedRecommendation = state.recommendation;
  const recommendation = offersRecommendations && cachedRecommendation &&
    cachedRecommendation.input === signature(host.chartRecommendationRequest(visible))
    ? cachedRecommendation : undefined;
  const showingRecommendations = recommendation && state.view === "recommended";
  const shown = showingRecommendations
    ? recommendation.charts.slice(0, recommendation.count)
    : sortedCharts(host, state.view === "outside" ? outside : state.view === "unavailable" ? unavailable : visible, songView);
  const selected = new Set(state.songs.map(chartKey));
  const shownKeys = new Set(shown.map(chartKey));
  const selectableShown = shown.filter(legal);
  const replace = (songs: SongRef[], patch?: Partial<SongPickerState>) => {
    const current = host.songPicker!;
    current.recommendationRequest?.abort();
    update({ songs: uniqueCharts(songs), undo: current.songs, recommendationRequest: undefined, recommendationError: undefined, ...patch });
    snackbar(host.t("selectionUpdated", "Selection updated"));
  };
  const recommend = async () => {
    const request = host.chartRecommendationRequest(visible);
    const master = host.master;
    if (!master || !request || request.goal.kind !== "score" || request.members.length < 5) {
      update({ recommendationError: "team" });
      return;
    }
    const input = signature(request)!;
    const controller = new AbortController();
    host.songPicker?.recommendationRequest?.abort();
    const samePicker = () => host.catalog === catalog && host.songPicker?.recommendationRequest === controller;
    const current = () => samePicker() && !controller.signal.aborted && host.isConnected &&
      signature(host.chartRecommendationRequest(visible)) === input;
    update({ recommendationRequest: controller, recommendationError: undefined });
    try {
      const [{ rankPickerCharts }, tableFor] = await Promise.all([
        import("../../lib/team-builder/chart-recommendation"),
        pickerRates(catalog, request.goal.songs, controller.signal),
      ]);
      if (!current()) return;
      const ranked = await rankPickerCharts(master, request, tableFor, controller.signal);
      if (!current()) return;
      if (!ranked?.length) {
        update({ recommendationError: ranked ? "team" : "data" });
        return;
      }
      const adopted = !host.songPicker!.songs.length;
      const next = { input, charts: ranked.slice(0, MAX_RECOMMENDATIONS), count: DEFAULT_RECOMMENDATIONS, adopted };
      const patch = { view: "recommended" as const, recommendation: next };
      if (adopted) replace(next.charts.slice(0, next.count), patch);
      else update(patch);
    } catch {
      if (current()) update({ recommendationError: "data" });
    } finally {
      if (samePicker()) update({ recommendationRequest: undefined });
    }
  };
  const adoptRecommendation = () => {
    if (!recommendation || signature(host.chartRecommendationRequest(visible)) !== recommendation.input) return;
    replace(recommendation.charts.slice(0, recommendation.count), { recommendation: { ...recommendation, adopted: true } });
  };
  const expandRecommendation = () => {
    if (!recommendation || signature(host.chartRecommendationRequest(visible)) !== recommendation.input) return;
    const next = { ...recommendation, count: MAX_RECOMMENDATIONS };
    if (recommendation.adopted) {
      replace([...host.songPicker!.songs, ...next.charts.slice(recommendation.count)], { recommendation: next });
    } else {
      update({ recommendation: next });
    }
  };
  const toggle = (key: string) => {
    const song = shown.find((song) => chartKey(song) === key)!;
    host.songPicker?.recommendationRequest?.abort();
    update({
      recommendationRequest: undefined,
      recommendationError: undefined,
      songs: selected.has(key)
        ? state.songs.filter((song) => chartKey(song) !== key)
        : state.single
          ? [song]
          : [...state.songs, song],
      undo: state.songs,
    });
  };
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
      (v: string) => bandOptions.get(v)?.label ?? catalog.bandName(Number(v)),
    ],
    [
      "category",
      [...(state.categories ?? []).map(String), ...(facets.category ?? [])],
      { categories: [] },
      categoryName,
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
            ? ` / ${missionMode === "contains" ? host.common("catalog.songs.gekisou.contains", "Contains a selected type") : host.common("catalog.songs.gekisou.only", "Only selected types")}`
            : ""),
        clear: () => clearDimension(key === "gekisouType" ? [key, "gekisouMatch"] : [key], patch),
      });
  }
  const clearFilters = () =>
    update({
      bands: [],
      categories: [],
      attributes: [],
      gekisouTypes: [],
      gekisouMatch: "only",
      minLevel: null,
      maxLevel: null,
      maxSeconds: null,
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
    filterLabel: `${host.t("filters", "Filters")}${applied.length ? ` / ${applied.length}` : ""}`,
    filtersOpen: state.filtersOpen,
    layout: "grid",
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
          ${!state.single ? filterChip({
            label: host.t("allChartDifficulties", "All difficulties"),
            selected: DIFFICULTIES.every((_, value) => difficulties.includes(value)),
            onToggle: () => update({ difficulties: DIFFICULTIES.map((_, value) => value) }),
          }) : nothing}
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
        ${offersRecommendations ? html`
          <div class="row row--wrap" aria-busy=${String(!!state.recommendationRequest)}>
            <button class="button button--tonal" type="button"
              ?disabled=${!recommendation && (incomplete || !visible.length || !!state.recommendationRequest)}
              @click=${() => recommendation ? update({ view: showingRecommendations ? "all" : "recommended" }) : void recommend()}>
              ${showingRecommendations ? host.t("browseCharts", "Browse charts")
                : recommendation ? host.t("recommendedCharts", "Recommended charts")
                : state.recommendationRequest ? host.t("chartRecommendationLoading", "Finding charts…")
                : host.t("recommendChartCount", "Recommend {count} charts", { count: DEFAULT_RECOMMENDATIONS })}
            </button>
            ${showingRecommendations && recommendation.charts.length > recommendation.count ? html`
              <button class="button button--text" type="button" @click=${expandRecommendation}>
                ${host.t("expandChartRecommendations", "Expand to {count}", { count: recommendation.charts.length })}
              </button>
            ` : nothing}
            ${showingRecommendations && !recommendation.adopted ? html`
              <button class="button button--text" type="button" @click=${adoptRecommendation}>
                ${host.t("applyChartRecommendations", "Replace with recommendations")}
              </button>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `,
    filters: html`
        ${chooserFacet({
          label: host.common("catalog.songs.fields.genre", "Genre"),
          value: state.categories?.[0] == null ? "" : String(state.categories[0]),
          allLabel: all,
          options: categoryOptions,
          change: (value) => update({ categories: value ? [Number(value)] : [] }),
        })}
        ${chooserFacet({
          label: host.t("songBandFilter", "Song band"),
          value: state.bands[0] == null ? "" : String(state.bands[0]),
          allLabel: all,
          options: [...bandOptions.values()].filter(option => option.label),
          change: (value) => update({ bands: value ? [value.startsWith("credit:") ? value : Number(value)] : [] }),
        })}
        ${chooserFacet({
          label: host.t("songAttributeFilter", "Song attribute"),
          value: state.attributes[0] == null ? "" : String(state.attributes[0]),
          allLabel: all,
          options: (state.songRules ? [1, 2, 3, 4, 5, 99] : [1, 2, 3, 4, 5]).map((id) => ({ value: String(id), label: catalog.attributeName(id),
          })),
          change: (value) => update({ attributes: value ? [Number(value)] : [] }),
        })}
        ${chooserGroup(host.t("gekiso", "GEKISO"), html`<div class="stack stack--tight">${missionFilters}${missionMatch}</div>`)}
        ${chooserGroup(host.t("level", "Level"), html`<div class="row">
          ${levelField("minLevel", minLevel, host.t("sc.minLevel", "Minimum level"))}
          ${levelField("maxLevel", maxLevel, host.t("sc.maxLevel", "Maximum level"))}
        </div>`)}
        ${chooserGroup(host.common("common.fields.duration", "Duration"), html`
        <md-outlined-text-field
          type="number"
          min="1"
          label=${host.t("maxDuration", "Maximum chart duration (seconds)")}
          .value=${state.maxSeconds == null ? "" : String(state.maxSeconds)}
          @input=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            update({ maxSeconds: raw === "" ? null : Number(raw) });
          }}
        ></md-outlined-text-field>`)}
        ${chooserGroup(host.common("common.actions.sort", "Sort"), renderResourceSort(host, "songs"))}
    `,
    kind: "song",
    items: shown.map((song) => {
      const options = catalog.songOptions(song.songId, song.difficulty);
      const attribute = Number(songView(song.songId).musicType);
      return {
        ...options,
        value: chartKey(song),
        label: `${catalog.songTitle(song.songId)} ${catalog.difficultyLabel(song.songId, song.difficulty)}`,
        marks: [
          { at: "start" as const, image: catalog.attributeIcon(attribute), label: catalog.attributeName(attribute) },
          ...(options.marks ?? []).filter(mark => mark?.at !== "start"),
        ],
      };
    }),
    selected: "",
    selectedValues: selected,
    select: toggle,
    countLabel: state.recommendationError === "data"
      ? host.t("chartRecommendationMissing", "Chart recommendation data unavailable")
      : state.recommendationError === "team"
        ? host.t("chartRecommendationUnavailable", "Check cards and calculation settings")
        : host.t("chartCount", "{count} charts", { count: shown.length }),
    emptyLabel: incomplete ? "" : host.t("noSongs", "No songs match"),
    status: durationError
      ? asyncRegion({
          state: "error",
          message: metricSort ? host.common("common.loading.failed", "Loading failed") : host.t("durationFailed", "Duration could not be loaded"),
          retryLabel: host.common("common.actions.retry", "Retry"),
          onRetry: () => catalog.retrySongMetadata(allCharts.map((song) => song.songId)),
        })
      : html`
          <span role="status">
            ${durationLoading ? metricSort ? host.common("common.states.loading", "Loading") : host.t("durationLoading", "Loading durations") : state.maxSeconds != null ? host.t("unknownDuration", "Unknown duration {count}", { count: allCharts.filter((song) => catalog.metadataStatus(song.songId) === "ready" && typeof catalog.chartMetadata(song)?.time !== "number").length }) : ""}
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
            ${!state.single ? html`
              <button class="button button--text" type="button"
                ?disabled=${incomplete || !selectableShown.length || selectableShown.every(song => selected.has(chartKey(song)))}
                @click=${() => replace([...state.songs, ...selectableShown])}>
                ${host.t("selectAllCharts", "Select all")}
              </button>
            ` : nothing}
            <button class="button button--text" type="button" ?disabled=${!state.songs.some(song => shownKeys.has(chartKey(song)))}
              @click=${() => replace(state.songs.filter(song => !shownKeys.has(chartKey(song))))}>
              ${host.t("deselectAllCharts", "Deselect all")}
            </button>
            ${!state.single ? actionMenu({
              id: "tb-selection-actions",
              label: host.t("selectionActions", "Selection actions"),
              items: [{
                label: host.t("replaceSelection", "Use only filtered charts"),
                disabled: incomplete,
                run: () => replace(visible, { view: "all", recommendation: undefined }),
              }, {
                label: host.t("selectFullChartPool", "Select full chart pool"),
                disabled: !allCharts.length,
                run: () => replace(allCharts, { view: "all", recommendation: undefined }),
              }, {
                label: host.t("clearAllCharts", "Clear all selections"),
                disabled: !state.songs.length,
                run: () => replace([]),
              }],
            }) : nothing}
            <button class="button button--text" type="button" ?disabled=${!state.undo}
              @click=${() => {
                host.songPicker?.recommendationRequest?.abort();
                if (state.undo) update({
                  songs: state.undo, undo: undefined, view: "all",
                  recommendation: undefined, recommendationRequest: undefined, recommendationError: undefined,
                });
              }}>
              ${host.t("undoSelection", "Undo")}
            </button>
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
