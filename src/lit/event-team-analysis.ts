// L3 — GEB
// Input: An activity leaderboard player, related saved song boards and release-pinned growth rules.
// Output: Immediate growth inputs, board coverage and paged exact matches inside the requested neighborhoods.
// Pos: [Map](L2-2.md); lazy activity-only action from the shared ranking rows.
// Effects/Dependencies: Reads saved activity snapshots and release-pinned team data; lazily owns one cancellable shared Rust/WASM engine Worker.
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/switch/switch.js";
import { fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import type { TeamBuilderData } from "../lib/team-builder/data";
import type { EngineClient } from "../lib/team-builder/engine/client";
import { fetchEventTeamGrowthSources, type EventTeamGrowthSources } from "../lib/event-team-growth-limits";
import type { EventTeamConfiguration, EventTeamEquivalent, EventTeamRankRange, EventTeamPreferences, EventTeamSearchPage } from "../lib/event-team-analysis";
import type { EventRankingDto, GameRecordsRegion, SongRankingRowDto, TrackedEventDto } from "../lib/game-records";
import { clientText } from "../i18n/client";
import { fetchJson, localizedText } from "./shared/catalog";
import { icon } from "./ui/icon";
import { modal } from "./ui/modal";
import { accordion } from "./ui/accordion";
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
  private draftVip = "";
  private defaultCharacter = "18";
  private defaultInstrument = "75";
  private characterRadius = "3";
  private instrumentRadius = "10";
  private allowGrowth = false;
  private rangeExpanded = false;
  private characterLevels = new Map<number, string>();
  private instrumentLevels = new Map<number, string>();
  private related: Group[] = [];
  private preferences?: EventTeamPreferences;
  private invalidFields = new Set<string>();
  private dirty = false;
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

  private disposeSongDisplay?: () => void;
  setup(options: Options) {
    this.disposeSongDisplay?.();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
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
    this.disposeSongDisplay?.();
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
      const teamData = fetchTeamBuilderData(source, signal).then((data) => {
        signal.throwIfAborted();
        this.data = data;
        this.setRelated([this.options.row]);
        this.requestUpdate();
        return data;
      });
      const [data, boards, growthSources] = await Promise.all([
        teamData, Promise.all(targets.map((board) => this.readObservation(board, signal))),
        teamData.then((data) => fetchEventTeamGrowthSources(data, signal)),
      ]);
      signal.throwIfAborted();
      this.data = data;
      this.boards = boards;
      this.setRelated(boards.filter((board) => board.status === "included").map((board) => board.row));
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
    } catch {
      if (!this.lifetime.signal.aborted) this.error = "loadError";
    }
  }
  private calculate() {
    const { engine, growthSources, primaryChallengeId } = this;
    if (!engine || !growthSources || primaryChallengeId === undefined) return;
    const requestId = ++this.requestId;
    if (this.paging) engine.cancel();
    engine.pauseEventGrowth(document.hidden);
    this.busy = true;
    this.paging = true;
    this.error = "";
    this.result = undefined;
    this.expanded = new Set();
    const included = this.boards.filter((board) => board.status === "included");
    void engine.analyzeEventGrowth({
      eventId: Number(this.options.event.id), asOf: this.asOf, sources: growthSources,
      primaryChallengeId, rankRange: this.rankRange, preferences: this.preferences,
      total: included.find((board) => board.challengeId === 0)?.row,
      observations: included.filter((board) => board.challengeId !== 0).map(({ challengeId, row }) => ({ row, challengeId })),
    }, (result) => {
      this.acceptPage(requestId, result);
    }).catch(() => {
      if (requestId !== this.requestId || this.engine !== engine || this.lifetime.signal.aborted) return;
      this.busy = false; this.paging = false; this.error = "missingRules";
    });
  }
  private setRelated(rows: SongRankingRowDto[]) {
    const ids = new Set(rows.flatMap((row) => row.cards.map((card) => card.memberCardId)
      .map((id) => id === null ? undefined : this.data?.members[String(id)]?.characterId)
      .filter((id): id is number => id !== undefined)));
    const bands = new Map<number, number[]>();
    for (const id of [...ids].sort((a, b) => a - b)) {
      const band = this.character(id).band;
      if (!bands.has(band)) bands.set(band, []);
      bands.get(band)!.push(id);
    }
    this.related = [...bands].sort(([a], [b]) => a - b).map(([band, characters]) => ({ band, characters }));
  }
  private edit(key: string, value: string) {
    if (key === "min") this.draftMin = value;
    else if (key === "max") this.draftMax = value;
    else if (key === "vip") this.draftVip = value;
    else if (key === "defaultCharacter") this.defaultCharacter = value;
    else if (key === "defaultInstrument") this.defaultInstrument = value;
    else if (key === "characterRadius") this.characterRadius = value;
    else if (key === "instrumentRadius") this.instrumentRadius = value;
    else if (key === "allowGrowth") this.allowGrowth = value === "true";
    else if (key.startsWith("character-")) this.characterLevels.set(Number(key.slice(10)), value);
    else if (key.startsWith("instrument-")) this.instrumentLevels.set(Number(key.slice(11)), value);
    if (!this.dirty) {
      this.dirty = true;
      ++this.requestId;
      if (this.paging) this.engine?.cancel();
      this.busy = this.paging = false;
      this.result = undefined;
      this.expanded = new Set();
    }
    this.requestUpdate();
  }
  private applyRange = (event: SubmitEvent) => {
    event.preventDefault();
    this.invalidFields = new Set();
    const read = (key: string, raw: string, min: number, max: number, optional = false) => {
      const text = raw.trim().normalize("NFKC");
      if (optional && !text) return undefined;
      const value = /^[0-9]+$/u.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(value) || value < min || value > max) this.invalidFields.add(key);
      return value;
    };
    const min = read("min", this.draftMin, 0, MAX_RANK, true), max = read("max", this.draftMax, 0, MAX_RANK, true);
    if ((min ?? 0) > (max ?? MAX_RANK)) { this.invalidFields.add("min"); this.invalidFields.add("max"); }
    const characterRadius = read("characterRadius", this.characterRadius, 0, 50)!;
    const instrumentRadius = read("instrumentRadius", this.instrumentRadius, 0, 1000)!;
    read("defaultCharacter", this.defaultCharacter, 10, 1000);
    read("defaultInstrument", this.defaultInstrument, 40, 1000);
    const characterLevels = Object.fromEntries(this.related.flatMap((group) => group.characters.map((id) =>
      [id, read(`character-${id}`, this.characterLevels.get(id) ?? this.defaultCharacter, 10, 1000)!])));
    const instrumentLevels = Object.fromEntries(this.related.map((group) =>
      [group.band!, read(`instrument-${group.band}`, this.instrumentLevels.get(group.band!) ?? this.defaultInstrument, 40, 1000)!]));
    this.rangeError = this.invalidFields.size > 0;
    if (this.rangeError) return;
    this.rankRange = min === undefined && max === undefined ? undefined : { min, max };
    this.preferences = { vipBonus: this.draftVip === "" ? undefined : Number(this.draftVip), characterLevels, instrumentLevels, characterRadius, instrumentRadius, allowGrowth: this.allowGrowth };
    this.dirty = false;
    this.calculate();
    if (matchMedia("(max-width: 599px)").matches)
      void this.updateComplete.then(() => this.querySelector(".ranking-team-analysis__output")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  private clearRange = () => {
    this.draftMin = this.draftMax = this.draftVip = "";
    this.defaultCharacter = "18"; this.defaultInstrument = "75";
    this.characterRadius = "3"; this.instrumentRadius = "10"; this.allowGrowth = false;
    this.characterLevels.clear(); this.instrumentLevels.clear();
    this.rangeError = false; this.invalidFields.clear();
    this.edit("min", "");
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
    if (challengeId === 0) return { title: this.text("totalRanking"), titleLanguage: this.locale, jacket: "" };
    const board = this.boards.find((entry) => entry.challengeId === challengeId);
    const source = board?.musicId ? this.data?.songs[board.musicId] : undefined;
    return { title: source ? songTitle(source, this.locale).text : `#${challengeId}`,
      titleLanguage: source ? songTitle(source, this.locale).locale : this.locale,
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
            <span lang=${this.song(board.challengeId).titleLanguage}>${this.song(board.challengeId).title}</span>
            <span class="md-label-medium">${this.text(board.status)}</span>
          </li>`)}
        </ul>
      </div>`;
  }
  private field(key: string, label: string, value: string, min: number, max: number) {
    return html`<md-outlined-text-field id=${`${this.coverageId}-${key}`} name=${key} inputmode="numeric"
      type="number" min=${String(min)} max=${String(max)} step="1" label=${label} title=${label} ?error=${this.invalidFields.has(key)}
      .value=${live(value)} @input=${(event: Event) => this.edit(key, (event.currentTarget as HTMLInputElement).value)}></md-outlined-text-field>`;
  }
  private renderControls() {
    const bonuses = [...new Set([0, ...(this.data?.runtimeRules?.tables.vipRankBonuses.rows ?? [])
      .filter((row) => row.vipBonusType === 7).map((row) => Number(row.value))])].sort((a, b) => a - b);
    return html`<form class="surface stack ranking-team-analysis__filter" novalidate @submit=${this.applyRange}>
      <h3 class="detail-section-title">${this.text("expectedGrowth")}</h3>
      <md-outlined-select label=${this.text("vipBonus")} .value=${this.draftVip}
        @change=${(event: Event) => this.edit("vip", (event.currentTarget as HTMLInputElement).value)}>
        <md-select-option value="" ?selected=${this.draftVip === ""}><div slot="headline">${this.text("allBonuses")}</div></md-select-option>
        ${bonuses.map((bonus) => html`<md-select-option value=${String(bonus)} ?selected=${this.draftVip === String(bonus)}>
          <div slot="headline">${this.percent.format(bonus / 10000)}</div></md-select-option>`)}
      </md-outlined-select>
      <div class="ranking-team-analysis__fields">
        ${this.field("defaultCharacter", this.text("characterLevel"), this.defaultCharacter, 10, 1000)}
        ${this.field("defaultInstrument", this.text("instrumentTotal"), this.defaultInstrument, 40, 1000)}
      </div>
      <div class="ranking-team-analysis__related stack">
        ${this.related.map((group) => html`<section class="stack">
          <h4 class="detail-section-title">${this.band(group.band!)}</h4>
          ${this.field(`instrument-${group.band}`, this.text("instrumentTotal"), this.instrumentLevels.get(group.band!) ?? this.defaultInstrument, 40, 1000)}
          <div class="ranking-team-analysis__fields">
            ${group.characters.map((id) => this.field(`character-${id}`, this.character(id).name,
              this.characterLevels.get(id) ?? this.defaultCharacter, 10, 1000))}
          </div>
        </section>`)}
      </div>
      ${accordion({
        id: `${this.coverageId}-range`, label: this.text("searchRange"), expanded: this.rangeExpanded,
        onExpandedChange: (expanded) => { this.rangeExpanded = expanded; this.requestUpdate(); },
        content: html`<div class="stack">
          <div class="ranking-team-analysis__fields">
            ${this.field("characterRadius", this.text("characterRadius"), this.characterRadius, 0, 50)}
            ${this.field("instrumentRadius", this.text("instrumentRadius"), this.instrumentRadius, 0, 1000)}
          </div>
          <label class="row row--between">
            <span>${this.text("allowGrowth")}</span>
            <md-switch aria-label=${this.text("allowGrowth")} .selected=${this.allowGrowth}
              @change=${(event: Event) => this.edit("allowGrowth", String((event.currentTarget as HTMLElement & { selected: boolean }).selected))}></md-switch>
          </label>
          <span class="md-label-large">${this.text("rankSum")}</span>
          <div class="ranking-team-analysis__fields">
            ${this.field("min", this.text("rankMin"), this.draftMin, 0, MAX_RANK)}
            ${this.field("max", this.text("rankMax"), this.draftMax, 0, MAX_RANK)}
          </div>
        </div>`,
      })}
      <div class="ranking-team-analysis__validation" role="status">
        ${this.rangeError ? html`<span>${this.text("rangeInvalid")}</span>
          ${[...this.invalidFields].map((key) => html`<a href=${`#${this.coverageId}-${key}`} @click=${(event: Event) => {
            event.preventDefault(); const field = this.querySelector<HTMLElement>(`#${this.coverageId}-${key}`);
            if (key === "min" || key === "max" || key.endsWith("Radius")) this.rangeExpanded = true;
            this.requestUpdate(); void this.updateComplete.then(() => field?.focus());
          }}>${key.startsWith("character-") ? this.character(Number(key.slice(10))).name
            : key.startsWith("instrument-") ? this.band(Number(key.slice(11)))
            : this.text(({ min: "rankMin", max: "rankMax", defaultCharacter: "characterLevel", defaultInstrument: "instrumentTotal" } as Record<string, string>)[key] ?? key)}</a>`)}
        ` : nothing}
      </div>
      <button class="button button--full" type="submit" ?disabled=${!this.ready}>${this.text("search")}</button>
      <button class="button button--text" type="button" @click=${this.clearRange}>${this.text("resetGrowth")}</button>
    </form>`;
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
          const { title, titleLanguage, jacket } = this.song(witness.challengeId);
          return html`<tr class="ranking-team-analysis__detail" ?hidden=${!open}>
            <th scope="row" class="is-sticky ranking-team-analysis__key" title=${title} lang=${titleLanguage}>
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
          <div class="dialog__body ranking-team-analysis__workspace">
            ${this.renderControls()}
            <div class="ranking-team-analysis__output stack">
              <div class="row ranking-team-analysis__controls">${this.renderCoverage()}</div>
              <div class="ranking-team-analysis__result" aria-busy=${this.paging ? "true" : "false"}>
                ${this.error ? this.failure(this.error)
                  : !this.ready ? loadingState(this.text("reading"))
                  : this.busy ? loadingState(this.text("loading"))
                  : this.result ? this.renderResult()
                  : html`<span class="md-label-large ranking-team-analysis__status">${this.text("waiting")}</span>`}
              </div>
            </div>
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
