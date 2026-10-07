import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { RequestScope } from "../lib/request-scope";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { resourcePath } from "../lib/resource-route";
import { resolveLocalizedText } from "../lib/localized-text";
import type { Locale } from "../i18n/locales";
import type { ReleaseServer } from "../lib/release-server";
import type { EventTrackerDto, EventChallengeDto, GameRecordsRegion, RankingCardCatalog } from "../lib/game-records";
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
  moenotesBrand,
} from "./shared/game-records";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { iconButton, rovingKeydown } from "./ui/controls";
import { tile } from "./ui/tile";
import { liveMusicTypeMark, songTile } from "./shared/song-tile";
import { LazyImages, localeTaggedCandidates, localizedAssetUrl, nextImageCandidate } from "./ui/lazy-images";
import { emptyState, errorState, loadingState } from "./ui/state";
import { songTitle } from "../lib/song-display";
import { SongRanking } from "./song-ranking";
import "../styles/settings.css";
import "../styles/song-ranking.css";

type Region = GameRecordsRegion;
type TrackerPageData = Partial<Record<"jp" | "intl", RankingCardCatalog>> & {
  musicTypeMarks?: Partial<Record<"jp" | "intl", Record<string, string>>>;
};
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
  declare now: number;
  declare refreshing: boolean;
  private requests = new RequestScope();
  private lazyImages = new LazyImages({ candidates: (source) => localeTaggedCandidates(source, this.locale) });
  private lifetime?: AbortController;
  private clock = 0;
  private poll = 0;
  private infoServer: ReleaseServer = "intl";
  private cards: Partial<Record<"jp" | "intl", RankingCardCatalog>> = {};
  private musicTypeMarks: Partial<Record<"jp" | "intl", Map<string, string>>> = {};
  private readonly owner = `event-tracker-${++trackerSequence}`;

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
    this.now = Date.now();
    this.refreshing = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    const pageData = readPageData<TrackerPageData>(this) || {};
    this.cards = { intl: pageData.intl, jp: pageData.jp };
    this.musicTypeMarks = Object.fromEntries(
      Object.entries(pageData.musicTypeMarks || {}).map(([source, marks]) => [source, new Map(Object.entries(marks))]),
    );
    this.locale = preferredLocale(this.locale);
    const params = navigationDocumentUrl().searchParams;
    const requested = params.get("region");
    this.region = GAME_RECORDS_REGIONS.some((option) => option.value === requested)
      ? (requested as Region)
      : defaultGameRecordsRegion(this.server, this.locale);
    this.challengeId = params.get("challenge") || "";
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
    this.poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.refresh();
    }, 60_000);
    void this.load();
  }
  disconnectedCallback() {
    this.requests.cancel();
    this.lazyImages.disconnect();
    this.lifetime?.abort();
    window.clearInterval(this.clock);
    window.clearInterval(this.poll);
    clearAppBarActions(this.owner);
    super.disconnectedCallback();
  }
  private label(key: string, fallback: string) {
    return clientText(this.locale, `eventTracker.${key}`, fallback);
  }
  private sourceServer(): "jp" | "intl" {
    return this.region === "jp" ? "jp" : "intl";
  }
  private async load() {
    const region = this.region;
    const signal = this.requests.begin();
    this.refreshing = true;
    if (!this.data) this.phase = "loading";
    try {
      const data = await fetchJson<EventTrackerDto>(`/api/v1/game/records/${region}/events/current`, {
        signal,
        cache: "no-store",
      });
      if (!this.isConnected || this.region !== region || !this.requests.current(signal)) return;
      const changed = this.data?.event?.id !== data.event?.id;
      this.data = data;
      this.phase = "ready";
      if (changed) {
        this.info = null;
        this.songs = {};
      }
      const challenges = data.event?.challenges || [];
      if (!challenges.some((challenge) => challenge.id === this.challengeId))
        this.challengeId = challenges.find((challenge) => challenge.enabled)?.id || challenges[0]?.id || "";
      if (data.event && (changed || !this.info)) await this.loadCatalog(data.event.id, challenges, signal);
    } catch {
      if (!this.isConnected || this.region !== region || !this.requests.current(signal)) return;
      this.phase = "error";
    } finally {
      if (this.requests.current(signal)) this.refreshing = false;
    }
  }
  private async loadCatalog(id: string, challenges: EventChallengeDto[], signal: AbortSignal) {
    const preferred = this.sourceServer();
    const candidates: ReleaseServer[] = preferred === "jp" ? ["jp", "jp-cbt", "intl"] : ["intl", "jp", "jp-cbt"];
    let info: JsonRecord | null = null;
    const songs: Record<string, JsonRecord> = {};
    for (const server of candidates) {
      if (!this.requests.current(signal)) return;
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
      if (!this.requests.current(signal)) return;
      if (!info && eventResult.status === "fulfilled" && eventResult.value) {
        info = eventResult.value;
        this.infoServer = server;
      }
      if (songResult.status === "fulfilled" && songResult.value) Object.assign(songs, songResult.value.items);
      if (info && challenges.every((challenge) => songs[challenge.musicId])) break;
    }
    if (this.requests.current(signal)) {
      this.info = info;
      this.songs = songs;
    }
  }
  private selectRegion(region: Region) {
    if (region === this.region) return;
    this.requests.cancel();
    this.region = region;
    this.data = null;
    this.info = null;
    this.songs = {};
    this.challengeId = "";
    this.syncUrl();
    void this.load();
  }
  private selectChallenge(id: string) {
    this.challengeId = id;
    this.syncUrl();
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      }),
    );
  }
  private syncUrl() {
    const url = new URL(location.href);
    url.searchParams.set("region", this.region);
    if (this.challengeId) url.searchParams.set("challenge", this.challengeId);
    else url.searchParams.delete("challenge");
    history.replaceState(history.state, "", url);
  }
  private async refresh() {
    if (this.refreshing) return;
    const region = this.region;
    await this.load();
    if (this.isConnected && this.region === region)
      this.querySelectorAll<SongRanking>("song-ranking").forEach((ranking) => ranking.refreshRanking());
  }
  private eventTitle() {
    return (
      resolveLocalizedText(this.info?.title, this.locale).text ||
      this.label("eventName", "Event #{id}").replace("{id}", this.data?.event?.id || "")
    );
  }
  private challengeTitle(challenge: EventChallengeDto) {
    const song = this.songs[challenge.musicId];
    return song
      ? songTitle(song, this.locale).text
      : this.label("songName", "Song #{id}").replace("{id}", challenge.musicId);
  }
  private countdown() {
    const event = this.data?.event;
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
  updated() {
    this.lazyImages.observe(this);
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
    if (!this.data)
      return this.phase === "error"
        ? errorState(
            this.label("error", "Event information is unavailable."),
            this.label("retry", "Retry"),
            () => void this.load(),
          )
        : loadingState(this.label("loading", "Loading event"));
    const event = this.data.event;
    if (!event)
      return emptyState({ title: this.label("empty", "No event is currently being tracked."), icon: "event" });
    const challenge = event.challenges.find((row) => row.id === this.challengeId);
    const readable = challenge?.enabled && ["collecting", "finalizing", "archived"].includes(challenge.status);
    const pointsReadable =
      event.pointRankingEnabled && !["pending", "missed", "disabled", "unknown"].includes(event.pointRankingStatus);
    const marks = this.musicTypeMarks[this.sourceServer()] || new Map<string, string>();
    return html`
      <div class="song-ranking-page song-ranking__content">
        <div class="row row--start">
          <header class="browse__heading grow">
            <a
              class="browse__heading-art-link"
              href=${resourcePath({ server: this.infoServer, locale: this.locale as Locale, kind: "events", id: event.id })}
              aria-label=${`${this.label("event", "Event")} · ${this.eventTitle()}`}
            >
              ${
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
                  : nothing
              }
            </a>
            <div class="browse__heading-copy">
              <h2 lang=${resolveLocalizedText(this.info?.title, this.locale).locale}>${this.eventTitle()}</h2>
              <p>
                ${this.label("event", "Event")} · #${event.id} ·
                ${gameDateTimeRange(this.locale, event.startAtMs || 0, event.endAtMs || 0)}
              </p>
              <p class="tabular" role="timer" aria-live="off">${this.countdown()}</p>
              ${
                this.phase === "error"
                  ? html`
                      <p role="status">${this.label("cached", "Showing the last available event information.")}</p>
                    `
                  : nothing
              }
            </div>
          </header>
          ${moenotesBrand(`https://bdon.moe/events/tracker?server=${this.region}`)}
        </div>
        <section class="detail-section">
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
                      const categories = formatList(
                        (Array.isArray(song.musicCategories) ? song.musicCategories : [])
                          .map((id) => ["", "original", "virtual", "jpop", "anime", "game"][Number(id)])
                          .filter(Boolean)
                          .map((name) => clientText(this.locale, `songTypes.${name}`, name)),
                        this.locale,
                        "unit",
                      );
                      const options = songTile(
                        song,
                        {
                          locale: this.locale,
                          title: (entry) => songTitle(entry, this.locale),
                          image: (entry) => String(entry.jacketThumbUrl || entry.jacketUrl || entry.image || ""),
                          artist: (entry) => resolveLocalizedText(entry.bandName || entry.secondary, this.locale).text,
                          bandIcon: (entry) => String((entry.bandDetails as JsonRecord | undefined)?.icon || ""),
                          imageForLocale: (source) => localizedAssetUrl(source, this.locale),
                          attributeMark: (entry) => liveMusicTypeMark(marks, entry.musicType),
                          attributeLabel: (entry) => {
                            const name =
                              ["", "red", "blue", "green", "yellow", "purple"][Number(entry.musicType)] || "";
                            return name ? clientText(this.locale, `liveMusicTypes.${name}`, name) : "";
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
                              embedded
                              .locale=${this.locale}
                              .server=${this.sourceServer()}
                              .region=${this.region}
                              .rankingTitle=${this.label("challengeRanking", "Challenge song ranking")}
                              .rankingEndpoint=${`/api/v1/game/records/${this.region}/events/${event.id}/challenges/${challenge!.id}/ranking`}
                              .cardCatalogData=${this.cards}
                            ></song-ranking>
                          `
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
        <section class="detail-section">
          ${renderDetailSectionHeading(this.label("pointRanking", "Event point ranking"), "works")}
          ${
            pointsReadable
              ? html`
                  <song-ranking
                    embedded
                    points
                    .locale=${this.locale}
                    .server=${this.sourceServer()}
                    .region=${this.region}
                    .rankingTitle=${this.label("pointRanking", "Event point ranking")}
                    .rankingEndpoint=${`/api/v1/game/records/${this.region}/events/${event.id}/latest`}
                    .cardCatalogData=${this.cards}
                  ></song-ranking>
                `
              : emptyState({
                  title: this.label(
                    event.pointRankingEnabled ? "pending" : "pointsDisabled",
                    event.pointRankingEnabled ? "Ranking data is being collected." : "This event has no point ranking.",
                  ),
                  icon: "leaderboard",
                })
          }
        </section>
      </div>
    `;
  }
}
if (!customElements.get("event-tracker")) customElements.define("event-tracker", EventTracker);
