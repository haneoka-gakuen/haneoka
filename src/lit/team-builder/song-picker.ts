import { songMissions, matchesSelections } from "../../lib/catalog-filters";
/** Multi-song chooser on the shared selection pane. */
import { html, type TemplateResult } from "lit";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { chooserFacet } from "../ui/chooser-filters";
import { segmented } from "../ui/controls";
import { selectionPane } from "../ui/selection-pane";
import type { TeamBuilder } from "../team-builder";

export interface SongPickerState {
  songs: SongRef[];
  single: boolean;
  query: string;
  filtersOpen: boolean;
  bands: number[];
  attributes: number[];
  gekisouTypes: string[];
  difficulty: number;
  allowedSongIds?: number[];
  title?: string;
  change: (songs: SongRef[]) => void;
}
const DIFFICULTIES = [
  { value: "0", label: "EASY" },
  { value: "1", label: "NORMAL" },
  { value: "2", label: "HARD" },
  { value: "3", label: "EXPERT" },
  { value: "4", label: "SPECIAL" },
];

export function renderSongPicker(host: TeamBuilder): TemplateResult {
  const state = host.songPicker!;
  const catalog = host.catalog!;
  const update = (patch: Partial<SongPickerState>) => {
    host.songPicker = { ...state, ...patch };
    host.requestUpdate();
  };
  const close = () => {
    host.songPicker = null;
    host.requestUpdate();
  };
  const query = state.query.normalize("NFKC").toLocaleLowerCase(host.locale);
  const ids = Object.keys(catalog.data.songs)
    .map(Number)
    .filter((id) => {
      if (state.allowedSongIds && !state.allowedSongIds.includes(id)) return false;
      const song = catalog.data.songs[String(id)]!;
      if (!catalog.difficultyRows(id).some((row) => Number(row.difficulty) === state.difficulty)) return false;
      if (state.bands.length && !catalog.songBands(id).some((band) => state.bands.includes(band))) return false;
      if (state.attributes.length && !state.attributes.includes(Number(song.musicType))) return false;
      if (!matchesSelections(songMissions(song), state.gekisouTypes)) return false;
      return !query || `${catalog.songTitle(id)} ${catalog.songBands(id).map((band) => catalog.bandName(band)).join(" ")}`.normalize("NFKC").toLocaleLowerCase(host.locale).includes(query);
    })
    .sort((a, b) => b - a);
  const selected = new Set(state.songs.filter((song) => song.difficulty === state.difficulty).map((song) => String(song.songId)));
  const toggle = (value: string) => {
    const id = Number(value);
    const exists = state.songs.some((song) => song.songId === id && song.difficulty === state.difficulty);
    const songs = state.single
      ? [{ songId: id, difficulty: state.difficulty }]
      : exists
        ? state.songs.filter((song) => !(song.songId === id && song.difficulty === state.difficulty))
        : [...state.songs, { songId: id, difficulty: state.difficulty }];
    update({ songs });
    if (state.single) {
      state.change(songs);
      close();
    }
  };
  const all = { value: "", label: host.common("common.states.all", "All") };
  return selectionPane({
    id: "tb-song-picker",
    title: state.title ?? (state.single ? host.t("chooseSong", "Choose a song") : host.t("chooseSongs", "Choose songs")),
    closeLabel: host.common("common.actions.close", "Close"),
    close,
    searchLabel: host.common("common.actions.search", "Search"),
    filterLabel: host.t("filters", "Filters"),
    filtersOpen: state.filtersOpen,
    toggleFilters: () => update({ filtersOpen: !state.filtersOpen }),
    query: state.query,
    search: (value) => update({ query: value }),
    filterLayout: "facets",
    filters: html`
      ${chooserFacet({label:host.common("catalog.analysis.fields.gekisouType", "Gekiso type"),value:state.gekisouTypes[0] || "",allLabel:all.label,options:[{value:"Combo",label:host.common("catalog.songs.gekisou.gekisouMissionCombo","COMBO")},{value:"Luck",label:host.common("catalog.songs.gekisou.gekisouMissionLuck","LUCK")},{value:"JustCount",label:host.common("catalog.songs.gekisou.gekisouMissionJustCount","JUST")}],change:(value) => update({gekisouTypes:value ? [value] : []})})}
      ${chooserFacet({
        label: host.common("catalog.fields.band", "Band"),
        value: state.bands.length === 1 ? String(state.bands[0]) : "",
        allLabel: all.label,
        options: Object.keys(catalog.data.bands).map(Number).filter((id) => catalog.bandName(id)).map((id) => ({ value: String(id), label: catalog.bandName(id), image: catalog.bandIcon(id) || undefined })),
        change: (value: string) => update({ bands: value ? [Number(value)] : [] }),
      })}
      ${chooserFacet({
        label: host.common("catalog.fields.attribute", "Attribute"),
        value: state.attributes.length === 1 ? String(state.attributes[0]) : "",
        allLabel: all.label,
        options: [1, 2, 3, 4, 5].map((id) => ({ value: String(id), label: catalog.attributeName(id), image: catalog.attributeIcon(id) || undefined })),
        change: (value: string) => update({ attributes: value ? [Number(value)] : [] }),
      })}
    `,
    kind: "song",
    items: ids.map((id) => ({ ...catalog.songOptions(id, state.difficulty), value: String(id) })),
    selected: "",
    selectedValues: state.single ? undefined : selected,
    select: toggle,
    countLabel: host.t("songCount", "{count} songs", { count: ids.length }),
    emptyLabel: host.t("noSongs", "No songs match"),
    preview: html`
      <div class="stack tb-picker-footer">
        ${segmented({ label: host.t("difficulty", "Difficulty"), value: String(state.difficulty), grow: false, options: DIFFICULTIES, onSelect: (value) => update({ difficulty: Number(value) }) })}
        ${state.single
          ? html``
          : html`<div class="row row--wrap">
              <span class="tb-results__meta">${host.t("selectedSongs", "{count} selected", { count: state.songs.length })}</span>
              <span class="row__spacer"></span>
              <button class="button button--text" type="button" @click=${() => update({ songs: [...state.songs.filter((song) => song.difficulty !== state.difficulty || !ids.includes(song.songId)), ...ids.map((songId) => ({ songId, difficulty: state.difficulty }))] })}>${host.t("selectMatchingSongs", "Select all shown songs")}</button>
              <button class="button button--text" type="button" @click=${() => update({ songs: [] })}>${host.common("common.actions.clear", "Clear")}</button>
              <button class="button" type="button" @click=${() => { state.change(state.songs); close(); }}>${host.t("useSongs", "Use these songs")}</button>
            </div>`}
      </div>
    `,
  });
}
