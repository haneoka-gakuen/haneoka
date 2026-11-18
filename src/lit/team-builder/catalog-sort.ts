// L3 — GEB
// Input: Team-builder catalogue records and resource sort preferences.
// Output: Catalogue-compatible card/chart ordering and shared sort controls.
// Pos: [Map](../L2-2.md); adapter for owned cards and all team-builder pickers.
// Effects/Dependencies: Keeps per-workspace resource preferences; requests a render after changes.
import { cardRarityRank } from "../../lib/card-rarity";
import { catalogSortOptions, compareCatalogSort } from "../../lib/catalog-sort";
import { objectRow } from "../../lib/team-builder/data";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { sortControl } from "../ui/sort-control";
import type { TeamBuilder } from "../team-builder";

type Kind = "members" | "snaps" | "songs";
type Sort = { sort: string; order: "asc" | "desc" };
const preferences = new WeakMap<TeamBuilder, Map<Kind, Sort>>();
export function resourceSort(host: TeamBuilder, kind: Kind): Sort {
  return preferences.get(host)?.get(kind) ?? { sort: "release", order: "desc" };
}
export function renderResourceSort(host: TeamBuilder, kind: Kind) {
  const state = resourceSort(host, kind);
  const change = (patch: Partial<Sort>) => {
    let saved = preferences.get(host);
    if (!saved) preferences.set(host, saved = new Map());
    saved.set(kind, { ...state, ...patch });
    host.requestUpdate();
  };
  return sortControl({
    ...state,
    label: host.common("common.actions.sort", "Sort"),
    options: catalogSortOptions(kind === "members" ? "member" : kind === "snaps" ? "support" : "song", (key, fallback) => host.common(key, fallback)),
    ascendingLabel: host.common("common.layout.ascending", "Ascending"),
    descendingLabel: host.common("common.layout.descending", "Descending"),
    changeSort: sort => change({ sort }),
    changeOrder: order => change({ order }),
  });
}
function release(item: Record<string, unknown>) {
  const value = item.releasedAt ?? item.publishedAt ?? item.publicStartAt ?? item.startAt;
  return Number((Array.isArray(value) ? value.find(entry => Number(entry) > 0) : value) || 0);
}
function skillName(host: TeamBuilder, item: Record<string, unknown>, key: string) {
  const raw = objectRow(item.resolvedSkills)[key];
  const row = objectRow(Array.isArray(raw) ? raw[0] : raw);
  return host.catalog!.text(row.skillName) || String(row.id ?? "");
}
export function sortedCards(host: TeamBuilder, kind: "members" | "snaps", ids: readonly number[]) {
  const catalog = host.catalog!;
  const state = resourceSort(host, kind);
  const values = new Map(ids.map(id => {
    const item = catalog.cardFilterItem(kind, id);
    const stat = (key: string) => Number(objectRow(item.stat)[key] || item[key] || 0);
    let value: unknown;
    switch (state.sort) {
      case "id": value = String(id); break;
      case "title": value = catalog.cardName(kind, id); break;
      case "character": value = catalog.characterIds(kind, id)[0] || 0; break;
      case "band": value = Number(item.bandId || catalog.bandIds(kind, id)[0] || 0); break;
      case "performance": case "technique": case "visual": value = stat(state.sort); break;
      case "total": value = stat("performance") + stat("technique") + stat("visual"); break;
      case "leaderSkill": value = skillName(host, item, "leader"); break;
      case "liveSkill": value = skillName(host, item, "live"); break;
      case "gekisouSkill": value = skillName(host, item, "gekisou"); break;
      case "supportSkill": value = skillName(host, item, "support"); break;
      case "gekisouSupportSkill": value = skillName(host, item, "gekisouSupport"); break;
      case "release": value = release(item); break;
      case "rarity": value = cardRarityRank(item.rarity); break;
      default: value = item[state.sort];
    }
    return [id, value] as const;
  }));
  return [...ids].sort((a, b) => compareCatalogSort(values.get(a), values.get(b), {
    ...state, locale: host.locale, leftId: String(a), rightId: String(b),
  }));
}
const METRICS = ["time", "score", "eff", "bpm", "n", "nps", "sr"];
export function songMetricSort(host: TeamBuilder) {
  return METRICS.includes(resourceSort(host, "songs").sort);
}
export function sortedCharts(host: TeamBuilder, charts: readonly SongRef[], songView = (id: number) => host.catalog!.song(id)) {
  const catalog = host.catalog!;
  const state = resourceSort(host, "songs");
  const value = (ref: SongRef): unknown => {
    const item = songView(ref.songId);
    if (state.sort === "id") return String(ref.songId);
    if (state.sort === "title") return catalog.songTitle(ref.songId);
    if (state.sort === "band") return catalog.songArtist(ref.songId);
    if (state.sort === "release") return release(item);
    if (state.sort === "order") return Number(item.displayOrder ?? item.order ?? item.sortOrder ?? ref.songId);
    if (state.sort === "category") return Number((Array.isArray(item.musicCategories) ? item.musicCategories[0] : 99) || 99);
    if (state.sort === "lyrics") return catalog.text(item.lyricist);
    if (state.sort === "arrangement") return catalog.text(item.arranger);
    if (state.sort === "composer") return catalog.text(item.composer);
    if (state.sort === "musicType") return Number(item.musicType || 0);
    if (state.sort === "level") {
      const row = catalog.difficultyRows(ref.songId).find(row => Number(row.difficulty) === ref.difficulty);
      return Number(row?.sortLevel ?? row?.displayLevel ?? row?.playLevel ?? Number.NaN);
    }
    const chart = catalog.chartMetadata(ref);
    if (!chart) return Number.NaN;
    if (state.sort === "bpm") return Number(chart.firstBpm ?? chart.minBpm ?? chart.maxBpm);
    if (state.sort === "n") return Number(chart.n ?? chart.noteCount ?? chart.canonicalNoteCount);
    return chart[state.sort] == null ? Number.NaN : Number(chart[state.sort]);
  };
  const values = new Map(charts.map(ref => [`${ref.songId}:${ref.difficulty}`, value(ref)]));
  return [...charts].sort((a, b) => compareCatalogSort(values.get(`${a.songId}:${a.difficulty}`), values.get(`${b.songId}:${b.difficulty}`), {
    ...state, locale: host.locale, leftId: `${a.songId}:${a.difficulty}`, rightId: `${b.songId}:${b.difficulty}`,
    numeric: state.sort === "level" || METRICS.includes(state.sort),
  }));
}
