// L3 — GEB
// Input: Selected event and region, catalogue snapshots and the current time.
// Output: Event navigation and the selected leaderboard, timeline, statistics or pace planner.
// Pos: [Map](L2-2.md); activity tracking workspace.
// Effects/Dependencies: Polls saved tracking metadata and refreshes the active leaderboard only.
import { scrollableTabBar } from "./ui/scrollable-tabs";
import { LitElement, html, nothing } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type { ChildPart } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { clientText } from "../i18n/client";
import { setAppBarActions } from "../lib/app-bar";
import { RequestScope } from "../lib/request-scope";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { TrackerPageData, TrackerRailEvent } from "../lib/event-tracker-page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { resourcePath } from "../lib/resource-route";
import { eventChallengeHref } from "../lib/event-challenge-route";
import { resolveLocalizedText, resolveRelationshipText } from "../lib/localized-text";
import { createPerformerRegistry, resolveSongPerformer, type PerformerRegistry } from "../lib/song-performer";
import { loadPlaylistCatalogSource } from "../lib/playlist-tracks";
import { songPerformerAdornment } from "./shared/song-performer-adornment";
import type { Locale } from "../i18n/locales";
import { isPublicReleaseServer, type ReleaseServer } from "../lib/release-server";
import type { EventTrackerDto, EventChallengeDto, GameRecordsRegion, RankingCardCatalog, TrackedEventDto } from "../lib/game-records";
import { formatDateRange } from "../lib/date-format";
import {
  catalogUrl,
  fetchJson,
  formatList,
  gameDateTimeRange,
  preferredLocale,
  type JsonRecord,
} from "./shared/catalog";
import {
  GAME_RECORDS_REGIONS,
  defaultGameRecordsRegion,
  gameRecordsRegionPicker,
} from "./shared/game-records";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { iconButton, rovingKeydown } from "./ui/controls";
import { tile } from "./ui/tile";
import { browseRail, browseResultsId, type BrowseRailItem } from "./ui/browse";
import { liveMusicTypeMark, songTile } from "./shared/song-tile";
import { LazyImages, localeTaggedCandidates, localizedAssetUrl, nextImageCandidate } from "./ui/lazy-images";
import { emptyState, errorState, loadingState } from "./ui/state";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import "./arena-ranking";
import type { SongRanking } from "./song-ranking";
import "./event-pace-planner";
import type { EventPacePlanner } from "./event-pace-planner";
import type { EventRankHistory, HistoryBoard } from "./event-rank-history";
import type { EventRankingStatistics } from "./event-ranking-statistics";
import "../styles/settings.css";
import "../styles/song-ranking.css";
import { snackbar } from "../lib/snackbar";

type Region = GameRecordsRegion;
type RankingView = "total" | "challenge" | "points" | "history" | "stats" | "pace";
let trackerSequence = 0;

class CountdownText extends AsyncDirective {
  render(value: string, _attach: (update: (text: string) => void) => void) {
    return value;
  }

  update(_part: ChildPart, [value, attach]: Parameters<CountdownText["render"]>) {
    attach(this.setText);
    return value;
  }

  private readonly setText = (value: string) => {
    if (this.isConnected) this.setValue(value);
  };
}

const countdownText = directive(CountdownText);

export class EventTracker extends LitElement {
  static properties = {
    locale: { type: String },
    server: { type: String },
    region: { state: true },
    phase: { state: true },
    data: { state: true },
    info: { state: true },
    songs: { state: true },
    challengeId: { state: true },
    eventId: { state: true },
    archive: { state: true },
    rankingView: { state: true },
    historyPrepared: { state: true },
    statsPrepared: { state: true },
    catalogLoading: { state: true },
    refreshing: { state: true },
  };
  declare locale: string;
  declare server: ReleaseServer;
  declare region: Region;
  declare phase: "loading" | "ready" | "error";
  declare data: EventTrackerDto | null;
  declare info: JsonRecord | null;
  declare songs: Record<string, JsonRecord>;
  declare challengeId: string;
  /** The event the rail has selected; empty for the current one. */
  declare eventId: string;
  declare archive: TrackedEventDto[];
  declare rankingView: RankingView | "";
  declare private historyPrepared: boolean;
  declare private statsPrepared: boolean;
  declare private catalogLoading: boolean;
  private historyDefault = "";
  private now = Date.now();
  declare refreshing: boolean;
  private requests = new RequestScope();
  private catalogRequests = new RequestScope();
  private infoFor = "";
  private paceSeed?: { region: Region; eventId: string; perPlay: string };
  private railEvents: Partial<Record<"jp" | "intl", TrackerRailEvent[]>> = {};
  private songTitles: NonNullable<TrackerPageData["songTitles"]> = {};
  private lazyImages = new LazyImages({ candidates: (source) => localeTaggedCandidates(source, this.locale) });
  private lifetime?: AbortController;
  private clock = 0;
  private nextBoundary = Infinity;
  private updateCountdown?: (text: string) => void;
  private readonly attachCountdown = (update: (text: string) => void) => { this.updateCountdown = update; };
  private poll = 0;
  private infoServer: ReleaseServer = "intl";
  private cards: Partial<Record<"jp" | "intl", RankingCardCatalog>> = {};
  private musicTypeMarks: Partial<Record<"jp" | "intl", Map<string, string>>> = {};
  private readonly songPerformers = new Map<string, PerformerRegistry>();
  private readonly owner = `event-tracker-${++trackerSequence}`;
  private pageAdopted = false;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.region = "tw";
    this.phase = "loading";
    this.data = null;
    this.info = null;
    this.songs = {};
    this.challengeId = "";
    this.eventId = "";
    this.archive = [];
    this.rankingView = "";
    this.historyPrepared = false;
    this.statsPrepared = false;
    this.catalogLoading = false;
    this.refreshing = false;
  }
  createRenderRoot() {
    return this;
  }
  preparePage(page: TrackerPageData, locale: string, server: ReleaseServer, region = defaultGameRecordsRegion(server, locale)) {
    adoptPrerenderedWorkspace(this);
    this.locale = locale;
    this.server = server;
    this.region = region;
    this.applyPageCatalogs(page);
    const snapshot = page.snapshots?.[region];
    if (!snapshot) return;
    if (snapshot.data) this.data = snapshot.data;
    this.phase = snapshot.phase;
    this.archive = snapshot.archive ?? [];
    this.info = snapshot.info;
    this.songs = snapshot.songs;
    this.infoServer = snapshot.infoServer;
    this.infoFor = snapshot.info && snapshot.data?.event?.challenges.every((row) => snapshot.songs[row.musicId])
      ? snapshot.data.event.id : "";
    this.syncChallenge();
  }
  private applyPageCatalogs(pageData: TrackerPageData) {
    this.cards = { intl: pageData.intl, jp: pageData.jp };
    this.railEvents = pageData.events ?? {};
    this.songTitles = pageData.songTitles ?? {};
    this.musicTypeMarks = Object.fromEntries(Object.entries(pageData.musicTypeMarks || {}).map(([source, marks]) => [source, new Map(Object.entries(marks))]));
    for (const [server, source] of Object.entries(pageData.songPerformers ?? {}))
      this.songPerformers.set(server, createPerformerRegistry({ game: "our-notes", server, ...source }));
  }
  adoptPageData(): boolean {
    const page = readPageData<TrackerPageData>(this);
    if (!page) return false;
    this.applyPageCatalogs(page);
    this.requestUpdate();
    return true;
  }
  private shownId() {
    return this.eventId || this.data?.event?.id || "";
  }
  private shownEvent(): TrackedEventDto | null {
    const current = this.data?.event ?? null;
    if (!this.eventId || this.eventId === current?.id) return current;
    return this.archive.find((event) => event.id === this.eventId) ?? null;
  }
  private syncChallenge() {
    const challenges = this.shownEvent()?.challenges || [];
    if (!challenges.some((challenge) => challenge.id === this.challengeId)) this.challengeId = challenges.find((challenge) => challenge.enabled)?.id || challenges[0]?.id || "";
  }
  /** Names and songs of the shown event, once per event. */
  private async loadShownCatalog() {
    const id = this.shownId();
    if (!id || this.infoFor === id) return;
    this.infoFor = id;
    this.info = null;
    this.songs = {};
    this.catalogLoading = true;
    const signal = this.catalogRequests.begin();
    try {
      await this.loadCatalog(id, this.shownEvent()?.challenges ?? [], signal);
    } finally {
      if (this.catalogRequests.current(signal)) {
        this.catalogLoading = false;
        if (!this.info) this.infoFor = "";
      }
    }
  }
  renderStaticChrome() { this.syncAppBar(); }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.lifetime = new AbortController();
    const pageData = readPageData<TrackerPageData>(this) || {};
    this.applyPageCatalogs(pageData);
    this.locale = preferredLocale(this.locale);
    const params = navigationDocumentUrl().searchParams;
    const requested = params.get("region");
    this.region = GAME_RECORDS_REGIONS.some((option) => option.value === requested)
      ? (requested as Region)
      : defaultGameRecordsRegion(this.server, this.locale);
    this.challengeId = params.get("challenge") || "";
    this.eventId = params.get("event") || "";
    const yieldPerPlay = params.get("perPlay") ?? "";
    this.paceSeed = /^[1-9][0-9]{0,18}$/u.test(yieldPerPlay) && this.eventId
      ? { region: this.region, eventId: this.eventId, perPlay: yieldPerPlay }
      : undefined;
    const board = params.get("board");
    this.rankingView = board === "total" || board === "challenge" || board === "points" || board === "history" || board === "stats" || board === "pace"
      ? board : this.challengeId ? "challenge" : "";
    if (this.rankingView === "history") void this.prepareHistory();
    if (this.rankingView === "stats") void this.prepareStatistics();
    addEventListener(
      "haneoka:locale-ready",
      () => {
        this.locale = preferredLocale(this.locale);
      },
      { signal: this.lifetime.signal },
    );
    this.now = Date.now();
    this.clock = window.setInterval(this.tickClock, 1000);
    document.addEventListener("visibilitychange", this.tickClock, { signal: this.lifetime.signal });
    addEventListener("online", () => { if (document.visibilityState === "visible") void this.refresh(); }, { signal: this.lifetime.signal });
    void this.load();
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    this.requests.cancel();
    this.catalogRequests.cancel();
    this.lazyImages.disconnect();
    this.lifetime?.abort();
    window.clearInterval(this.clock);
    this.updateCountdown = undefined;
    window.clearTimeout(this.poll);
    super.disconnectedCallback();
  }
  private label(key: string, fallback: string) {
    return clientText(this.locale, `tools.eventTracker.${key}`, fallback);
  }
  private sourceServer(): "jp" | "intl" {
    return this.region === "jp" ? "jp" : "intl";
  }
  private schedulePoll() {
    window.clearTimeout(this.poll);
    if (!this.isConnected) return;
    this.poll = window.setTimeout(() => {
      if (document.visibilityState === "visible") void this.refresh();
      else this.schedulePoll();
    }, this.data?.provider === "official" ? 30_000 : 60_000);
  }
  private async load() {
    const page = readPageData<TrackerPageData>(this);
    if (!this.pageAdopted && page?.snapshots?.[this.region]) {
      this.pageAdopted = true;
      this.preparePage(page, this.locale, this.server, this.region);
    }
    const region = this.region;
    const signal = this.requests.begin();
    this.refreshing = true;
    if (!this.data) this.phase = "loading";
    try {
      const [data, archive] = await Promise.all([
        fetchJson<EventTrackerDto>(`/api/v1/game/records/${region}/events/current`, { signal, cache: "no-store" }),
        fetchJson<{ events: TrackedEventDto[] }>(`/api/v1/game/records/${region}/events/archive`, { signal }).catch(() => null),
      ]);
      if (!this.isConnected || this.region !== region || !this.requests.current(signal)) return;
      this.data = data;
      this.phase = "ready";
      if (archive) this.archive = archive.events;
      this.syncChallenge();
      void this.loadShownCatalog();
    } catch {
      if (!this.isConnected || this.region !== region || !this.requests.current(signal)) return;
      if (!this.data) this.phase = "error";
    } finally {
      if (this.requests.current(signal)) {
        this.refreshing = false;
        this.schedulePoll();
      }
    }
  }
  private async loadCatalog(id: string, challenges: EventChallengeDto[], signal: AbortSignal) {
    const preferred = this.sourceServer();
    const candidates: ReleaseServer[] = preferred === "jp" ? ["jp", "jp-cbt", "intl"] : ["intl", "jp", "jp-cbt"];
    let info: JsonRecord | null = null;
    const songs: Record<string, JsonRecord> = {};
    for (const server of candidates) {
      if (!this.catalogRequests.current(signal)) return;
      const songUrl = new URL(catalogUrl("songs", "", server), location.origin);
      for (const challenge of challenges)
        if (!songs[challenge.musicId]) songUrl.searchParams.append("id", challenge.musicId);
      const [eventResult, songResult]: [
        PromiseSettledResult<JsonRecord | null>,
        PromiseSettledResult<{ items: Record<string, JsonRecord> } | null>,
      ] = await Promise.allSettled([
        info ? Promise.resolve(null) : fetchJson<JsonRecord>(catalogUrl("events", id, server), { signal }),
        songUrl.searchParams.has("id")
          ? fetchJson<{ items: Record<string, JsonRecord> }>(songUrl.pathname + songUrl.search, { signal })
          : Promise.resolve(null),
      ]);
      if (!this.catalogRequests.current(signal)) return;
      if (!info && eventResult.status === "fulfilled" && eventResult.value) {
        info = eventResult.value;
        this.infoServer = server;
      }
      if (songResult.status === "fulfilled" && songResult.value)
        for (const [id, song] of Object.entries(songResult.value.items)) songs[id] = { ...song, catalogSourceServer: server };
      if (!this.songPerformers.has(server) && songResult.status === "fulfilled" && songResult.value) {
        try {
          const source = await loadPlaylistCatalogSource("our-notes", server);
          if (!this.catalogRequests.current(signal)) return;
          this.songPerformers.set(server, source.registry);
        } catch { /* Keep the available ranking and authored song credits. */ }
      }
      if (info && challenges.every((challenge) => songs[challenge.musicId])) break;
    }
    if (this.catalogRequests.current(signal)) {
      this.info = info;
      this.songs = songs;
    }
  }
  private selectRegion(region: Region) {
    if (region === this.region) return;
    this.requests.cancel();
    this.catalogRequests.cancel();
    this.region = region;
    this.data = null;
    this.archive = [];
    this.info = null;
    this.songs = {};
    this.infoFor = "";
    this.catalogLoading = false;
    this.challengeId = "";
    this.syncUrl();
    void this.load();
  }
  private selectChallenge(id: string) {
    this.challengeId = id;
    this.syncUrl();
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>('.collection[role="tablist"] [role="tab"][aria-selected="true"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      }),
    );
  }
  private selectEvent(id: string) {
    this.eventId = id === this.data?.event?.id ? "" : id;
    this.syncChallenge();
    this.syncUrl();
    void this.loadShownCatalog();
  }
  private railItems(): BrowseRailItem[] {
    const listed = this.railEvents[this.sourceServer()] ?? [];
    const listedById = new Map(listed.map((entry) => [entry.id, entry]));
    const tracked = new Map([...this.archive, ...(this.data?.event ? [this.data.event] : [])].map((event) => [event.id, event]));
    const ids = new Set([...listed.filter((entry) => entry.startAtMs && entry.startAtMs <= this.now).map((entry) => entry.id), ...tracked.keys()]);
    return [...ids]
      .map((id) => {
        const entry = listedById.get(id);
        const event = tracked.get(id);
        const start = event?.startAtMs || entry?.startAtMs || 0;
        const end = event?.endAtMs || entry?.endAtMs || 0;
        const title = resolveLocalizedText(entry?.title, this.locale);
        return {
          start,
          item: {
            value: id,
            label: title.text || this.label("eventName", "Event #{id}").replace("{id}", id),
            language: title.locale,
            image: entry?.image || "",
            meta: start && end ? formatDateRange(this.locale, start, end) : "",
          },
        };
      })
      .sort((a, b) => b.start - a.start || Number(b.item.value) - Number(a.item.value))
      .map(({ item }) => item);
  }
  private selectRanking(view: RankingView) {
    this.rankingView = view;
    if (view === "history") void this.prepareHistory();
    if (view === "stats") void this.prepareStatistics();
    this.syncUrl();
  }
  private async prepareHistory() {
    await import("./event-rank-history");
    this.historyPrepared = true;
  }
  private async prepareStatistics() {
    await import("./event-ranking-statistics");
    this.statsPrepared = true;
  }
  private async showStatisticsHistory(board: string) {
    this.historyDefault = board;
    this.rankingView = "history";
    this.syncUrl();
    await this.prepareHistory();
    await this.updateComplete;
    this.querySelector<EventRankHistory>("event-rank-history")?.showBoard(board);
    this.querySelector<HTMLButtonElement>("#event-board-history")?.focus();
  }
  private historyBoards(event: TrackedEventDto): HistoryBoard[] {
    const route = (entry: TrackedEventDto, board: string) => `/api/v2/game/records/${this.region}/events/${entry.id}/${board}/timeline`;
    const otherEvents = this.archive.filter((entry) => entry.id !== event.id && entry.startAtMs != null);
    const make = (value: string, label: string, startAtMs: number, otherBoard: (entry: TrackedEventDto) => { value: string; startAtMs?: number | null } | null): HistoryBoard => ({
      value, label, startAtMs,
      comparisons: otherEvents.flatMap((entry) => {
        const target = otherBoard(entry);
        if (!target) return [];
        const known = this.railEvents[this.sourceServer()]?.find((item) => item.id === entry.id);
        return [{
          value: entry.id,
          label: resolveLocalizedText(known?.title, this.locale).text || this.label("eventName", "Event #{id}").replace("{id}", entry.id),
          endpoint: route(entry, target.value),
          startAtMs: target.startAtMs ?? entry.startAtMs!,
        }];
      }),
    });
    return [
      ...(event.totalRankingEnabled
        ? [make("total", this.label("totalRanking", "Total song ranking"), event.startAtMs ?? 0,
            (entry) => entry.totalRankingEnabled ? { value: "total" } : null)]
        : []),
      ...event.challenges.filter((row) => row.enabled).map((row) => make(
        `challenges/${row.id}`, this.challengeTitle(row), row.startAtMs ?? event.startAtMs ?? 0, (entry) => {
          const challenge = entry.challenges.find((target) => target.enabled && target.musicId === row.musicId);
          return challenge ? { value: `challenges/${challenge.id}`, startAtMs: challenge.startAtMs } : null;
        },
      )),
      ...(event.pointRankingEnabled
        ? [make("points", this.label("pointRanking", "Event point ranking"), event.startAtMs ?? 0,
            (entry) => entry.pointRankingEnabled ? { value: "points" } : null)]
        : []),
    ];
  }
  private syncUrl() {
    const url = new URL(location.href);
    url.searchParams.set("region", this.region);
    if (this.rankingView) url.searchParams.set("board", this.rankingView);
    else url.searchParams.delete("board");
    if (this.eventId) url.searchParams.set("event", this.eventId);
    else url.searchParams.delete("event");
    if (this.challengeId) url.searchParams.set("challenge", this.challengeId);
    else url.searchParams.delete("challenge");
    if (this.paceSeed?.eventId !== this.shownId() || this.paceSeed?.region !== this.region)
      url.searchParams.delete("perPlay");
    history.replaceState(history.state, "", url);
  }
  private async refresh(includeStatistics = false) {
    if (this.refreshing) return;
    const region = this.region;
    await this.load();
    await this.updateComplete;
    if (this.isConnected && this.region === region) {
      const boards = this.querySelectorAll<SongRanking>("song-ranking, arena-ranking");
      for (const board of boards) if (board.active) board.refreshRanking();
      if (includeStatistics && this.rankingView === "stats")
        void this.querySelector<EventRankingStatistics>("event-ranking-statistics")?.refresh();
    }
  }
  private eventTitle() {
    return (
      resolveLocalizedText(this.info?.title, this.locale).text ||
      this.label("eventName", "Event #{id}").replace("{id}", this.shownId())
    );
  }
  private challengeSongName(challenge: EventChallengeDto): string {
    const song = this.songs[challenge.musicId];
    const source = this.sourceServer();
    const title = song?.musicTitle || song?.title || song?.name
      || this.songTitles[source]?.[challenge.musicId]
      || this.songTitles[source === "jp" ? "intl" : "jp"]?.[challenge.musicId];
    return title ? songTitle({ musicTitle: title }, this.locale).text : "";
  }
  private challengeTitle(challenge: EventChallengeDto) {
    return this.challengeSongName(challenge) || this.label("songName", "Song #{id}").replace("{id}", challenge.musicId);
  }
  private countdown() {
    const event = this.shownEvent();
    if (!event) return "";
    const starting = Boolean(event.startAtMs && event.startAtMs > this.now);
    const deadline = starting ? event.startAtMs : event.endAtMs;
    if (!deadline) return this.label("unknownDeadline", "End time unavailable");
    if (deadline <= this.now) return this.label("ended", "Ended");
    const seconds = Math.max(0, Math.floor((deadline - this.now) / 1000));
    const days = Math.floor(seconds / 86400);
    const pad = (value: number) => String(value).padStart(2, "0");
    const time = `${pad(Math.floor((seconds % 86400) / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
    const duration = days
      ? this.label("duration", "{days}d {time}")
          .replace("{days}", days.toLocaleString(this.locale))
          .replace("{time}", time)
      : time;
    return this.label(starting ? "startsIn" : "endsIn", starting ? "Starts in {time}" : "Ends in {time}").replace(
      "{time}",
      duration,
    );
  }
  private readonly tickClock = () => {
    if (document.visibilityState !== "visible") return;
    this.now = Date.now();
    if (this.now >= this.nextBoundary) this.requestUpdate();
    this.updateCountdown?.(this.countdown());
  };

  private cachedShown = false;
  updated() {
    const event = this.shownEvent();
    if (!event || !this.data) this.updateCountdown = undefined;
    this.nextBoundary = Infinity;
    for (const at of [
      event?.startAtMs, event?.endAtMs,
      ...(this.railEvents[this.sourceServer()] ?? []).map((entry) => entry.startAtMs),
    ]) {
      if (at && at > this.now && at < this.nextBoundary) this.nextBoundary = at;
    }
    if ((this.phase === "error") !== this.cachedShown) {
      this.cachedShown = this.phase === "error";
      if (this.cachedShown) snackbar(this.label("cached", "Showing the last available event information."));
    }
    this.lazyImages.observe(this);
    this.syncAppBar();
    if (this.eventId && !this.railShown) {
      const tab = this.querySelector<HTMLElement>('.browse__rail [role="tab"][aria-selected="true"]');
      if (tab) {
        this.railShown = true;
        const reveal = () => tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (document.readyState === "complete") requestAnimationFrame(reveal);
        else addEventListener("load", reveal, { once: true });
      }
    }
  }
  /** A linked event's rail tile is scrolled into view once. */
  private railShown = false;
  private syncAppBar() {
    setAppBarActions(
      this,
      this.owner,
      html`
        ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.selectRegion(region), "event-tracker-region")}
        ${iconButton({ label: this.label("refresh", "Refresh event rankings"), icon: "refresh", disabled: this.refreshing, onClick: () => void this.refresh(true) })}
      `,
    );
  }
  render() {
    const items = this.railItems();
    return html`
      <section class="browse browse--railed">
        ${browseRail({
          locale: this.locale,
          label: clientText(this.locale, "navigation.events", "Events"),
          value: this.shownId(),
          items,
          pending: !this.data && !items.length,
          single: true,
          onSelect: (id) => this.selectEvent(id),
        })}
        <div class="browse__main" id=${browseResultsId} role="tabpanel">${this.renderEvent()}</div>
      </section>
    `;
  }
  private renderEvent() {
    const event = this.shownEvent();
    if (!event && this.eventId)
      return emptyState({ title: this.label("noRecords", "No ranking was recorded for this event."), icon: "leaderboard" });
    if (!this.data)
      return this.phase === "error"
        ? errorState(
            this.label("error", "Event information is unavailable."),
            this.label("retry", "Retry"),
            () => void this.load(),
          )
        : loadingState(this.label("loading", "Loading event"));
    if (!event)
      return emptyState({ title: this.label("empty", "No event is currently being tracked."), icon: "event" });
    const challenge = event.challenges.find((row) => row.id === this.challengeId);
    const readable = challenge?.enabled && ["collecting", "finalizing", "archived"].includes(challenge.status);
    const pointsReadable =
      event.pointRankingEnabled && !["pending", "missed", "disabled", "unknown"].includes(event.pointRankingStatus);
    const totalReadable = event.totalRankingEnabled &&
      ["collecting", "finalizing", "archived"].includes(event.totalRankingStatus || "");
    const { startAtMs, endAtMs } = event;
    const canPlanPace = startAtMs !== null && endAtMs !== null && endAtMs > startAtMs;
    const hasHistory = event.totalRankingEnabled || event.pointRankingEnabled || event.challenges.some((row) => row.enabled);
    const boards: RankingView[] = [
      ...(event.totalRankingEnabled ? ["total" as const] : []),
      ...(event.challenges.length ? ["challenge" as const] : []),
      ...(event.pointRankingEnabled ? ["points" as const] : []),
      ...(hasHistory ? ["history" as const] : []),
      ...(hasHistory ? ["stats" as const] : []),
      ...(canPlanPace ? ["pace" as const] : []),
    ];
    if (!boards.length || boards[0] === "pace") boards.unshift("challenge");
    const activeBoard = this.rankingView && boards.includes(this.rankingView) ? this.rankingView : boards[0];
    const statsSongs = activeBoard === "stats" ? event.challenges.filter((row) => row.enabled)
      .map(row => ({ value: `challenges/${row.id}`, label: this.challengeSongName(row) })) : [];
    const statsNamesPending = this.catalogLoading && statsSongs.some(({ label }) => !label);
    const boardLabels: Record<RankingView, string> = {
      total: this.label("totalTab", "Total"),
      challenge: this.label("challengeTab", "Songs"),
      points: this.label("pointTab", "Points"),
      history: this.label("history.tab", "Rank history"),
      stats: this.label("stats.tab", "Statistics"),
      pace: this.label("pace.tab", "Pace planner"),
    };
    const marks = this.musicTypeMarks[this.sourceServer()] || new Map<string, string>();
    // A CBT edition has no public event page; its art stays a picture here.
    const eventHref = isPublicReleaseServer(this.infoServer)
      ? resourcePath({ server: this.infoServer, locale: this.locale as Locale, kind: "events", id: event.id })
      : "";
    const eventArt =
      this.info?.image || this.info?.logo
        ? html`
            <img
              class="browse__heading-art"
              src=${localizedAssetUrl(String(this.info.logo || this.info.image), this.locale)}
              alt=""
              width="460"
              height="240"
              decoding="async"
              @error=${nextImageCandidate}
            />
          `
        : nothing;
    return html`
      <div class="song-ranking-page song-ranking__content">
        <header class="browse__heading tracker-heading">
            ${
              eventHref
                ? html`
                    <a
                      class="browse__heading-art-link"
                      href=${eventHref}
                      aria-label=${`${this.label("event", "Event")} / ${this.eventTitle()}`}
                    >
                      ${eventArt}
                    </a>
                  `
                : html`<span class="browse__heading-art-link">${eventArt}</span>`
            }
            <div class="browse__heading-copy">
              <h2 lang=${resolveLocalizedText(this.info?.title, this.locale).locale}>${this.eventTitle()}</h2>
              <div class="tracker-times tabular">
                <span>${gameDateTimeRange(this.locale, event.startAtMs || 0, event.endAtMs || 0)}</span>
                <span role="timer" aria-live="off">${countdownText(this.countdown(), this.attachCountdown)}</span>
              </div>
            </div>
        </header>
        ${scrollableTabBar(this.locale, html`
          <nav class="tabs tabs--secondary" role="tablist" aria-label=${this.label("title", "Event tracker")}
            @keydown=${rovingKeydown(boards, activeBoard, (view) => this.selectRanking(view))}>
            ${boards.map((view) => html`
              <button class="tab" type="button" role="tab" id=${`event-board-${view}`}
                aria-controls=${`event-ranking-${view}`} aria-selected=${String(activeBoard === view)}
                tabindex=${activeBoard === view ? 0 : -1} @click=${() => this.selectRanking(view)}>
                <span>${boardLabels[view]}</span><span class="tab__indicator"></span>
              </button>
            `)}
          </nav>
        `)}
        <section class="detail-section" role="tabpanel" id="event-ranking-challenge"
          aria-labelledby="event-board-challenge" ?hidden=${activeBoard !== "challenge"}>
          ${renderDetailSectionHeading(this.label("challengeRanking", "Challenge song ranking"), "works")}
          ${
            event.challenges.length
              ? html`
                  ${scrollableTabBar(this.locale, html`<nav
                    class="collection collection--song collection--tab-rail"
                    role="tablist"
                    aria-label=${this.label("song", "Challenge song")}
                    aria-orientation="horizontal"
                    @keydown=${rovingKeydown(
                      event.challenges.map((row) => row.id),
                      this.challengeId,
                      (id) => this.selectChallenge(id),
                    )}
                  >
                    ${event.challenges.map((row) => {
                      const song = this.songs[row.musicId] || {
                        musicId: row.musicId,
                        musicTitle: [this.challengeTitle(row)],
                      };
                      const registry = this.songPerformers.get(String(song.catalogSourceServer ?? this.infoServer));
                      const performer = registry ? resolveSongPerformer(song, registry) : undefined;
                      const categories = formatList(
                        (Array.isArray(song.musicCategories) ? song.musicCategories : [])
                          .map((id) => ["", "original", "virtual", "jpop", "anime", "game"][Number(id)])
                          .filter(Boolean)
                          .map((name) => clientText(this.locale, `catalog.songs.types.${name}`, name)),
                        this.locale,
                        "unit",
                      );
                      const options = songTile(
                        song,
                        {
                          locale: this.locale,
                          title: (entry) => songTitle(entry, this.locale),
                          image: (entry) => String(entry.jacketThumbUrl || entry.jacketUrl || entry.image || ""),
                          artist: (entry) => performer ? resolveRelationshipText(performer.names, this.locale).text : resolveLocalizedText(entry.artistName || entry.bandName || entry.secondary, this.locale).text,
                          bandIcon: (entry) => String((entry.bandDetails as JsonRecord | undefined)?.icon || ""),
                          performerAdornment: performer ? () => songPerformerAdornment(performer, (source) => localizedAssetUrl(source, this.locale)) : undefined,
                          imageForLocale: (source) => localizedAssetUrl(source, this.locale),
                          attributeMark: (entry) => liveMusicTypeMark(marks, entry.musicType),
                          attributeLabel: (entry) => {
                            const name =
                              ["", "red", "blue", "green", "yellow", "purple"][Number(entry.musicType)] || "";
                            return name ? clientText(this.locale, `catalog.songs.liveTypes.${name}`, name) : "";
                          },
                        },
                        "",
                        [categories ? { at: "bottom-start", text: categories } : null],
                      );
                      return tile({
                        ...options,
                        id: `event-challenge-${row.id}`,
                        role: "tab",
                        selected: row.id === this.challengeId,
                        controls: "event-challenge-ranking",
                        tabIndex: row.id === this.challengeId ? 0 : -1,
                        onOpen: () => this.selectChallenge(row.id),
                      });
                    })}
                  </nav>`)}
                  <div
                    id="event-challenge-ranking"
                    role="tabpanel"
                    aria-labelledby=${`event-challenge-${this.challengeId}`}
                  >
                    ${challenge ? html`<a class="button button--tonal" href=${eventChallengeHref(this.locale, this.sourceServer(), event.id, challenge, this.region)}>
                      ${clientText(this.locale, "tools.teamBuilder.challenge.title", "Challenge song ranking")}
                    </a>` : nothing}
                    ${
                      readable
                        ? html`
                            <song-ranking
                              .active=${activeBoard === "challenge"}
                              embedded
                              .locale=${this.locale}
                              .server=${this.sourceServer()}
                              .region=${this.region}
                              .rankingTitle=${this.label("challengeRanking", "Challenge song ranking")}
                              .rankingEndpoint=${`/api/v1/game/records/${this.region}/events/${event.id}/challenges/${challenge!.id}/ranking`}
                              .cardCatalogData=${this.cards}
                              .analysisEvent=${event}
                              .analysisChallengeId=${challenge!.id}
                            ></song-ranking>
                          `
                        : challenge?.status === "missed"
                          ? emptyState({ title: this.label("noRecords", "No ranking was recorded for this event."), icon: "leaderboard" })
                          : emptyState({
                            title: this.label("pending", "Ranking data is being collected."),
                            icon: "hourglass_top",
                          })
                    }
                  </div>
                `
              : emptyState({
                  title: this.label("noChallenges", "This event has no challenge song ranking."),
                  icon: "music_off",
                })
          }
        </section>
        ${event.totalRankingEnabled ? html`
          <section class="detail-section" role="tabpanel" id="event-ranking-total"
            aria-labelledby="event-board-total" ?hidden=${activeBoard !== "total"}>
            ${renderDetailSectionHeading(this.label("totalRanking", "Total song ranking"), "works")}
            <a class="button button--tonal" href=${eventChallengeHref(this.locale, this.sourceServer(), event.id, undefined, this.region, true)}>
              ${clientText(this.locale, "tools.teamBuilder.challenge.all", "All challenge songs")}
            </a>
            ${totalReadable ? html`
              <song-ranking
                .active=${activeBoard === "total"}
                embedded
                .locale=${this.locale}
                .server=${this.sourceServer()}
                .region=${this.region}
                .rankingTitle=${this.label("totalRanking", "Total song ranking")}
                .rankingEndpoint=${`/api/v1/game/records/${this.region}/events/${event.id}/total/latest`}
                .cardCatalogData=${this.cards}
                .analysisEvent=${event}
                .analysisChallengeId=${""}
              ></song-ranking>
            ` : emptyState({
              title: event.totalRankingStatus === "missed"
                ? this.label("noRecords", "No ranking was recorded for this event.")
                : this.label("pending", "Ranking data is being collected."),
              icon: event.totalRankingStatus === "missed" ? "leaderboard" : "hourglass_top",
            })}
          </section>
        ` : nothing}
        ${event.pointRankingEnabled ? html`<section class="detail-section" role="tabpanel" id="event-ranking-points"
          aria-labelledby="event-board-points" ?hidden=${activeBoard !== "points"}>
          ${renderDetailSectionHeading(this.label("pointRanking", "Event point ranking"), "works")}
          ${
            pointsReadable
              ? html`
                  <arena-ranking
                    .active=${activeBoard === "points"}
                    .locale=${this.locale}
                    .region=${this.region}
                    .eventId=${Number(event.id)}
                    .analysisEvent=${event}
                    .catalogs=${this.cards}
                  ></arena-ranking>
                `
              : emptyState({
                  title: this.label(
                    event.pointRankingEnabled ? "pending" : "pointsDisabled",
                    event.pointRankingEnabled ? "Ranking data is being collected." : "This event has no point ranking.",
                  ),
                  icon: "leaderboard",
                })
          }
        </section>` : nothing}
        ${hasHistory && (activeBoard === "history" || this.historyPrepared) ? html`
          <section class="detail-section" role="tabpanel" id="event-ranking-history" aria-labelledby="event-board-history"
            ?hidden=${activeBoard !== "history"}>
            ${keyed(`${this.region}/${event.id}`, html`
              <event-rank-history
                .locale=${this.locale}
                .region=${this.region}
                .eventId=${event.id}
                .eventTitle=${this.eventTitle()}
                .endAtMs=${endAtMs}
                .initialBoard=${this.historyDefault}
                .boards=${this.historyBoards(event)}
                .planEnabled=${canPlanPace && this.now < endAtMs}
                .onPlan=${async (value: string) => {
                  this.selectRanking("pace");
                  await this.updateComplete;
                  await this.querySelector<EventPacePlanner>("event-pace-planner")?.useRankTarget(value);
                }}
              ></event-rank-history>
            `)}
          </section>
        ` : nothing}
        ${hasHistory && activeBoard === "stats" ? html`
          <section class="detail-section" role="tabpanel" id="event-ranking-stats" aria-labelledby="event-board-stats">
            ${this.statsPrepared && !statsNamesPending ? keyed(`${this.region}/${event.id}`, html`
              <event-ranking-statistics
                .locale=${this.locale}
                .region=${this.region}
                .eventId=${event.id}
                .cardCatalog=${this.cards[this.sourceServer()]}
                .endAtMs=${event.endAtMs}
                .boards=${[
                  ...statsSongs.map(({ value, label }, index) => ({
                    value, label: label || this.label("stats.unnamedSong", "Challenge song {index}").replace("{index}", String(index + 1)),
                  })),
                  ...(event.totalRankingEnabled ? [{ value: "total", label: this.label("totalRanking", "Total song ranking") }] : []),
                  ...(event.pointRankingEnabled ? [{ value: "points", label: this.label("pointRanking", "Event point ranking") }] : []),
                ]}
                .onHistory=${(board: string) => void this.showStatisticsHistory(board)}
              ></event-ranking-statistics>
            `) : loadingState(this.label("stats.loading", "Loading"), { local: true })}
          </section>
        ` : nothing}
        ${canPlanPace ? html`
          <section class="detail-section" role="tabpanel" id="event-ranking-pace"
            aria-labelledby="event-board-pace" ?hidden=${activeBoard !== "pace"}>
            ${keyed(`${this.region}/${event.id}`, html`
              <event-pace-planner
                .locale=${this.locale}
                .startAtMs=${startAtMs}
                .endAtMs=${endAtMs}
                .initialPerPlay=${this.paceSeed?.eventId === event.id && this.paceSeed.region === this.region ? this.paceSeed.perPlay : ""}
                .ended=${this.now >= endAtMs}
              ></event-pace-planner>
            `)}
          </section>
        ` : nothing}
      </div>
    `;
  }
}
if (!customElements.get("event-tracker")) customElements.define("event-tracker", EventTracker);
