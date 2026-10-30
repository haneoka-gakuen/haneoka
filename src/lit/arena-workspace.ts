// L3 — GEB
// Input: Pinned Arena seasons, leagues, rotations, ranks, rewards, rule parameters and UI marks; live league rankings.
// Output: Season and league overview, leaderboard, schedule, songs, ranks and rewards, and rules tabs.
// Pos: [Map](L2-2.md); standalone Arena workspace using shared app bar, tabs, tables and the song-ranking rows.
// Effects/Dependencies: Embedded static data; reads ranking and population APIs; owns app-bar actions, URL state and the boundary timer.
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { clientText } from "../i18n/client";
import type { Locale } from "../i18n/locales";
import {
  ARENA_PROJECTION,
  arenaBoundaries,
  arenaContains,
  arenaCurrentRule,
  arenaPeriods,
  arenaSongRule,
  type ArenaCatalog,
  type ArenaLeague,
  type ArenaRank,
  type ArenaReward,
  type ArenaRule,
  type ArenaSeason,
} from "../lib/arena";
import type { CatalogSystemPayload } from "../lib/catalog-system-data";
import type { ArenaPopulationDto, ArenaRankingDto, GameRecordsRegion } from "../lib/game-records";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { resourcePath, releaseServerFromPath, type ReleaseServer } from "../lib/resource-route";
import { navigationDocumentUrl } from "../lib/document-url";
import { catalogUrl, fetchJson, gameDateTime, localizedText, preferredLocale } from "./shared/catalog";
import { renderDetailSectionHeading as heading } from "./shared/detail-section-heading";
import { defaultGameRecordsRegion, gameRecordsRegionPicker } from "./shared/game-records";
import { arenaAttribute, arenaAttributeLabel, arenaMission, arenaMissionLabel, arenaRuleMarks, arenaRuleText, type ArenaRuleContext, type ArenaRuleView } from "./shared/arena-rule";
import { collectionTable } from "./ui/collection-view";
import { emptyState, errorState, loadingState } from "./ui/state";
import { LazyImages } from "./ui/lazy-images";
import { icon } from "./ui/icon";
import { filterChip, iconButton, rovingKeydown, segmented } from "./ui/controls";
import "./arena-ranking";
import "../styles/settings.css";
import "../styles/arena.css";
import { formatDate, formatDateRange } from "../lib/date-format";

type Tab = "overview" | "ranking" | "schedule" | "songs" | "ranks" | "rules";
const TABS: readonly Tab[] = ["overview", "ranking", "schedule", "songs", "ranks", "rules"];
/** MasterParameter `arena_*` values the rules tab names, in reading order. */
const RULES = [
  "matching_entry_time_limit_second",
  "matching_time_limit_second",
  "matching_phase_duration_sec",
  "disconnect_penalty_threshold",
  "penalty_rate",
] as const;

let sequence = 0;
export class ArenaWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    now: { state: true },
    selectedSeasonId: { state: true },
    bandId: { state: true },
    tab: { state: true },
    region: { state: true },
    scheduleAll: { state: true },
    players: { state: true },
    ranking: { state: true },
    population: { state: true },
  };
  declare locale: Locale;
  declare phase: "loading" | "ready" | "error";
  declare now: number;
  declare selectedSeasonId: string;
  declare bandId: number;
  declare tab: Tab;
  declare region: GameRecordsRegion;
  declare scheduleAll: boolean;
  declare players: number;
  declare ranking: ArenaRankingDto | null;
  declare population: ArenaPopulationDto | "loading" | "error" | null;
  private catalog?: ArenaCatalog;
  private marks: Record<string, string> = {};
  private cards: CatalogSystemPayload["rankingCards"] = {};
  /** The page's release server; the URL keeps it whatever region is shown. */
  private server = "jp";
  /** The release whose Arena data the selected region reads. */
  private dataServer = "jp";
  private sources = new Map<string, { catalog: ArenaCatalog; marks: Record<string, string> }>();
  private sourceRequest?: AbortController;
  private owner = `arena-${++sequence}`;
  private timer = 0;
  private request?: AbortController;
  private populationRequest?: AbortController;
  private populationKey = "";
  private images = new LazyImages();
  /** Keeps each panel's row span equal to its height plus the 16px gap, so panels pack like a waterfall. */
  private masonry =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const panel = entry.target as HTMLElement;
            panel.style.setProperty("--arena-rows", String(Math.ceil((panel.getBoundingClientRect().height + 16) / 8)));
          }
        });
  private localeReady = () => {
    this.locale = preferredLocale(this.locale) as Locale;
  };
  private visibility = () => {
    if (!document.hidden) {
      this.now = Date.now();
      this.schedule();
    }
  };
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.now = Date.now();
    this.selectedSeasonId = "";
    this.bandId = 0;
    this.tab = "overview";
    this.region = "jp";
    this.scheduleAll = false;
    this.players = 5;
    this.ranking = null;
    this.population = null;
  }
  createRenderRoot() {
    return this;
  }
  preparePage(payload: CatalogSystemPayload, locale: string) {
    adoptPrerenderedWorkspace(this);
    this.locale = locale as Locale;
    this.server = this.dataServer = payload.server;
    this.now = Date.now();
    this.catalog = payload.arena;
    this.marks = payload.marks || {};
    if (payload.arena) this.sources.set(payload.server, { catalog: payload.arena, marks: this.marks });
    this.cards = payload.rankingCards || {};
    this.region = defaultGameRecordsRegion(payload.server, locale);
    this.phase = "ready";
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale) as Locale;
    this.server = this.dataServer = releaseServerFromPath(location.pathname) || "jp";
    addEventListener("haneoka:locale-ready", this.localeReady);
    document.addEventListener("visibilitychange", this.visibility);
    addEventListener("popstate", this.restoreState);
    void this.load();
  }
  disconnectedCallback() {
    this.request?.abort();
    this.sourceRequest?.abort();
    this.populationRequest?.abort();
    clearTimeout(this.timer);
    this.images.disconnect();
    this.masonry?.disconnect();
    clearAppBarActions(this.owner);
    removeEventListener("haneoka:locale-ready", this.localeReady);
    document.removeEventListener("visibilitychange", this.visibility);
    removeEventListener("popstate", this.restoreState);
    super.disconnectedCallback();
  }
  private async load() {
    const payload = readPageData<CatalogSystemPayload>(this);
    if (payload?.kind === "arena" && payload.arena) this.preparePage(payload, this.locale);
    else {
      this.request?.abort();
      const request = (this.request = new AbortController());
      this.phase = "loading";
      try {
        const { catalog, marks } = await this.fetchSource(this.server, request.signal);
        if (request.signal.aborted) return;
        this.sources.set(this.server, { catalog, marks });
        this.catalog = catalog;
        this.marks = marks;
        this.region = defaultGameRecordsRegion(
          this.server as Parameters<typeof defaultGameRecordsRegion>[0],
          this.locale,
        );
        this.phase = "ready";
      } catch {
        if (!request.signal.aborted) this.phase = "error";
      }
    }
    this.now = Date.now();
    if (this.isConnected) {
      this.restoreState();
      this.schedule();
    }
  }
  private async fetchSource(server: string, signal: AbortSignal) {
    const catalog = await fetchJson<ArenaCatalog>(`${catalogUrl("arena", "", server)}?projection=${ARENA_PROJECTION}`, {
      signal,
    });
    const marksUrl = new URL(catalogUrl("ui-marks", "", server), location.origin);
    marksUrl.searchParams.set("release", catalog.identity.releaseId);
    return { catalog, marks: await fetchJson<Record<string, string>>(marksUrl.toString(), { signal }) };
  }
  /** Japan reads the Japanese release; Taiwan, English and Korea read the international one. */
  private regionServer(region: GameRecordsRegion) {
    if (region !== "jp") return "intl";
    return this.server === "jp" || this.server === "jp-cbt" ? this.server : "jp";
  }
  /** Shows the selected region's own Arena seasons, loading that release once when it differs from the page's. */
  private async showRegion() {
    const server = this.regionServer(this.region);
    if (server === this.dataServer && this.catalog) return;
    let source = this.sources.get(server);
    if (!source) {
      this.sourceRequest?.abort();
      const request = (this.sourceRequest = new AbortController());
      this.phase = "loading";
      try {
        source = await this.fetchSource(server, request.signal);
      } catch {
        if (!request.signal.aborted) this.phase = "error";
        return;
      }
      if (request.signal.aborted) return;
      this.sources.set(server, source);
    }
    if (this.regionServer(this.region) !== server) return;
    this.catalog = source.catalog;
    this.marks = source.marks;
    this.dataServer = server;
    this.ranking = null;
    this.population = null;
    if (!this.seasons().some((season) => season.id === this.selectedSeasonId)) this.selectedSeasonId = "";
    this.phase = "ready";
    this.writeState();
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    const now = Date.now();
    const next = this.seasons()
      .flatMap(arenaBoundaries)
      .filter((at) => at > now)
      .sort((a, b) => a - b)[0];
    if (next)
      this.timer = window.setTimeout(
        () => {
          this.now = Date.now();
          this.schedule();
        },
        Math.min(2_147_483_647, next - now),
      );
  }

  /* ---------- state and URL ---------- */
  private seasons() {
    return Object.values(this.catalog?.entries || {}).sort((a, b) => a.startAt - b.startAt);
  }
  private season() {
    const seasons = this.seasons();
    return (
      seasons.find((season) => season.id === this.selectedSeasonId) ||
      seasons.find((season) => arenaContains(season, this.now)) ||
      seasons.filter((season) => season.startAt <= this.now).at(-1) ||
      seasons[0]
    );
  }
  private league(season: ArenaSeason) {
    return season.leagues.find((league) => league.bandId === this.bandId) || season.leagues[0];
  }
  private regions(): GameRecordsRegion[] {
    return ["jp", "tw", "en", "kr"];
  }
  private restoreState = () => {
    const url = navigationDocumentUrl();
    const season = url.searchParams.get("season");
    if (season && this.seasons().some((entry) => entry.id === season)) this.selectedSeasonId = season;
    const band = Number(url.searchParams.get("band"));
    if (Number.isSafeInteger(band) && band > 0) this.bandId = band;
    const region = url.searchParams.get("region") as GameRecordsRegion | null;
    if (region && this.regions().includes(region)) this.region = region;
    const tab = url.hash.slice(1) as Tab;
    this.tab = TABS.includes(tab) ? tab : "overview";
    void this.showRegion();
  };
  private writeState() {
    const url = navigationDocumentUrl();
    const set = (key: string, value: string | null) =>
      value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    set("season", this.selectedSeasonId || null);
    set("band", this.bandId ? String(this.bandId) : null);
    set("region", this.region === defaultGameRecordsRegion(this.server as Parameters<typeof defaultGameRecordsRegion>[0], this.locale) ? null : this.region);
    url.hash = this.tab === "overview" ? "" : this.tab;
    history.replaceState(history.state, "", url);
  }
  private select(patch: Partial<Pick<ArenaWorkspace, "selectedSeasonId" | "bandId" | "tab" | "region">>) {
    Object.assign(this, patch);
    this.writeState();
    if (patch.region) void this.showRegion();
  }

  /* ---------- formatting ---------- */
  private t(key: string, params?: Record<string, string | number>) {
    return clientText(this.locale, `catalog.arena.${key}`, key, params);
  }
  private name(value: unknown) {
    return localizedText(value, this.locale);
  }
  private time(at: number) {
    return html`
      <time datetime=${new Date(at).toISOString()}>${gameDateTime(this.locale, at)}</time>
    `;
  }
  private short(at: number) {
    return formatDate(this.locale, at, { time: true });
  }
  private remaining(until: number) {
    const minutes = Math.max(0, Math.round((until - this.now) / 60000));
    const days = Math.floor(minutes / 1440),
      hours = Math.floor((minutes % 1440) / 60),
      rest = minutes % 60;
    return days ? this.t("remainingDays", { days, hours }) : this.t("remainingHours", { hours, minutes: rest });
  }
  private href(kind: "songs" | "items" | "events" | "exchange", id: string) {
    return resourcePath({ server: this.dataServer as ReleaseServer, locale: this.locale, kind, id });
  }
  private tierName(rank: ArenaRank) {
    return this.name(rank.name).replace(/\s*[0-9０-９]+$/u, "");
  }
  private rankIcon(rank: number, size = 28) {
    const image = this.catalog?.images?.ranks[rank];
    return image
      ? html`
          <img class="arena-rank-icon" src=${image} alt="" width=${size} height=${size} loading="lazy" />
        `
      : nothing;
  }
  private attributeLabel(value: number) {
    return arenaAttributeLabel(this.locale, value);
  }
  private attribute(value: number, size = 24) {
    return arenaAttribute(this.ruleContext(), value, size);
  }
  private missionLabel(value: number) {
    return arenaMissionLabel(this.locale, value);
  }
  private mission(value: number, size = 24) {
    return arenaMission(this.ruleContext(), value, size);
  }
  /** The rule in words beside its icons: the attribute, then the sections as `JUST×3` or `COMBO / LUCK / JUST`. */
  private ruleText(rule: ArenaRuleView) {
    return arenaRuleText(this.locale, rule);
  }
  private ruleMarks(rule: ArenaRuleView | undefined, size = 24) {
    return arenaRuleMarks(this.ruleContext(), rule, size);
  }
  private ruleContext(): ArenaRuleContext {
    return { locale: this.locale, server: this.dataServer, catalog: this.catalog!, marks: this.marks };
  }
  private range(start: number, end: number) {
    return formatDateRange(this.locale, start, end, { time: true });
  }
  private rewardList(rewards: readonly ArenaReward[]) {
    return html`
      <span class="arena-rewards">
        ${rewards.map(
          (reward) => html`
            <a
              class="arena-reward"
              href=${reward.resourceType === 1 ? this.href("items", String(reward.resourceId)) : nothing}
              title=${this.name(reward.name)}
            >
              ${
                reward.image
                  ? html`
                      <img src=${reward.image} alt="" width="28" height="28" loading="lazy" />
                    `
                  : nothing
              }
              <span class="arena-reward__name">${this.name(reward.name)}</span>
              <span class="arena-reward__count">×${reward.count.toLocaleString(this.locale)}</span>
            </a>
          `,
        )}
      </span>
    `;
  }
  private seasonStatus(season: ArenaSeason) {
    return this.now < season.startAt ? "upcoming" : arenaContains(season, this.now) ? "current" : "ended";
  }
  /** The open rule, else the next one, for a league in a season. */
  private ruleNow(season: ArenaSeason, league: ArenaLeague): { rule?: ArenaRule; next: ArenaRule[] } {
    const rule = arenaCurrentRule(season, league, this.now);
    const next = league.rules.filter((entry) => entry.startAt > this.now).slice(0, 3);
    return { rule, next };
  }

  /* ---------- app bar ---------- */
  renderStaticChrome() {
    const season = this.season();
    const league = season && this.league(season);
    setAppBarActions(
      this.owner,
      html`
        ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.select({ region }), "arena-region", this.regions())}
        ${
          league
            ? html`
                <a
                  class="icon-button"
                  href=${`/${this.locale}/team-builder/?tab=arena&server=${this.dataServer === "jp" || this.dataServer === "jp-cbt" ? "jp" : "intl"}&league=${league.id}`}
                  aria-label=${this.t("buildTeam")}
                  title=${this.t("buildTeam")}
                >
                  ${icon("groups")}
                </a>
              `
            : nothing
        }
        <a
          class="icon-button"
          href=${`/${this.server}/${this.locale}/calendar/?kinds=arena,arena-rotation,event&view=agenda`}
          aria-label=${this.t("calendar")}
          title=${this.t("calendar")}
        >
          ${icon("calendar_month")}
        </a>
      `,
    );
  }
  updated() {
    for (const panel of this.querySelectorAll<HTMLElement>(".arena-grid > *")) this.masonry?.observe(panel);
    this.images.observe(this);
    this.renderStaticChrome();
    this.loadPopulation();
  }

  /* ---------- live data ---------- */
  /** Every open division's lowest points, ascending; the population is counted per division. */
  private thresholds(league: ArenaLeague) {
    const points = new Map<number, ArenaRank>();
    for (const rank of league.ranks)
      if ((!rank.startAt || rank.startAt <= this.now) && !points.has(rank.points)) points.set(rank.points, rank);
    return [...points].sort((a, b) => a[0] - b[0]);
  }
  private loadPopulation() {
    const season = this.season();
    if (
      !season ||
      this.phase !== "ready" ||
      (this.tab !== "overview" && this.tab !== "ranking") ||
      this.now < season.startAt
    )
      return;
    const league = this.league(season);
    const thresholds = this.thresholds(league).map(([points]) => points);
    const key = `${this.region}/${season.seasonId}/${league.bandId}/${thresholds.join(",")}`;
    if (key === this.populationKey) return;
    this.populationKey = key;
    this.populationRequest?.abort();
    const request = (this.populationRequest = new AbortController());
    this.population = "loading";
    const url = `/api/v1/game/records/${this.region}/arena/seasons/${season.seasonId}/leagues/${league.bandId}/population?thresholds=${thresholds.join(",")}`;
    /** A cold count finishes on the server; 202 asks to read it back shortly. */
    const attempt = async (tries: number): Promise<void> => {
      const response = await fetch(url, { signal: request.signal, headers: { accept: "application/json" } });
      if (response.status === 202 && tries > 1) {
        await new Promise((resolve) => setTimeout(resolve, (Number(response.headers.get("Retry-After")) || 10) * 1000));
        return attempt(tries - 1);
      }
      if (!response.ok) throw new Error(String(response.status));
      const value = (await response.json()) as ArenaPopulationDto;
      if (!request.signal.aborted) this.population = value;
    };
    attempt(12).catch(() => {
      if (!request.signal.aborted) this.population = "error";
    });
  }

  /* ---------- hero ---------- */
  private renderHero(season: ArenaSeason, selected: ArenaLeague) {
    const seasons = this.seasons();
    const index = seasons.indexOf(season);
    const status = this.seasonStatus(season);
    const period = arenaPeriods(season).find((entry) => entry.startAt <= this.now && this.now < entry.endAt);
    return html`
      <section class="arena-hero surface stack">
        <div class="arena-hero__season">
          ${iconButton({ icon: "chevron_left", label: this.t("previousSeason"), disabled: index <= 0, onClick: () => this.select({ selectedSeasonId: seasons[index - 1]!.id }) })}
          <div class="arena-hero__title">
            <h2 class="md-title-large">${this.name(season.title)}</h2>
            <span class="arena-status" data-status=${status}>${this.t(`status.${status}`)}</span>
          </div>
          ${iconButton({ icon: "chevron_right", label: this.t("nextSeason"), disabled: index >= seasons.length - 1, onClick: () => this.select({ selectedSeasonId: seasons[index + 1]!.id }) })}
        </div>
        <div class="arena-hero__facts">
          <span>${icon("date_range", 18)}${this.short(season.startAt)} – ${this.short(season.endAt)}</span>
          <span>${icon("flag", 18)}${this.t("rankingEnds")} ${this.short(season.rankingEndAt)}</span>
          ${
            status === "current"
              ? html`
                  <span>${icon("hourglass_bottom", 18)}${this.t("seasonLeft")} ${this.remaining(season.endAt)}</span>
                  ${
                    period
                      ? html`
                          <span>${icon("autorenew", 18)}${this.t("nextRotation")} ${this.remaining(period.endAt)}</span>
                        `
                      : nothing
                  }
                `
              : status === "upcoming"
                ? html`
                    <span>${icon("schedule", 18)}${this.t("startsIn")} ${this.remaining(season.startAt)}</span>
                  `
                : nothing
          }
        </div>
        <div
          class="arena-leagues"
          role="radiogroup"
          aria-label=${this.t("leagues")}
          @keydown=${rovingKeydown(
            season.leagues.map((league) => league.bandId),
            selected.bandId,
            (bandId) => this.select({ bandId }),
          )}
        >
          ${season.leagues.map((league) => {
            const { rule, next } = this.ruleNow(season, league);
            const checked = league.bandId === selected.bandId;
            return html`
              <button
                type="button"
                class="arena-league"
                role="radio"
                aria-checked=${String(checked)}
                tabindex=${checked ? "0" : "-1"}
                @click=${() => this.select({ bandId: league.bandId })}
              >
                <span class="arena-league__head">
                  ${
                    league.image
                      ? html`
                          <img src=${league.image} alt="" width="32" height="32" loading="lazy" />
                        `
                      : nothing
                  }
                  <span class="arena-league__name">${this.name(league.name)}</span>
                </span>
                ${this.ruleMarks(rule ?? next[0], 22)}
                <small class="arena-league__meta">
                  ${rule ? this.range(rule.startAt, rule.endAt + 1000) : next[0] ? this.range(next[0].startAt, next[0].endAt + 1000) : this.t("noSchedule")}
                </small>
              </button>
            `;
          })}
        </div>
      </section>
    `;
  }
  private renderTabs() {
    const labels: Record<Tab, [string, TemplateResult]> = {
      overview: [this.t("tabs.overview"), icon("insights", 18)],
      ranking: [this.t("tabs.ranking"), icon("leaderboard", 18)],
      schedule: [this.t("tabs.schedule"), icon("calendar_view_week", 18)],
      songs: [this.t("tabs.songs"), icon("music_note", 18)],
      ranks: [this.t("tabs.ranks"), icon("military_tech", 18)],
      rules: [this.t("tabs.rules"), icon("gavel", 18)],
    };
    return html`
      <nav
        class="tabs tabs--pills arena-tabs"
        role="tablist"
        aria-label=${this.t("title")}
        @keydown=${rovingKeydown(TABS, this.tab, (tab) => this.select({ tab }))}
      >
        ${TABS.map(
          (tab) => html`
            <button
              class="tab"
              type="button"
              role="tab"
              id=${`arena-tab-${tab}`}
              aria-controls="arena-panel"
              aria-selected=${String(this.tab === tab)}
              tabindex=${this.tab === tab ? "0" : "-1"}
              @click=${() => this.select({ tab })}
            >
              ${labels[tab][1]}
              <span>${labels[tab][0]}</span>
            </button>
          `,
        )}
      </nav>
    `;
  }

  /* ---------- overview ---------- */
  private renderCondition(season: ArenaSeason, league: ArenaLeague) {
    const { rule, next } = this.ruleNow(season, league);
    const shown = rule ?? next[0];
    return html`
      <section class="surface stack arena-condition arena-start">
        <header class="arena-condition__head">
          ${
            league.image
              ? html`
                  <img src=${league.image} alt="" width="40" height="40" />
                `
              : nothing
          }
          <div>
            <h3 class="md-title-medium">${this.name(league.name)}</h3>
            <span class="md-body-small">
              ${rule ? this.t("currentRule") : shown ? this.t("nextRule") : this.t("noSchedule")}
            </span>
          </div>
          <a class="button button--filled" href=${`/${this.locale}/team-builder/?tab=arena&server=${this.dataServer === "jp" || this.dataServer === "jp-cbt" ? "jp" : "intl"}&league=${league.id}`}>
            ${icon("groups")}${this.t("buildTeam")}
          </a>
        </header>
        ${
          shown
            ? html`
                <div class="arena-condition__rule">
                  <div class="arena-condition__attribute">
                    ${this.attribute(shown.musicType, 48)}
                    <span>
                      <small>${this.t("stageAttribute")}</small>
                      <strong>${this.attributeLabel(shown.musicType)}</strong>
                    </span>
                  </div>
                  <ol class="arena-sections">
                    ${shown.missions.map(
                      (value, index) => html`
                        <li>
                          <small>${this.t("section", { index: index + 1 })}</small>
                          ${this.mission(value, 36)}
                          <strong>${this.missionLabel(value)}</strong>
                        </li>
                      `,
                    )}
                  </ol>
                </div>
                <p class="arena-condition__summary md-title-small">
                  ${this.attributeLabel(shown.musicType)} · ${this.ruleText(shown)}
                </p>
                <p class="arena-condition__window md-body-medium">
                  ${icon("schedule", 18)}${this.time(shown.startAt)} – ${this.time(shown.endAt)}
                  ${
                    rule
                      ? html`
                          <span class="arena-status" data-status="current">${this.remaining(rule.endAt + 1000)}</span>
                        `
                      : nothing
                  }
                </p>
              `
            : nothing
        }
        ${
          next.length && rule
            ? html`
                <ol class="arena-next">
                  ${next.map(
                    (entry) => html`
                      <li>
                        <span>${this.range(entry.startAt, entry.endAt + 1000)}</span>
                        ${this.ruleMarks(entry, 20)}
                      </li>
                    `,
                  )}
                </ol>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderEntry(season: ArenaSeason, league: ArenaLeague) {
    const songs = league.songs.filter((song) => Number(song.arenaPublishedAt) <= this.now).length;
    return html`
      <section class="surface stack arena-end">
        ${heading(this.t("entry"), "details")}
        <dl class="spec-list spec-list--split">
          <div>
            <dt>${this.t("members")}</dt>
            <dd>${this.t("membersValue", { band: this.name(league.name) })}</dd>
          </div>
          <div>
            <dt>${this.t("supports")}</dt>
            <dd>${this.t("supportsValue")}</dd>
          </div>
          <div>
            <dt>${this.t("team")}</dt>
            <dd>${this.t("teamValue")}</dd>
          </div>
          <div>
            <dt>${this.t("songCount")}</dt>
            <dd>${songs.toLocaleString(this.locale)}</dd>
          </div>
          <div>
            <dt>${this.t("dailyRewards")}</dt>
            <dd>${this.t("plays", { count: season.dailyRewards.length })}</dd>
          </div>
          <div>
            <dt>${this.t("rankingEnds")}</dt>
            <dd>${this.time(season.rankingEndAt)}</dd>
          </div>
        </dl>
      </section>
    `;
  }
  /** Each rank's players with its divisions' counts beneath, highest rank first. */
  private renderPopulation(league: ArenaLeague) {
    const population = this.population;
    const data = typeof population === "object" && population ? population : null;
    const total = data?.maxRank ?? data?.tiers.reduce((sum, tier) => sum + tier.count, 0) ?? null;
    const count = (points: number) => data?.tiers.find((tier) => tier.threshold === points)?.count;
    const tiers = new Map<number, ArenaRank[]>();
    for (const [, rank] of this.thresholds(league)) tiers.set(rank.rank, [...(tiers.get(rank.rank) ?? []), rank]);
    const groups = [...tiers].reverse().map(([tier, divisions]) => {
      const counts = divisions.map((division) => count(division.points));
      const sum = counts.every((value) => value != null) ? counts.reduce<number>((a, b) => a + b!, 0) : null;
      return { tier, divisions: [...divisions].reverse(), counts: [...counts].reverse(), sum };
    });
    const largest = Math.max(1, ...groups.map((group) => group.sum ?? 0));
    const percent = (value: number) =>
      new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 }).format(value / (total || 1));
    return html`
      <section class="surface stack arena-start">
        ${heading(this.t("population"), "characters", total != null ? { count: total.toLocaleString(this.locale) } : {})}
        ${
          population === "error"
            ? html`
                <p class="md-body-medium">${this.t("unavailable")}</p>
              `
            : html`
                <ol class="arena-population" aria-busy=${String(population === "loading")}>
                  ${groups.map(
                    (group) => html`
                      <li>
                        ${this.rankIcon(group.tier, 32)}
                        <span class="arena-population__name">
                          ${this.tierName(group.divisions[0]!)}
                          <small>${group.divisions.at(-1)!.points.toLocaleString(this.locale)}+</small>
                        </span>
                        <span class="arena-population__bar">
                          <span
                            style=${`inline-size:${group.sum == null ? 0 : Math.max(1, (group.sum / largest) * 100)}%`}
                          ></span>
                        </span>
                        <strong>${group.sum == null ? "—" : group.sum.toLocaleString(this.locale)}</strong>
                        <small class="arena-population__share">
                          ${group.sum == null || !total ? "" : percent(group.sum)}
                        </small>
                        ${
                          group.divisions.length > 1
                            ? html`
                                <span class="arena-population__divisions">
                                  ${group.divisions.map(
                                    (division, index) => html`
                                      <span
                                        title=${`${this.name(division.name)} · ${division.points.toLocaleString(this.locale)}+`}
                                      >
                                        <span>${this.name(division.name)}</span>
                                        <strong>
                                          ${group.counts[index] == null ? "—" : group.counts[index]!.toLocaleString(this.locale)}
                                        </strong>
                                      </span>
                                    `,
                                  )}
                                </span>
                              `
                            : nothing
                        }
                      </li>
                    `,
                  )}
                </ol>
              `
        }
      </section>
    `;
  }
  /** Card use across the loaded leaderboard window: leaders (first slot), members and snapshots. */
  private renderUsage() {
    const rows = this.ranking?.rows ?? [];
    if (!rows.length) return nothing;
    const count = (pick: (row: (typeof rows)[number]) => Array<number | null>) => {
      const counts = new Map<number, number>();
      for (const row of rows) for (const id of new Set(pick(row))) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
    };
    const groups: Array<[string, Array<[number, number]>, boolean]> = [
      [this.t("leaders"), count((row) => [row.cards.find((card) => card.slot === 0)?.memberCardId ?? null]), false],
      [this.t("memberUse"), count((row) => row.cards.map((card) => card.memberCardId)), false],
      [this.t("supportUse"), count((row) => row.cards.map((card) => card.supportCardId)), true],
    ];
    const source = this.dataServer === "jp" || this.dataServer === "jp-cbt" ? "jp" : "intl";
    const catalog = this.cards?.[source];
    return html`
      <section class="surface stack arena-wide">
        ${heading(this.t("usage", { count: rows.length }), "cards")}
        <div class="arena-usage">
          ${groups.map(
            ([label, entries, support]) => html`
              <section class="stack stack--tight">
                <h4 class="detail-section-title">${label}</h4>
                <ol class="arena-usage__list">
                  ${entries.map(([id, uses]) => {
                    const art = (support ? catalog?.support : catalog?.member)?.[String(id)];
                    return html`
                      <li title=${art ? localizedText(art.name, this.locale) : String(id)}>
                        <a
                          href=${resourcePath({ server: this.dataServer as ReleaseServer, locale: this.locale, kind: support ? "support-cards" : "member-cards", id: String(id) })}
                        >
                          ${
                            art?.image
                              ? html`
                                  <span class=${`arena-usage__media card-media card-media--${support ? "support" : "member"}`}>
                                    <img class="arena-usage__art" src=${art.image} alt="" loading="lazy" decoding="async" />
                                    ${
                                      art.attributeIcon
                                        ? html`
                                            <img class="card-media__attribute" src=${art.attributeIcon} alt="" />
                                          `
                                        : nothing
                                    }
                                    ${
                                      art.rarityIcon
                                        ? html`
                                            <img class="card-media__rarity" src=${art.rarityIcon} alt="" />
                                          `
                                        : nothing
                                    }
                                  </span>
                                `
                              : html`
                                  <span class="arena-usage__empty">${id}</span>
                                `
                          }
                        </a>
                        <small>
                          ${new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 0 }).format(uses / rows.length)}
                        </small>
                      </li>
                    `;
                  })}
                </ol>
              </section>
            `,
          )}
        </div>
      </section>
    `;
  }
  private rankingElement(season: ArenaSeason, league: ArenaLeague, limit: number) {
    return html`
      <arena-ranking
        .locale=${this.locale}
        .region=${this.region}
        .seasonId=${season.seasonId}
        .bandId=${league.bandId}
        .ranks=${league.ranks}
        .rankIcons=${this.catalog?.images?.ranks ?? {}}
        .rankName=${(rank: ArenaRank) => this.name(rank.name)}
        .limit=${limit}
        .catalogs=${this.cards}
        @arena-ranking-rows=${(event: CustomEvent<ArenaRankingDto | null>) => {
          if (!limit) this.ranking = event.detail;
        }}
      ></arena-ranking>
    `;
  }
  private renderOverview(season: ArenaSeason, league: ArenaLeague) {
    const started = this.now >= season.startAt;
    return html`
      <div class="arena-grid">
        ${this.renderCondition(season, league)}
        ${
          started
            ? html`
                ${this.renderPopulation(league)}
                <section class="surface stack arena-end">
                  <div class="row row--between">
                    ${heading(this.t("top10"), "rewards")}
                    <button class="button button--text" type="button" @click=${() => this.select({ tab: "ranking" })}>
                      ${this.t("tabs.ranking")}${icon("chevron_right", 18)}
                    </button>
                  </div>
                  ${this.rankingElement(season, league, 10)}
                </section>
              `
            : nothing
        }
        ${this.renderScheduleStrip(season, league)}
      </div>
    `;
  }
  /** The selected league's coming rotations as compact chips. */
  private renderScheduleStrip(season: ArenaSeason, league: ArenaLeague) {
    const rules = league.rules.filter((rule) => rule.endAt + 1000 > this.now).slice(0, 14);
    if (!rules.length) return nothing;
    return html`
      <section class="surface stack arena-wide">
        <div class="row row--between">
          ${heading(this.t("upcoming"), "difficulty")}
          <button class="button button--text" type="button" @click=${() => this.select({ tab: "schedule" })}>
            ${this.t("tabs.schedule")}${icon("chevron_right", 18)}
          </button>
        </div>
        <ol class="arena-strip">
          ${rules.map(
            (rule) => html`
              <li aria-current=${arenaContains(rule, this.now) ? "time" : nothing}>
                <small>${this.range(rule.startAt, rule.endAt + 1000)}</small>
                ${this.ruleMarks(rule, 20)}
              </li>
            `,
          )}
        </ol>
      </section>
    `;
  }

  /* ---------- ranking ---------- */
  private renderRanking(season: ArenaSeason, league: ArenaLeague) {
    if (this.now < season.startAt) return emptyState({ title: this.t("notStarted"), icon: "leaderboard" });
    return html`
      <div class="arena-grid">
        ${this.renderPopulation(league)} ${this.renderUsage()}
        <section class="surface stack arena-wide">${this.rankingElement(season, league, 0)}</section>
      </div>
    `;
  }
  private renderRankingRewards(season: ArenaSeason, league: ArenaLeague) {
    const rewards = (season.rankingRewards ?? []).filter((reward) => !reward.leagueId || reward.leagueId === league.id);
    if (!rewards.length) return nothing;
    const groups = new Map<string, ArenaReward[]>();
    for (const reward of rewards) {
      const key = reward.from === reward.to ? `${reward.from}` : `${reward.from}–${reward.to}`;
      groups.set(key, [...(groups.get(key) ?? []), reward]);
    }
    return html`
      <section class="surface stack">
        ${heading(this.t("rankingRewards"), "rewards")}
        ${collectionTable(
          this.t("rankingRewards"),
          [this.t("position"), this.t("rewards")],
          [...groups].map(([range, items]) => [range, this.rewardList(items)]),
        )}
      </section>
    `;
  }

  /* ---------- schedule ---------- */
  private renderSchedule(season: ArenaSeason, selected: ArenaLeague) {
    const periods = arenaPeriods(season).filter((period) => this.scheduleAll || period.endAt > this.now);
    if (!arenaPeriods(season).length) return emptyState({ title: this.t("noSchedule"), icon: "calendar_view_week" });
    return html`
      <section class="surface stack arena-schedule">
        <div class="cluster">
          ${filterChip({ label: this.t("allPeriods"), selected: this.scheduleAll, onToggle: () => (this.scheduleAll = !this.scheduleAll) })}
        </div>
        ${collectionTable(
          this.t("schedule"),
          [
            this.t("period"),
            ...season.leagues.map(
              (league) => html`
                <button
                  type="button"
                  class="arena-schedule__band"
                  aria-pressed=${String(league.bandId === selected.bandId)}
                  @click=${() => this.select({ bandId: league.bandId })}
                >
                  ${
                    league.image
                      ? html`
                          <img src=${league.image} alt="" width="24" height="24" loading="lazy" />
                        `
                      : nothing
                  }
                  <span>${this.name(league.name)}</span>
                </button>
              `,
            ),
          ],
          periods.map((period) => [
            html`
              <span
                class="arena-period"
                aria-current=${period.startAt <= this.now && this.now < period.endAt ? "time" : nothing}
              >
                <span>${formatDate(this.locale, period.startAt, { time: true })}</span>
                <span>– ${formatDate(this.locale, period.endAt, { time: true })}</span>
              </span>
            `,
            ...period.rules.map((rule) => this.ruleMarks(rule, 22)),
          ]),
        )}
      </section>
    `;
  }

  /* ---------- songs ---------- */
  private renderSongs(season: ArenaSeason, league: ArenaLeague) {
    const { rule } = this.ruleNow(season, league);
    const songs = [...league.songs].sort((a, b) => Number(b.arenaPublishedAt) - Number(a.arenaPublishedAt));
    return html`
      <section class="surface stack">
        ${heading(this.name(league.name), "songs", { count: songs.length })}
        ${collectionTable(
          this.t("songs"),
          [this.t("song"), this.t("originalRule"), rule ? this.t("currentRule") : this.t("nextRule"), this.t("added")],
          songs.map((song) => {
            const effective = rule ? arenaSongRule(song, rule) : undefined;
            const published = Number(song.arenaPublishedAt);
            return [
              html`
                <a class="arena-song" href=${this.href("songs", String(song.musicId))}>
                  <img
                    src=${String(song.jacketThumbUrl || song.jacketUrl || "")}
                    alt=""
                    width="40"
                    height="40"
                    loading="lazy"
                  />
                  <span>${this.name(song.musicTitle)}</span>
                </a>
              `,
              this.ruleMarks(
                { musicType: Number(song.musicType), missions: (song.arenaMissions as number[]) || [0, 0, 0] },
                20,
              ),
              effective ? this.ruleMarks(effective, 20) : "—",
              published > this.now
                ? html`
                    <span class="arena-status" data-status="upcoming">${this.short(published)}</span>
                  `
                : formatDate(this.locale, published),
            ];
          }),
        )}
      </section>
    `;
  }

  /* ---------- ranks and rewards ---------- */
  private renderRanks(season: ArenaSeason, league: ArenaLeague) {
    const seasonRewards = new Map<string, ArenaReward[]>();
    for (const reward of season.seasonRewards) {
      const key = `${reward.from}–${reward.to}`;
      seasonRewards.set(key, [...(seasonRewards.get(key) ?? []), reward]);
    }
    const basePoints = (this.catalog?.basePoints ?? []).filter((row) => row.players === this.players);
    const tiers = [...new Set(basePoints.map((row) => row.tier))].sort((a, b) => a - b);
    return html`
      <div class="arena-grid">
        <section class="surface stack arena-wide">
          ${heading(this.t("thresholds"), "rewards", { count: league.ranks.length })}
          ${collectionTable(
            this.t("thresholds"),
            [this.t("rank"), this.t("points"), this.t("resetPoints"), this.t("promotionRewards")],
            [...league.ranks].reverse().map((rank) => [
              html`
                <span class="arena-rank">
                  ${this.rankIcon(rank.rank)}
                  <span>${this.name(rank.name)}</span>
                  ${
                    rank.startAt > this.now
                      ? html`
                          <small>${this.t("opens")} ${this.short(rank.startAt)}</small>
                        `
                      : nothing
                  }
                </span>
              `,
              rank.points.toLocaleString(this.locale),
              rank.resetPoints ? `−${rank.resetPoints.toLocaleString(this.locale)}` : this.t("resetKept"),
              this.rewardList(league.promotionRewards.filter((reward) => reward.rankId === rank.id)),
            ]),
            { numeric: true },
          )}
        </section>
        ${
          tiers.length
            ? html`
                <section class="surface stack arena-wide">
                  <div class="row row--between row--wrap">
                    ${heading(this.t("basePoints"), "stats")}
                    ${segmented({
                      label: this.t("players"),
                      value: String(this.players) as "2" | "3" | "4" | "5",
                      grow: false,
                      options: [2, 3, 4, 5].map((count) => ({
                        value: String(count) as "2" | "3" | "4" | "5",
                        label: this.t("playerCount", { count }),
                      })),
                      onSelect: (value) => (this.players = Number(value)),
                    })}
                  </div>
                  ${collectionTable(
                    this.t("basePoints"),
                    [
                      this.t("rank"),
                      ...Array.from({ length: this.players }, (_, index) => this.t("place", { place: index + 1 })),
                    ],
                    tiers.map((tier) => {
                      const sample = league.ranks.find((rank) => rank.rank === tier);
                      return [
                        html`
                          <span class="arena-rank">
                            ${this.rankIcon(tier)}
                            <span>${sample ? this.tierName(sample) : tier}</span>
                          </span>
                        `,
                        ...Array.from({ length: this.players }, (_, index) => {
                          const value = basePoints.find((row) => row.tier === tier && row.place === index + 1)?.points;
                          return value == null
                            ? "—"
                            : html`
                                <span class=${value < 0 ? "arena-negative" : ""}>
                                  ${new Intl.NumberFormat(this.locale, { signDisplay: "exceptZero" }).format(value)}
                                </span>
                              `;
                        }),
                      ];
                    }),
                    { numeric: true },
                  )}
                </section>
              `
            : nothing
        }
        <section class="surface stack">
          ${heading(this.t("dailyRewards"), "rewards", { count: season.dailyRewards.length })}
          ${collectionTable(
            this.t("dailyRewards"),
            [this.t("play"), this.t("rewards")],
            season.dailyRewards.map((reward, index) => [
              this.t("playNumber", { number: index + 1 }),
              this.rewardList([reward]),
            ]),
          )}
        </section>
        <section class="surface stack">
          ${heading(this.t("seasonRewards"), "rewards")}
          ${collectionTable(
            this.t("seasonRewards"),
            [this.t("points"), this.t("rewards")],
            [...seasonRewards].map(([range, rewards]) => [range, this.rewardList(rewards)]),
          )}
        </section>
        ${this.renderRankingRewards(season, league)}
        ${
          season.exchanges.length || season.events.length
            ? html`
                <section class="surface stack">
                  ${heading(this.t("related"), "content")}
                  <ul class="list">
                    ${[
                      ...season.exchanges.map((entry) => [entry, "exchange"] as const),
                      ...season.events.map((entry) => [entry, "events"] as const),
                    ].map(
                      ([entry, kind]) => html`
                        <li>
                          <a class="list-item list-item--interactive" href=${this.href(kind, String(entry.id))}>
                            <span class="list-item__leading">
                              ${
                                entry.image
                                  ? html`
                                      <img src=${String(entry.image)} alt="" width="56" height="28" loading="lazy" />
                                    `
                                  : icon(kind === "events" ? "event" : "storefront")
                              }
                            </span>
                            <span class="list-item__body">
                              <span class="list-item__headline">${this.name(entry.title)}</span>
                            </span>
                            <span class="list-item__trailing">${icon("chevron_right")}</span>
                          </a>
                        </li>
                      `,
                    )}
                  </ul>
                </section>
              `
            : nothing
        }
      </div>
    `;
  }

  /* ---------- rules ---------- */
  private renderRules(season: ArenaSeason, league: ArenaLeague) {
    const parameters = this.catalog?.parameters ?? {};
    const rows = RULES.filter((key) => parameters[key] != null);
    return html`
      <div class="arena-grid">
        ${this.renderEntry(season, league)}
        <section class="surface stack">
          ${heading(this.t("ruleValues"), "details")}
          <dl class="spec-list">
            <div>
              <dt>${this.t("seasonRewardBasis")}</dt>
              <dd>${this.t("seasonRewardBasisValue")}</dd>
            </div>
            <div>
              <dt>${this.t("rankScope")}</dt>
              <dd>${this.t("rankScopeValue")}</dd>
            </div>
            ${repeat(
              rows,
              (key) => key,
              (key) => html`
                <div>
                  <dt>${this.t(`parameters.${key}`)}</dt>
                  <dd>${this.t(`parameterValues.${key}`, { value: parameters[key]!.toLocaleString(this.locale) })}</dd>
                </div>
              `,
            )}
          </dl>
        </section>
      </div>
    `;
  }

  render() {
    if (this.phase === "loading") return loadingState(clientText(this.locale, "common.states.loading"));
    if (this.phase === "error")
      return errorState(
        clientText(this.locale, "common.states.unavailable"),
        clientText(this.locale, "common.actions.retry"),
        () => void this.load(),
      );
    const season = this.season();
    if (!season) return emptyState({ title: this.t("noSchedule") });
    const league = this.league(season);
    const panels: Record<Tab, () => unknown> = {
      overview: () => this.renderOverview(season, league),
      ranking: () => this.renderRanking(season, league),
      schedule: () => this.renderSchedule(season, league),
      songs: () => this.renderSongs(season, league),
      ranks: () => this.renderRanks(season, league),
      rules: () => this.renderRules(season, league),
    };
    return html`
      <div class="page arena-page stack stack--loose">
        ${this.renderHero(season, league)} ${this.renderTabs()}
        <div class="arena-panel" id="arena-panel" role="tabpanel" aria-labelledby=${`arena-tab-${this.tab}`}>
          ${panels[this.tab]()}
        </div>
      </div>
    `;
  }
}
if (!customElements.get("arena-workspace")) customElements.define("arena-workspace", ArenaWorkspace);
