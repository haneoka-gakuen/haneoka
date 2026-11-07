// L3 — GEB
// Input: An activity leaderboard player, related saved song boards and release-pinned growth rules.
// Output: A shared dialog streaming up to ten preferred merged character and instrument configurations.
// Pos: [Map](L2-2.md); lazy activity-only action from the shared ranking rows.
// Effects/Dependencies: Reads saved activity snapshots and release-pinned team data; owns one cancellable local worker.
import { LitElement, html, nothing } from "lit";
import { fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import type { TeamBuilderData } from "../lib/team-builder/data";
import { fetchEventTeamGrowthSources, type EventTeamGrowthSources } from "../lib/event-team-growth-limits";
import type { EventTeamConfiguration, EventTeamSearchPage } from "../lib/event-team-analysis";
import type { EventRankingDto, GameRecordsRegion, SongRankingRowDto, TrackedEventDto } from "../lib/game-records";
import { clientText } from "../i18n/client";
import { fetchJson, localizedText } from "./shared/catalog";
import { icon } from "./ui/icon";
import { modal } from "./ui/modal";
import { loadingState } from "./ui/state";
import "../styles/event-team-analysis.css";

interface Options {
  locale: string;
  region: GameRecordsRegion;
  event: TrackedEventDto;
  challengeId: string;
  row: SongRankingRowDto;
  observedAtMs: number;
}
interface SongRecord { challengeId: string; musicId: string; row: SongRankingRowDto; observedAtMs: number }
interface Group { band?: number; characters: number[] }
const observationCache = new Map<string, { at: number; records: SongRecord[] }>();

class EventTeamAnalysisElement extends LitElement {
  static properties = {
    result: { state: true }, error: { state: true }, ready: { state: true }, busy: { state: true },
    expanded: { state: true },
  };
  locale = "en";
  region: GameRecordsRegion = "jp";
  private options!: Options;
  private records: SongRecord[] = [];
  private data?: TeamBuilderData;
  private growthSources?: EventTeamGrowthSources;
  private asOf = 0;
  private percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
  private worker?: Worker;
  private requestId = 0;
  private lifetime = new AbortController();
  declare private result: EventTeamSearchPage | undefined;
  declare private error: string;
  declare private ready: boolean;
  declare private busy: boolean;
  declare private expanded: ReadonlySet<number>;

  constructor() {
    super();
    this.result = undefined;
    this.error = "";
    this.ready = false;
    this.busy = false;
    this.expanded = new Set();
  }

  setup(options: Options) {
    this.options = options;
    this.locale = options.locale;
    this.region = options.region;
    this.percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    document.addEventListener("visibilitychange", () => this.worker?.postMessage({ paused: document.hidden }), { signal: this.lifetime.signal });
    void this.load();
  }
  private text(key: string) { return clientText(this.locale, `catalog.rankings.analysis.${key}`, ""); }
  createRenderRoot() { return this; }
  private close = () => this.remove();
  disconnectedCallback() {
    this.lifetime.abort();
    this.worker?.terminate();
    super.disconnectedCallback();
  }
  private async load() {
    try {
      const signal = this.lifetime.signal;
      const { event, row, challengeId, observedAtMs } = this.options;
      const source = this.region === "jp" ? "jp" : "intl";
      const cacheKey = `${this.region}/${event.id}/${row.profileId}`;
      const cached = observationCache.get(cacheKey);
      const records = Promise.all(event.challenges.filter((song) => song.enabled).map(async (song): Promise<SongRecord | null> => {
          if (song.id === challengeId) return { challengeId, musicId: song.musicId, row, observedAtMs };
          if (!row.profileId) return null;
          if (cached && Date.now() - cached.at < 45_000) return cached.records.find((record) => record.challengeId === song.id) ?? null;
          const ranking = await fetchJson<EventRankingDto>(`/api/v2/game/records/${this.region}/events/${event.id}/challenges/${song.id}/latest`, { signal });
          const match = ranking.rows.find((entry) => entry.profileId && entry.profileId === row.profileId);
          return match?.totalPower ? { challengeId: song.id, musicId: song.musicId, row: match,
            observedAtMs: ranking.observedAtMs ?? ranking.fetchedAtMs ?? 0 } : null;
        })).then((rows) => rows.filter((row) => row !== null));
      const teamData = fetchTeamBuilderData(source, signal);
      const [data, songs, growthSources] = await Promise.all([teamData, records,
        teamData.then((data) => fetchEventTeamGrowthSources(data, signal))]);
      signal.throwIfAborted();
      this.data = data;
      this.records = songs;
      this.growthSources = growthSources;
      this.asOf = Date.now();
      if (!songs.length) { this.error = "noSongRecord"; return; }
      if (row.profileId) {
        observationCache.delete(cacheKey);
        observationCache.set(cacheKey, { at: cached && Date.now() - cached.at < 45_000 ? cached.at : Date.now(), records: songs });
        if (observationCache.size > 32) observationCache.delete(observationCache.keys().next().value!);
      }
      this.worker = new Worker(new URL("../workers/event-team-analysis.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<EventTeamSearchPage>) => {
        if (event.data.id !== this.requestId) return;
        this.busy = event.data.count === 0 && !event.data.complete;
        this.result = event.data;
      };
      this.worker.onerror = () => { this.busy = false; this.error = "missingRules"; };
      this.worker.postMessage({ paused: document.hidden });
      this.ready = true;
      this.calculate(true);
    } catch {
      if (!this.lifetime.signal.aborted) this.error = "loadError";
    }
  }
  private calculate(initialize = false) {
    const song = this.records[0];
    if (!song) return;
    this.busy = true;
    this.error = "";
    this.result = undefined;
    this.expanded = new Set();
    this.worker?.postMessage({ id: ++this.requestId, ...(initialize ? { data: this.data, growthSources: this.growthSources } : {}), row: song.row, asOf: this.asOf,
      eventId: Number(this.options.event.id), challengeId: Number(song.challengeId),
      related: this.records.map((reading) => ({ row: reading.row, challengeId: Number(reading.challengeId) })) });
  }
  private retry = () => {
    observationCache.delete(`${this.region}/${this.options.event.id}/${this.options.row.profileId}`);
    this.worker?.terminate(); this.worker = undefined;
    ++this.requestId; this.ready = false; this.error = ""; this.result = undefined; this.expanded = new Set();
    void this.load();
  };
  private span(low: number | undefined, high: number) {
    return low !== undefined && low < high ? `${low}–${high}` : String(high);
  }
  private character(id: number) {
    const source = this.data!.characters[String(id)];
    return { name: localizedText(source?.characterName, this.locale), face: String(source?.faceImage ?? ""), band: Number(source?.bandId ?? 0) };
  }
  private band(id: number) { return localizedText(this.data!.bands[String(id)]?.bandName, this.locale); }
  private song(challengeId: number) {
    const record = this.records.find((entry) => Number(entry.challengeId) === challengeId);
    const source = record ? this.data!.songs[record.musicId] : undefined;
    return { title: localizedText(source?.musicTitle, this.locale) || `#${challengeId}`,
      jacket: String(source?.jacketThumbUrl ?? source?.jacketUrl ?? "") };
  }
  private failure(key: string) {
    return html`<div class="row row--between ranking-team-analysis__failure">
      <p class="md-body-medium" role="status">${this.text(key)}</p>
      <button class="button button--tonal" type="button" @click=${this.retry}>${this.text("refresh")}</button></div>`;
  }
  private groups(configuration: EventTeamConfiguration): Group[] {
    const groups: Group[] = configuration.instruments.map((band) => ({ band: band.id, characters: [] }));
    const loose: number[] = [];
    for (const character of configuration.characters)
      (groups.find((group) => group.band === this.character(character.id).band)?.characters ?? loose).push(character.id);
    return loose.length ? [...groups, { characters: loose }] : groups;
  }
  private cells(groups: Group[], instrument: (id: number) => unknown, character: (id: number) => unknown) {
    return groups.map((group) => html`
      ${group.band === undefined ? nothing
        : html`<td class="is-numeric ranking-team-analysis__instrument ranking-team-analysis__start">${instrument(group.band)}</td>`}
      ${group.characters.map((id, index) => html`<td class=${`is-numeric ranking-team-analysis__level${group.band === undefined && index === 0
        ? " ranking-team-analysis__start" : ""}`}>${character(id)}</td>`)}`);
  }
  private toggle(index: number) {
    const expanded = new Set(this.expanded);
    if (!expanded.delete(index)) expanded.add(index);
    this.expanded = expanded;
  }
  private renderPlan(configuration: EventTeamConfiguration, index: number, groups: Group[], bonusColumn: boolean) {
    const characters = new Map(configuration.characters.map((entry, position) => [entry.id, { entry, position }]));
    const instruments = new Map(configuration.instruments.map((entry, position) => [entry.id, { entry, position }]));
    const open = this.expanded.has(index);
    const label = this.text("plan").replace("{n}", (index + 1).toLocaleString(this.locale));
    const id = `ranking-team-analysis-plan-${index}`;
    return html`<tbody class="ranking-team-analysis__plan">
      <tr>
        <th scope="row" class="is-sticky ranking-team-analysis__key">
          <button class="button button--text ranking-team-analysis__toggle" type="button" aria-label=${label}
            aria-expanded=${String(open)} aria-controls=${id} @click=${() => this.toggle(index)}>
            <span>${(index + 1).toLocaleString(this.locale)}</span>${icon("expand_more")}</button></th>
        ${this.cells(groups,
          (band) => { const value = instruments.get(band)?.entry; return value ? this.span(value.minTotal, value.total) : nothing; },
          (character) => { const value = characters.get(character)?.entry; return value ? this.span(value.minLevel, value.level) : nothing; })}
        ${bonusColumn ? html`<td class="is-numeric ranking-team-analysis__minor">${this.percent.format(configuration.vipBonus / 10000)}</td>` : nothing}
        <td class="is-numeric ranking-team-analysis__minor">${this.span(configuration.totalRank.min, configuration.totalRank.max)}</td>
      </tr>
      <tr class="ranking-team-analysis__detail" id=${id} ?hidden=${!open}>
        <th scope="row" class="is-sticky ranking-team-analysis__key">${this.text("taskCap")}</th>
        ${this.cells(groups, () => nothing, (character) => characters.get(character)?.entry.cap ?? nothing)}
        ${bonusColumn ? html`<td></td>` : nothing}<td></td>
      </tr>
      ${configuration.changed ? configuration.witnesses.map((witness) => {
        const { title, jacket } = this.song(witness.challengeId);
        return html`<tr class="ranking-team-analysis__detail" ?hidden=${!open}>
          <th scope="row" class="is-sticky ranking-team-analysis__key" title=${title}>
            ${jacket ? html`<img class="ranking-team-analysis__jacket" width="32" height="32" src=${jacket} alt=${title} loading="lazy" decoding="async" />`
              : html`<span class="truncate">${title}</span>`}</th>
          ${this.cells(groups,
            (band) => { const value = instruments.get(band); return value ? witness.instruments[value.position] : nothing; },
            (character) => { const value = characters.get(character); return value ? witness.levels[value.position] : nothing; })}
          ${bonusColumn ? html`<td></td>` : nothing}
          <td class="is-numeric">${this.span(witness.totalRank.min, witness.totalRank.max)}</td>
        </tr>`;
      }) : nothing}
    </tbody>`;
  }
  private renderResult() {
    const result = this.result;
    if (!result) return nothing;
    if (result.complete && result.status !== "ready") return this.failure(result.status);
    const rows = result.rows;
    if (!rows.length) return loadingState(this.text("loading"));
    const groups = this.groups(rows[0]!);
    const bonusColumn = new Set(rows.map((row) => row.vipBonus)).size > 1;
    const relaxed = rows.some((row) => row.relaxed);
    return html`
      <div class="row row--between ranking-team-analysis__toolbar">
        ${bonusColumn ? html`<span></span>` : html`<span class="chip chip--static chip--tonal">
          <span class="chip__label">${this.text("vipBonus")} ${this.percent.format(rows[0]!.vipBonus / 10000)}</span></span>`}
        <span class="md-label-large ranking-team-analysis__status" role="status">${this.text(result.complete
          ? relaxed ? "completeRelaxed" : "complete"
          : relaxed ? "searchingRelaxed" : "searching")}</span>
      </div>
      <div class="table-scroll ranking-team-analysis__scroll">
        <table class="data-table data-table--numeric ranking-team-analysis__table">
          <thead>
            <tr>
              <th scope="col" rowspan="2" class="is-sticky ranking-team-analysis__key">#</th>
              ${groups.map((group) => html`<th scope="colgroup" class="ranking-team-analysis__band ranking-team-analysis__start"
                colspan=${group.characters.length + (group.band === undefined ? 0 : 1)}>
                <span class="truncate">${group.band === undefined ? "" : this.band(group.band)}</span></th>`)}
              ${bonusColumn ? html`<th scope="col" rowspan="2" class="is-numeric">${this.text("vipBonus")}</th>` : nothing}
              <th scope="col" rowspan="2" class="is-numeric">${this.text("rankSum")}</th>
            </tr>
            <tr>
              ${groups.map((group) => html`
                ${group.band === undefined ? nothing : html`<th scope="col" class="ranking-team-analysis__instrument ranking-team-analysis__start"
                  title=${this.text("instrumentTotal")}>${this.text("instrument")}</th>`}
                ${group.characters.map((id, index) => {
                  const { name, face } = this.character(id);
                  return html`<th scope="col" aria-label=${name} title=${name} class=${`ranking-team-analysis__member${group.band === undefined && index === 0
                    ? " ranking-team-analysis__start" : ""}`}>
                    <img width="32" height="32" src=${face} alt="" loading="lazy" decoding="async" />
                    <span>${name}</span></th>`;
                })}`)}
            </tr>
          </thead>
          ${rows.map((configuration, index) => this.renderPlan(configuration, index, groups, bonusColumn))}
        </table>
      </div>`;
  }
  render() {
    if (!this.options) return nothing;
    return html`
      <dialog class="dialog ranking-team-analysis" ${modal(this.close)} aria-label=${this.text("title")}>
        <div class="dialog__surface">
          <header class="dialog__header"><h2 class="row row--between"><span class="truncate">${this.options.row.name}</span>
            <span class="md-label-large ranking-team-analysis__kind">${this.text("title")}</span></h2></header>
          <div class="dialog__body stack stack--flex">
            ${!this.ready && !this.error ? loadingState(this.text("reading")) : nothing}
            ${this.ready && !this.error ? html`
              <div class="ranking-team-analysis__result" aria-busy=${this.busy ? "true" : "false"}>
                ${this.busy ? loadingState(this.text("loading")) : this.renderResult()}
              </div>
            ` : nothing}
            ${this.error ? this.failure(this.error) : nothing}
          </div>
          <footer class="dialog__actions">
            <span class="row__spacer"></span>
            <button class="button button--text" type="button" @click=${this.close}>
            ${clientText(this.locale, "common.actions.close", "Close")}</button></footer>
        </div>
      </dialog>`;
  }
}
if (!customElements.get("event-team-analysis")) customElements.define("event-team-analysis", EventTeamAnalysisElement);

export function showEventTeamAnalysis(options: Options) {
  const element = document.createElement("event-team-analysis") as EventTeamAnalysisElement;
  document.body.append(element);
  element.setup(options);
  return () => element.remove();
}
