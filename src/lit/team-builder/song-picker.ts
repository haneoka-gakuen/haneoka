// L3 — GEB
// Input: Scene-specific chart choices, catalogue and browse preferences.
// Output: Grid chart selection, optional lower difficulties, ordinary and Gekiso Live recommendations and explicit apply/cancel.
// Pos: [Map](../L2-2.md); shared team workspace chart chooser.
// Effects/Dependencies: Lit modal, Box-persisted difficulty selection and lazy reads of release-pinned metadata and rates.
import { normalizeSearchText } from "../../lib/search-text";
import { matchesSongMissions, matchesSelections } from "../../lib/catalog-filters";
import {
  catalogQueryNames,
  parseCatalogQuery,
  removeCatalogQueryFacets,
  type CatalogQueryContext,
} from "../../lib/catalog-query";
import { html, nothing, type TemplateResult } from "lit";
import { CHART_RATE_SCHEMA, type ChartRateTable } from "../../lib/chart-rates";
import { clock } from "../../lib/team-builder/engine/execution";
import type { EngineRequest, EngineResponse, SongRef } from "../../lib/team-builder/engine/api";
import { arenaSongView, type ArenaRule } from "../../lib/team-builder/arena";
import { songPickerAppliedFilters, songPickerDifficultyFilters, songPickerFilterGroups } from "../ui/song-picker-filters";
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
  recommendation?: {
    input: string; charts: SongRef[]; count: number; adopted: boolean;
    coverage?: { screened: number; scored: number; verified: number; candidates: number };
  };
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
  expandDifficulties?: boolean;
  includeThrough?: number | null;
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
const GEKISO_RECOMMENDATIONS = 6;
const MAX_RECOMMENDATIONS = 10;
const FILTER_KEYS = ["query", "bands", "categories", "attributes", "gekisouTypes", "gekisouMatch",
  "difficulties", "minLevel", "maxLevel", "maxSeconds"] as const;
const DIFFICULTIES = ["EASY", "NORMAL", "HARD", "EXPERT", "SPECIAL"];

export function includeDifficulties(host: TeamBuilder, songs: SongRef[], through: number | null, allowed: (song: SongRef) => boolean): SongRef[] {
  if (through === null) return uniqueCharts(songs);
  const added = [...new Set(songs.map(song => song.songId))].flatMap(songId =>
    host.catalog!.difficultyRows(songId)
      .map(row => ({ songId, difficulty: Number(row.difficulty) }))
      .filter(ref => ref.difficulty <= through && allowed(ref)),
  );
  return uniqueCharts([...songs, ...added]);
}

export function includeDifficultySelect(host: TeamBuilder, through: number | null, change: (value: number | null) => void) {
  return html`
    <md-outlined-select
      label=${host.t("includeDifficultiesThrough", "Include difficulties up to")}
      .value=${through === null ? "off" : String(through)}
      @change=${(event: Event) => {
        const value = (event.target as HTMLInputElement).value;
        change(value === "off" ? null : Number(value));
      }}
    >
      <md-select-option value="off"><div slot="headline">${host.t("selectedDifficultiesOnly", "Selected charts only")}</div></md-select-option>
      ${DIFFICULTIES.map((label, value) => html`<md-select-option value=${String(value)}><div slot="headline">${label}</div></md-select-option>`)}
    </md-outlined-select>
  `;
}

export function renderSongPicker(host: TeamBuilder): TemplateResult {
  let state = host.songPicker!;
  const catalog = host.catalog!;
  const songView = (id: number) =>
    state.songRules ? arenaSongView(catalog.song(id), state.songRules) : catalog.song(id);
  const context = state.context ?? `${host.tab}:${state.single ? "single" : "charts"}`;
  const restricted = state.single ? state.allowedCharts : undefined;
  if (!state.initialized) {
    const preferences = host.songPickerPreferences.get(context);
    const poolDifficulties = restricted && [...new Set(restricted.map(song => song.difficulty))].sort((a, b) => a - b);
    state = host.songPicker = {
      ...state,
      ...preferences,
      difficulties: poolDifficulties
        ? (preferences?.difficulties?.some(difficulty => poolDifficulties.includes(difficulty)) ? preferences.difficulties : poolDifficulties)
        : host.songDifficulties,
      includeThrough: state.expandDifficulties ? host.songDifficultyCeiling : null,
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
    if (patch.difficulties && !restricted) host.setSongPickerPreferences(patch.difficulties, host.songDifficultyCeiling);
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
  const query = normalizeSearchText(plan.text, host.locale);
  const facets = plan.facets;
  const lower = [state.minLevel, ...(facets.minLevel?.map(Number) ?? [])].filter((v): v is number => v != null);
  const upper = [state.maxLevel, ...(facets.maxLevel?.map(Number) ?? [])].filter((v): v is number => v != null);
  const minLevel = lower.length ? Math.max(...lower) : null;
  const maxLevel = upper.length ? Math.min(...upper) : null;
  const missionMode = facets.gekisouMatch?.[0] ?? state.gekisouMatch;
  const difficulties = state.difficulties ?? [state.difficulty];
  const allowedSongs = state.allowedSongIds && new Set(state.allowedSongIds);
  const allowedCharts = state.allowedCharts && new Set(state.allowedCharts.map(chartKey));
  const allowed = (song: SongRef) => (!allowedSongs || allowedSongs.has(song.songId)) &&
    (!allowedCharts || allowedCharts.has(chartKey(song)));
  const legal = (song: SongRef) => allowed(song) &&
    catalog.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty);
  const songIds = state.allowedCharts ? [...new Set(state.allowedCharts.map(song => song.songId))]
    : allowedSongs ? [...allowedSongs] : Object.keys(catalog.data.songs).map(Number);
  const allCharts = songIds
    .filter((id) => catalog.songVisible(id))
    .sort((a, b) => b - a)
    .flatMap((songId) =>
      catalog
        .difficultyRows(songId)
        .map((row) => ({ songId, difficulty: Number(row.difficulty) }))
        .filter(allowed),
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
      normalizeSearchText(`${catalog.songTitle(id)} ${catalog.songArtist(id)}`, host.locale).includes(query)
    );
  });
  const visibleKeys = new Set(visible.map(chartKey));
  const validSelected = state.songs.filter(legal);
  const appliedCharts = includeDifficulties(host, validSelected, state.includeThrough ?? null, legal);
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
    const deadline = clock() + 900;
    const request = host.chartRecommendationRequest(visible);
    const master = host.master;
    if (!master || !request || (request.goal.kind !== "score" && request.goal.kind !== "gekiso") || request.members.length < 5) {
      update({ recommendationError: "team" });
      return;
    }
    const input = signature(request)!;
    const controller = new AbortController();
    host.songPicker?.recommendationRequest?.abort();
    const samePicker = () => host.catalog === catalog && host.songPicker?.recommendationRequest === controller;
    const current = () => samePicker() && !controller.signal.aborted && host.isConnected &&
      state.context === host.songPicker?.context;
    update({ recommendationRequest: controller, recommendationError: undefined });
    try {
      if (request.goal.kind === "gekiso") {
        const goal = request.goal;
        const { rankGekisoPickerCharts } = await import("../../lib/team-builder/chart-recommendation");
        const ranked = await rankGekisoPickerCharts(master, request, controller.signal);
        if (!current()) return;
        if (!ranked.length) {
          update({ recommendationError: "team" });
          return;
        }
        const candidates = ranked.slice(0, GEKISO_RECOMMENDATIONS);
        const coverage = { screened: ranked.length, scored: 0, verified: 0, candidates: candidates.length };
        const screened = { input, charts: candidates, count: candidates.length, adopted: false, coverage };
        update({ view: "recommended", recommendation: screened });
        const engine = host.engine;
        if (!engine || clock() >= deadline) return;
        const task = host.acquireTask("chart-recommendation");
        if (!task) return;
        const cancel = () => { if (host.ownsTask(task)) engine.cancel(); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          const requests = candidates.map(song => ({
            ...request, aggregation: undefined, deadline, k: 1,
            goal: { ...goal, songs: [song], ...(goal.arena ? { arena: { ...goal.arena, mode: "individual" as const } } : {}) },
          }));
          const scores = new Map<string, { value: number; proven: boolean }>();
          const accept = (index: number, response: EngineResponse) => {
            if (!current() || response.stopReason === "error") return;
            const best = response.overall[0];
            if (!best || !Number.isFinite(best.key)) return;
            const key = chartKey(candidates[index]!);
            const previous = scores.get(key);
            const proven = response.results.length > 0 && response.results.every(result => result.proven);
            if (previous?.proven || (previous && !proven && previous.value >= best.key)) return;
            scores.set(key, { value: best.key, proven });
            const charts = [...candidates].sort((a, b) =>
              (scores.get(chartKey(b))?.value ?? -1) - (scores.get(chartKey(a))?.value ?? -1));
            update({ recommendation: {
              ...screened, charts,
              coverage: { ...coverage, scored: scores.size, verified: [...scores.values()].filter(row => row.proven).length },
            } });
          };
          await engine.runBatch(requests, accept, { snapshot: (index, snapshot) => accept(index, snapshot.response) });
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          host.releaseTask(task);
        }
        return;
      }
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
        ${songPickerDifficultyFilters({
          label: host.t("difficulty", "Difficulty"),
          choices: DIFFICULTIES.map((label, value) => ({ label, value })),
          selected: difficulties, change: (difficulties) => update({ difficulties }),
          allLabel: state.single ? undefined : host.t("allChartDifficulties", "All difficulties"),
        })}
        ${state.expandDifficulties ? includeDifficultySelect(host, state.includeThrough ?? null, (includeThrough) => update({ includeThrough })) : nothing}
        ${songPickerAppliedFilters({
          items: applied, removeLabel: host.common("common.actions.remove", "Remove"),
          clearLabel: host.t("clearFilters", "Clear filters"), clear: clearFilters,
        })}
        ${offersRecommendations ? html`
          <div class="row row--wrap" aria-busy=${String(!!state.recommendationRequest)}>
            <button class="button button--tonal" type="button"
              ?disabled=${!recommendation && (incomplete || !visible.length || !!state.recommendationRequest)}
              @click=${() => recommendation ? update({ view: showingRecommendations ? "all" : "recommended" }) : void recommend()}>
              ${showingRecommendations ? host.t("browseCharts", "Browse charts")
                : recommendation ? host.t("recommendedCharts", "Recommended charts")
                : state.recommendationRequest ? host.t("chartRecommendationLoading", "Finding charts…")
                : host.t("recommendChartCount", "Recommend {count} charts", {
                    count: host.searchSettings.goal === "gekiso" ? GEKISO_RECOMMENDATIONS : DEFAULT_RECOMMENDATIONS,
                  })}
            </button>
            ${showingRecommendations && recommendation.coverage ? html`
              <span class="supporting-text tabular" role="status">${host.t(
                "chartRecommendationCoverage", "Screened {screened} / Scored {scored} of {candidates} / Verified {verified}", recommendation.coverage,
              )}</span>` : nothing}
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
    filters: songPickerFilterGroups({
      t: (key, fallback) => host.t(key, fallback),
      common: (key, fallback) => host.common(key, fallback),
      state: {
        category: String(state.categories?.[0] ?? ""), band: String(state.bands[0] ?? ""),
        attribute: String(state.attributes[0] ?? ""), gekisouTypes: state.gekisouTypes,
        gekisouMatch: state.gekisouMatch ?? "only", minLevel, maxLevel, maxSeconds: state.maxSeconds ?? null,
      },
      categories: categoryOptions, bands: [...bandOptions.values()].filter(option => option.label),
      attributes: (state.songRules ? [1, 2, 3, 4, 5, 99] : [1, 2, 3, 4, 5])
        .map(id => ({ value: String(id), label: catalog.attributeName(id) })),
      gekisou: true, duration: true, sort: renderResourceSort(host, "songs"),
      change: ({ category, band, attribute, gekisouTypes, ...patch }) => update({
        ...patch,
        ...(category === undefined ? {} : { categories: category ? [Number(category)] : [] }),
        ...(band === undefined ? {} : { bands: band ? [band.startsWith("credit:") ? band : Number(band)] : [] }),
        ...(attribute === undefined ? {} : { attributes: attribute ? [Number(attribute)] : [] }),
        ...(gekisouTypes === undefined ? {} : { gekisouTypes: [...gekisouTypes] }),
      }),
    }),
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
            if (state.expandDifficulties)
              host.setSongPickerPreferences(host.songDifficulties, state.includeThrough ?? null);
            state.change(appliedCharts);
            close();
          }}
        >
          ${host.t("applyCharts", "Use {count} charts", { count: appliedCharts.length })}
        </button>
      </div>
    `,
  });
}
