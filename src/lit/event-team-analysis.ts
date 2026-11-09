// L3 — GEB
// Input: An activity leaderboard player, related saved song boards and release-pinned growth rules.
// Output: Board coverage and paged exact-match groups with an optional rank interval on the selected board.
// Pos: [Map](L2-2.md); lazy activity-only action from the shared ranking rows.
// Effects/Dependencies: Reads saved activity snapshots and release-pinned team data; lazily owns one cancellable shared Rust/WASM engine Worker.
import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import { fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import type { TeamBuilderData } from "../lib/team-builder/data";
import type { EngineClient } from "../lib/team-builder/engine/client";
import { fetchEventTeamGrowthSources, type EventTeamGrowthSources } from "../lib/event-team-growth-limits";
import type { EventTeamConfiguration, EventTeamEquivalent, EventTeamRankRange, EventTeamSearchPage } from "../lib/event-team-analysis";
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
  kind: "challenge" | "total" | "points";
  row: SongRankingRowDto;
  observedAtMs: number;
}
interface Board { challengeId: number; musicId?: string }
type BoardReading = Board & (
  | { status: "included"; row: SongRankingRowDto }
  | { status: "notFound" | "missingGrowth" | "readFailed" | "identityMissing" }
);
let coverageId = 0;
const MAX_RANK = 0x7fffffff;
interface Group { band?: number; characters: number[] }
const usableDeck = (row: SongRankingRowDto | null | undefined): row is SongRankingRowDto => !!row?.totalPower
  && row.cards.length === 5 && row.cards.every((card) => card.memberCardId !== null && card.memberExp !== null
    && card.memberAwakeCount !== null && card.memberRank !== null && (!card.supportCardId
      || card.supportExp !== null && card.supportRank !== null));

const boardCache = new Map<string, { at: number; value: EventRankingDto }>();
async function readBoard(url: string, signal: AbortSignal) {
  const cached = boardCache.get(url);
  if (cached && Date.now() - cached.at < 45_000) return cached.value;
  const value = await fetchJson<EventRankingDto>(url, { signal });
  boardCache.set(url, { at: Date.now(), value });
  if (boardCache.size > 32) boardCache.delete(boardCache.keys().next().value!);
  return value;
}

class EventTeamAnalysisElement extends LitElement {
  static properties = {
    result: { state: true }, error: { state: true }, ready: { state: true }, busy: { state: true },
    expanded: { state: true }, paging: { state: true }, rangeError: { state: true },
  };
  locale = "en";
  region: GameRecordsRegion = "jp";
  private options!: Options;
  private boards: BoardReading[] = [];
  private primaryChallengeId?: number;
  private rankRange?: EventTeamRankRange;
  private draftMin = "";
  private draftMax = "";
  private readonly coverageId = `ranking-team-analysis-coverage-${++coverageId}`;
  private data?: TeamBuilderData;
  private growthSources?: EventTeamGrowthSources;
  private asOf = 0;
  private percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
  private engine?: EngineClient;
  private requestId = 0;
  private lifetime = new AbortController();
  declare private result: EventTeamSearchPage | undefined;
  declare private error: string;
  declare private ready: boolean;
  declare private busy: boolean;
  declare private paging: boolean;
  declare private expanded: ReadonlySet<string>;
  declare private rangeError: boolean;

  constructor() {
    super();
    this.result = undefined;
    this.error = "";
    this.ready = false;
    this.busy = false;
    this.paging = false;
    this.expanded = new Set();
    this.rangeError = false;
  }

  setup(options: Options) {
    this.options = options;
    this.locale = options.locale;
    this.region = options.region;
    this.percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    document.addEventListener("visibilitychange", () => this.engine?.pauseEventGrowth(document.hidden), { signal: this.lifetime.signal });
    void this.load();
  }
  private text(key: string) { return clientText(this.locale, `catalog.rankings.analysis.${key}`, ""); }
  createRenderRoot() { return this; }
  private close = () => this.remove();
  disconnectedCallback() {
    this.lifetime.abort();
    this.engine?.dispose();
    super.disconnectedCallback();
  }
  private async readObservation(board: Board, signal: AbortSignal): Promise<BoardReading> {
    const { row, event } = this.options;
    if (board.challengeId === this.primaryChallengeId) {
      return usableDeck(row) ? { ...board, status: "included", row } : { ...board, status: "missingGrowth" };
    }
    if (!row.profileId) return { ...board, status: "identityMissing" };
    const path = board.challengeId === 0 ? "total" : `challenges/${board.challengeId}`;
    try {
      const ranking = await readBoard(`/api/v2/game/records/${this.region}/events/${event.id}/${path}/latest`,
        AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      const match = ranking.rows.find((entry) => entry.profileId === row.profileId);
      return usableDeck(match) ? { ...board, status: "included", row: match }
        : { ...board, status: match ? "missingGrowth" : "notFound" };
    } catch {
      signal.throwIfAborted();
      return { ...board, status: "readFailed" };
    }
  }
  private async load() {
    try {
      const signal = this.lifetime.signal;
      const { event, challengeId, kind } = this.options;
      const source = this.region === "jp" ? "jp" : "intl";
      this.primaryChallengeId = kind === "challenge" ? Number(challengeId) : kind === "total" ? 0 : undefined;
      const targets: Board[] = event.challenges
        .filter((song) => (song.enabled && song.status !== "upcoming") || song.id === challengeId)
        .map((song) => ({ challengeId: Number(song.id), musicId: song.musicId }));
      if (event.totalRankingEnabled && event.totalRankingStatus !== "upcoming" || kind === "total") targets.unshift({ challengeId: 0 });
      const teamData = fetchTeamBuilderData(source, signal);
      const [data, boards, growthSources] = await Promise.all([
        teamData, Promise.all(targets.map((board) => this.readObservation(board, signal))),
        teamData.then((data) => fetchEventTeamGrowthSources(data, signal)),
      ]);
      signal.throwIfAborted();
      this.data = data;
      this.boards = boards;
      this.growthSources = growthSources;
      this.asOf = Date.now();
      this.primaryChallengeId ??= boards.find((board) => board.status === "included")?.challengeId;
      const primary = boards.find((board) => board.challengeId === this.primaryChallengeId);
      if (primary?.status !== "included") {
        this.error = primary?.status === "missingGrowth" || boards.some((board) => board.status === "missingGrowth")
          ? "missingGrowth" : boards.some((board) => board.status === "readFailed") ? "loadError" : "noSongRecord";
        return;
      }
      const { EngineClient } = await import("../lib/team-builder/engine/client");
      signal.throwIfAborted();
      this.engine = new EngineClient(data, undefined, { maxWorkers: 1 });
      this.ready = true;
      this.calculate();
    } catch {
      if (!this.lifetime.signal.aborted) this.error = "loadError";
    }
  }
  private calculate() {
    const { engine, growthSources, primaryChallengeId } = this;
    if (!engine || !growthSources || primaryChallengeId === undefined) return;
    const requestId = ++this.requestId;
    engine.cancel();
    engine.pauseEventGrowth(document.hidden);
    this.busy = true;
    this.paging = true;
    this.error = "";
    this.result = undefined;
    this.expanded = new Set();
    const included = this.boards.filter((board) => board.status === "included");
    void engine.analyzeEventGrowth({
      eventId: Number(this.options.event.id), asOf: this.asOf, sources: growthSources,
      primaryChallengeId, rankRange: this.rankRange,
      total: included.find((board) => board.challengeId === 0)?.row,
      observations: included.filter((board) => board.challengeId !== 0).map(({ challengeId, row }) => ({ row, challengeId })),
    }, (result) => {
      this.acceptPage(requestId, result);
    }).catch(() => {
      if (requestId !== this.requestId || this.engine !== engine || this.lifetime.signal.aborted) return;
      this.busy = false; this.paging = false; this.error = "missingRules";
    });
  }
  private applyRange = (event: SubmitEvent) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget as HTMLFormElement);
    const read = (name: string) => {
      const value = String(fields.get(name) ?? "").trim().normalize("NFKC");
      return value === "" ? undefined : /^[0-9]+$/u.test(value) ? Number(value) : NaN;
    };
    const min = read("min"), max = read("max");
    this.rangeError = [min, max].some((value) => value !== undefined && (!Number.isInteger(value) || value > MAX_RANK))
      || (min ?? 0) > (max ?? MAX_RANK);
    if (this.rangeError) return;
    const range = min === undefined && max === undefined ? undefined : { min, max };
    if (range?.min === this.rankRange?.min && range?.max === this.rankRange?.max) return;
    this.rankRange = range;
    this.calculate();
  };
  private clearRange = (event: Event) => {
    this.draftMin = this.draftMax = "";
    (event.currentTarget as HTMLButtonElement).form?.reset();
    this.rangeError = false;
    if (!this.rankRange) return;
    this.rankRange = undefined;
    this.calculate();
  };
  private acceptPage(requestId: number, result: EventTeamSearchPage) {
    if (requestId !== this.requestId || !this.engine || this.lifetime.signal.aborted) return;
    if (result.rejectedChallenges.length) {
      this.boards = this.boards.map((board) => result.rejectedChallenges.includes(board.challengeId)
        ? { challengeId: board.challengeId, musicId: board.musicId, status: "missingGrowth" } : board);
    }
    this.busy = result.rows.length === 0 && !result.complete;
    this.paging = !result.complete && !result.awaitingPage;
    this.result = result;
  }
  private async page(index: number) {
    if (!this.engine || this.paging) return;
    this.paging = true;
    const requestId = this.requestId;
    try { await this.engine.eventGrowthPage(index, (result) => this.acceptPage(requestId, result)); }
    catch { if (requestId === this.requestId) { this.paging = false; this.error = "missingRules"; } }
  }
  private retry = () => {
    const prefix = `/api/v2/game/records/${this.region}/events/${this.options.event.id}/`;
    for (const key of boardCache.keys()) if (key.startsWith(prefix)) boardCache.delete(key);
    this.engine?.dispose(); this.engine = undefined;
    ++this.requestId; this.ready = false; this.error = ""; this.result = undefined; this.expanded = new Set();
    this.boards = [];
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
    if (challengeId === 0) return { title: this.text("totalRanking"), jacket: "" };
    const board = this.boards.find((entry) => entry.challengeId === challengeId);
    const source = board?.musicId ? this.data?.songs[board.musicId] : undefined;
    return { title: localizedText(source?.musicTitle, this.locale) || `#${challengeId}`,
      jacket: String(source?.jacketThumbUrl ?? source?.jacketUrl ?? "") };
  }
  private renderCoverage() {
    if (!this.boards.length) return nothing;
    const included = this.boards.filter((board) => board.status === "included").length;
    const coverage = this.text("coverage").replace("{n}", String(included)).replace("{total}", String(this.boards.length));
    return html`
      <button class="button button--tonal" type="button" popovertarget=${this.coverageId}>${coverage}</button>
      <div class="menu ranking-team-analysis__coverage" id=${this.coverageId} popover="auto" role="region" aria-label=${coverage}>
        <ul class="stack">
          ${this.boards.map((board) => html`<li class="row row--between">
            <span>${this.song(board.challengeId).title}</span>
            <span class="md-label-medium">${this.text(board.status)}</span>
          </li>`)}
        </ul>
      </div>`;
  }
  private renderControls() {
    const board = this.primaryChallengeId === undefined ? "" : this.song(this.primaryChallengeId).title;
    const scope = this.text("rangeScope").replace("{board}", board);
    const { min, max } = this.rankRange ?? {};
    const range = min === undefined ? max === undefined ? "" : `≤ ${max}`
      : max === undefined ? `≥ ${min}` : this.span(min, max);
    const primaryAvailable = this.boards.some((entry) => entry.challengeId === this.primaryChallengeId && entry.status === "included");
    return html`<div class="row ranking-team-analysis__controls">
      ${this.ready && primaryAvailable ? html`<form class="ranking-team-analysis__filter" @submit=${this.applyRange}>
        <span class="md-label-large ranking-team-analysis__scope" role="status">
          ${this.rangeError ? this.text("rangeInvalid") : html`
            <span class="truncate" title=${scope}>${scope}</span>
            ${range ? html`<span>${range}</span>` : nothing}
          `}
        </span>
        <md-outlined-text-field name="min" inputmode="numeric" label=${this.text("rankMin")} ?error=${this.rangeError}
          .value=${live(this.draftMin)} @input=${(event: Event) => { this.draftMin = (event.currentTarget as HTMLInputElement).value; }}></md-outlined-text-field>
        <md-outlined-text-field name="max" inputmode="numeric" label=${this.text("rankMax")} ?error=${this.rangeError}
          .value=${live(this.draftMax)} @input=${(event: Event) => { this.draftMax = (event.currentTarget as HTMLInputElement).value; }}></md-outlined-text-field>
        <button class="button button--tonal" type="submit">${this.text("applyRange")}</button>
        <button class="button button--text" type="button" @click=${this.clearRange}>${this.text("clearRange")}</button>
      </form>` : nothing}
      ${this.renderCoverage()}
    </div>`;
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
  private toggle(key: string) {
    const expanded = new Set(this.expanded);
    if (!expanded.delete(key)) expanded.add(key);
    this.expanded = expanded;
  }
  private renderPlan(configuration: EventTeamConfiguration, index: number, groups: Group[], provisional: boolean) {
    const characters = new Map(configuration.characters.map((entry, position) => [entry.id, { entry, position }]));
    const instruments = new Map(configuration.instruments.map((entry, position) => [entry.id, { entry, position }]));
    const key = configuration.id, open = this.expanded.has(key);
    const label = this.text("plan").replace("{n}", (index + 1).toLocaleString(this.locale));
    const id = `ranking-team-analysis-plan-${encodeURIComponent(key)}`;
    return html`<tbody class="ranking-team-analysis__plan">
      <tr>
        <th scope="row" class="is-sticky ranking-team-analysis__key">
          <button class="button button--text ranking-team-analysis__toggle" type="button" aria-label=${label}
            title=${this.text("equivalents").replace("{n}", configuration.equivalents.length.toLocaleString(this.locale))}
            aria-expanded=${String(open)} aria-controls=${id} @click=${() => this.toggle(key)}>
            <span>${(index + 1).toLocaleString(this.locale)}</span>
            ${provisional ? html`<span class="md-label-small">${this.text("provisional")}</span>` : nothing}
            ${configuration.equivalents.length > 1 ? html`<span class="md-label-small">${this.text("equivalentCount").replace("{n}", configuration.equivalents.length.toLocaleString(this.locale))}</span>` : nothing}${icon("expand_more")}</button></th>
        <td class="is-numeric ranking-team-analysis__minor">${this.percent.format(configuration.vipBonus / 10000)}</td>
        ${this.cells(groups,
          (band) => { const value = instruments.get(band)?.entry; return value ? this.span(value.minTotal, value.total) : nothing; },
          (character) => { const value = characters.get(character)?.entry; return value ? this.span(value.minLevel, value.level) : nothing; })}
        <td class="is-numeric ranking-team-analysis__minor">${this.span(configuration.totalRank.min, configuration.totalRank.max)}</td>
      </tr>
      <tr class="ranking-team-analysis__detail" id=${id} ?hidden=${!open}>
        <th scope="row" class="is-sticky ranking-team-analysis__key">${this.text("taskCap")}</th>
        <td></td>
        ${this.cells(groups, () => nothing, (character) => characters.get(character)?.entry.cap ?? nothing)}
        <td></td>
      </tr>
      ${configuration.equivalents.map((equivalent, variant) => html`
        ${configuration.equivalents.length > 1 ? this.renderEquivalent(equivalent, variant, groups, open) : nothing}
        ${open ? equivalent.witnesses.map((witness) => {
          const { title, jacket } = this.song(witness.challengeId);
          return html`<tr class="ranking-team-analysis__detail" ?hidden=${!open}>
            <th scope="row" class="is-sticky ranking-team-analysis__key" title=${title}>
              ${jacket ? html`<img class="ranking-team-analysis__jacket" width="32" height="32" src=${jacket} alt=${title} loading="lazy" decoding="async" />`
                : html`<span class="truncate">${title}</span>`}</th>
            <td></td>
            ${this.cells(groups,
              (band) => { const value = instruments.get(band); return value ? witness.instruments[value.position] : nothing; },
              (character) => { const value = characters.get(character); return value ? witness.levels[value.position] : nothing; })}
            <td class="is-numeric">
              ${this.span(witness.totalRank.min, witness.totalRank.max)}
              <span class="ranking-team-analysis__outside">${this.text("outsideRank")
                .replace("{range}", this.span(witness.outsideRank.min, witness.outsideRank.max))}</span>
            </td>
          </tr>`;
        }) : nothing}`)}
    </tbody>`;
  }
  private renderEquivalent(equivalent: EventTeamEquivalent, index: number, groups: Group[], open: boolean) {
    const characters = new Map(equivalent.characters.map((entry) => [entry.id, entry]));
    const instruments = new Map(equivalent.instruments.map((entry) => [entry.id, entry]));
    return html`<tr class="ranking-team-analysis__detail" ?hidden=${!open}>
      <th scope="row" class="is-sticky ranking-team-analysis__key">${this.text("combination").replace("{n}", (index + 1).toLocaleString(this.locale))}</th>
      <td></td>
      ${this.cells(groups,
        (band) => { const value = instruments.get(band); return value ? this.span(value.minTotal, value.total) : nothing; },
        (character) => { const value = characters.get(character); return value ? this.span(value.minLevel, value.level) : nothing; })}
      <td class="is-numeric">${this.span(equivalent.totalRank.min, equivalent.totalRank.max)}</td>
    </tr>`;
  }
  private renderResult() {
    const result = this.result;
    if (!result) return nothing;
    if (result.complete && result.status !== "ready") {
      return result.status === "noMatch" || result.status === "conflictingRecords"
        ? html`<p class="md-body-medium" role="status">${this.text(result.status)}</p>` : this.failure(result.status);
    }
    const rows = result.rows;
    if (!rows.length) return loadingState(this.text("loading"));
    const groups = this.groups(rows[0]!);
    return html`
      <div class="row row--between ranking-team-analysis__toolbar">
        <span class="chip chip--static chip--tonal"><span class="chip__label">${this.text("found").replace("{n}", result.certified.toLocaleString(this.locale))}</span></span>
        <span class="md-label-medium truncate">${this.text(rows[0]!.matchedTotal ? rows[0]!.matchedChallenges.length ? "matchedWithTotal" : "matchedTotal" : "matched")
          .replace("{n}", rows[0]!.matchedChallenges.length.toLocaleString(this.locale))}</span>
        <span class="md-label-large ranking-team-analysis__status truncate" role="status">${this.text(result.complete ? "complete" : result.awaitingPage ? "pageReady" : "searching")}</span>
      </div>
      <div class="table-scroll ranking-team-analysis__scroll">
        <table class="data-table data-table--numeric ranking-team-analysis__table">
          <thead>
            <tr>
              <th scope="col" rowspan="2" class="is-sticky ranking-team-analysis__key">#</th>
              <th scope="col" rowspan="2" class="is-numeric">${this.text("vipBonus")}</th>
              ${groups.map((group) => html`<th scope="colgroup" class="ranking-team-analysis__band ranking-team-analysis__start"
                colspan=${group.characters.length + (group.band === undefined ? 0 : 1)}>
                <span class="truncate">${group.band === undefined ? "" : this.band(group.band)}</span></th>`)}
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
                    <span title=${name}>${name}</span></th>`;
                })}`)}
            </tr>
          </thead>
          ${repeat(rows, (configuration) => configuration.id, (configuration, index) => {
            const position = result.page * result.pageSize + index;
            return this.renderPlan(configuration, position, groups, position >= result.certified);
          })}
        </table>
      </div>`;
  }
  render() {
    if (!this.options) return nothing;
    return html`
      <dialog class="dialog ranking-team-analysis" ${modal(this.close)} aria-label=${this.text("title")}>
        <div class="dialog__surface">
          <header class="dialog__header"><h2 class="row row--between"><span class="truncate" title=${this.options.row.name}>${this.options.row.name}</span>
            <span class="md-label-large ranking-team-analysis__kind">${this.text("title")}</span></h2></header>
          <div class="dialog__body stack stack--flex">
            ${this.ready || this.boards.length ? this.renderControls() : nothing}
            ${!this.ready && !this.error ? loadingState(this.text("reading")) : nothing}
            ${this.ready && !this.error ? html`
              <div class="ranking-team-analysis__result" aria-busy=${this.paging ? "true" : "false"}>
                ${this.busy ? loadingState(this.text("loading")) : this.renderResult()}
              </div>
            ` : nothing}
            ${this.error ? this.failure(this.error) : nothing}
          </div>
          <footer class="dialog__actions">
            ${this.result?.rows.length ? html`
              <button class="button button--text button--icon" type="button" aria-label=${this.text("previousPage")}
                ?disabled=${this.paging || this.result.page === 0} @click=${() => void this.page(this.result!.page - 1)}>${icon("chevron_left")}</button>
              <span class="md-label-large">${this.text("page").replace("{n}", (this.result.page + 1).toLocaleString(this.locale))}</span>
              <button class="button button--text button--icon" type="button" aria-label=${this.text("nextPage")}
                ?disabled=${this.paging || !this.result.hasMore} @click=${() => void this.page(this.result!.page + 1)}>${icon("chevron_right")}</button>` : nothing}
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
