import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { RequestScope } from "../lib/request-scope";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { TrackerPageData, TrackerRailEvent } from "../lib/event-tracker-page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { resourcePath } from "../lib/resource-route";
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
import { SongRanking } from "./song-ranking";
import { ArenaRanking } from "./arena-ranking";
import "../styles/settings.css";
import "../styles/song-ranking.css";
import { snackbar } from "../lib/snackbar";

type Region = GameRecordsRegion;
type RankingView = "total" | "challenge" | "points";
let trackerSequence = 0;

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
    now: { state: true },
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
  declare now: number;
  declare refreshing: boolean;
  private requests = new RequestScope();
  private catalogRequests = new RequestScope();
  private infoFor = "";
  private railEvents: Partial<Record<"jp" | "intl", TrackerRailEvent[]>> = {};
  private lazyImages = new LazyImages({ candidates: (source) => localeTaggedCandidates(source, this.locale) });
  private lifetime?: AbortController;
  private clock = 0;
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
    this.now = Date.now();
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
    this.infoFor = snapshot.info ? snapshot.data?.event?.id ?? "" : "";
    this.syncChallenge();
  }
  private applyPageCatalogs(pageData: TrackerPageData) {
    this.cards = { intl: pageData.intl, jp: pageData.jp };
    this.railEvents = pageData.events ?? {};
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
    const signal = this.catalogRequests.begin();
    await this.loadCatalog(id, this.shownEvent()?.challenges ?? [], signal);
    if (this.catalogRequests.current(signal) && !this.info) this.infoFor = "";
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
    const board = params.get("board");
    this.rankingView = board === "total" || board === "challenge" || board === "points"
      ? board : this.challengeId ? "challenge" : "";
    addEventListener(
      "haneoka:locale-ready",
      () => {
        this.locale = preferredLocale(this.locale);
      },
      { signal: this.lifetime.signal },
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") {
          this.now = Date.now();
          void this.refresh();
        }
      },
      { signal: this.lifetime.signal },
    );
    this.clock = window.setInterval(() => {
      if (document.visibilityState === "visible") this.now = Date.now();
    }, 1000);
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
    window.clearTimeout(this.poll);
    clearAppBarActions(this.owner);
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
    const tracked = new Map([...this.archive, ...(this.data?.event ? [this.data.event] : [])].map((event) => [event.id, event]));
    const ids = new Set([...listed.filter((entry) => entry.startAtMs && entry.startAtMs <= this.now).map((entry) => entry.id), ...tracked.keys()]);
    return [...ids]
      .map((id) => {
        const entry = listed.find((item) => item.id === id);
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
    this.syncUrl();
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
    history.replaceState(history.state, "", url);
  }
  private async refresh() {
    if (this.refreshing) return;
    const region = this.region;
    await this.load();
    await this.updateComplete;
    if (this.isConnected && this.region === region) {
      this.querySelectorAll<SongRanking>("song-ranking").forEach((ranking) => ranking.refreshRanking());
      this.querySelectorAll<ArenaRanking>("arena-ranking").forEach((ranking) => ranking.refresh());
    }
  }
  private eventTitle() {
    return (
      resolveLocalizedText(this.info?.title, this.locale).text ||
      this.label("eventName", "Event #{id}").replace("{id}", this.shownId())
    );
  }
  private challengeTitle(challenge: EventChallengeDto) {
    const song = this.songs[challenge.musicId];
    return song
      ? songTitle(song, this.locale).text
      : this.label("songName", "Song #{id}").replace("{id}", challenge.musicId);
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
  private cachedShown = false;
  updated() {
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
      this.owner,
      html`
        ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.selectRegion(region), "event-tracker-region")}
        ${iconButton({ label: this.label("refresh", "Refresh event rankings"), icon: "refresh", disabled: this.refreshing, onClick: () => void this.refresh() })}
      `,
      this,
    );
  }
  render() {
    const items = this.railItems();
    return html`
      <section class="browse browse--railed">
        ${browseRail({
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
    const boards: RankingView[] = [
      ...(event.totalRankingEnabled ? ["total" as const] : []),
      ...(event.challenges.length ? ["challenge" as const] : []),
      ...(event.pointRankingEnabled ? ["points" as const] : []),
    ];
    if (!boards.length) boards.push("challenge");
    const activeBoard = this.rankingView && boards.includes(this.rankingView) ? this.rankingView : boards[0];
    const boardLabels: Record<RankingView, string> = {
      total: this.label("totalTab", "Total"),
      challenge: this.label("challengeTab", "Songs"),
      points: this.label("pointTab", "Points"),
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
        <div class="row row--start">
          <header class="browse__heading grow">
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
              <p>
                ${this.label("event", "Event")} / #${event.id} /
                ${gameDateTimeRange(this.locale, event.startAtMs || 0, event.endAtMs || 0)}
              </p>
              <p class="tabular" role="timer" aria-live="off">${this.countdown()}</p>
            </div>
          </header>
        </div>
        <nav class="tabs" role="tablist" aria-label=${this.label("title", "Event tracker")}
          @keydown=${rovingKeydown(boards, activeBoard, (view) => this.selectRanking(view))}>
          ${boards.map((view) => html`
            <button class="tab" type="button" role="tab" id=${`event-board-${view}`}
              aria-controls=${`event-ranking-${view}`} aria-selected=${String(activeBoard === view)}
              tabindex=${activeBoard === view ? 0 : -1} @click=${() => this.selectRanking(view)}>
              <span>${boardLabels[view]}</span><span class="tab__indicator"></span>
            </button>
          `)}
        </nav>
        <section class="detail-section" role="tabpanel" id="event-ranking-challenge"
          aria-labelledby="event-board-challenge" ?hidden=${activeBoard !== "challenge"}>
          ${renderDetailSectionHeading(this.label("challengeRanking", "Challenge song ranking"), "works")}
          ${
            event.challenges.length
              ? html`
                  <nav
                    class="collection collection--song"
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
                  </nav>
                  <div
                    id="event-challenge-ranking"
                    role="tabpanel"
                    aria-labelledby=${`event-challenge-${this.challengeId}`}
                  >
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
      </div>
    `;
  }
}
if (!customElements.get("event-tracker")) customElements.define("event-tracker", EventTracker);
