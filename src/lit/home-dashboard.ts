import { communityStickerPreview } from "../lib/community-markup";
import { renderLazyEntityCommentActivity } from "./views/entity-comment-activity-lazy";
import "../styles/home-community-comments.css";
import { CommunityReactions } from "../lib/community-reaction";
import { navigateDetailPage } from "../lib/detail-navigation";
import { communityRecommendationItems, isEntityCommentRecommendation, entityCommentRecommendationHref } from "../lib/community-recommendations";
import { initializeI18nClient } from "../i18n/client";
import { catalogLookupKeys } from "../i18n/keys";
import type { Catalog, MessageParams } from "@haneoka/i18n";
import { readCommunityViewer, type CommunityViewer } from "../lib/community-viewer";
import { resourceCollectionHref, entityHref } from "../lib/resource-route";
import { readReleaseServer } from "../lib/release-server";
import { announcementPath } from "../lib/announcements";
import { announcementText, announcementRow } from "./shared/announcement";
import { fetchAnnouncements, type Announcement } from "../lib/announcements";
import "../styles/announcements.css";
import type { Locale } from "../i18n/locales";
import { clientText } from "../i18n/client";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { variants as githubVariants } from "@thesvg/icons/github";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { SONOLUS_SERVER_LINK } from "../config/sonolus";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { RequestScope } from "../lib/request-scope";
import {
  catalogUrl,
  fetchJson,
  formatList,
  localizedText,
  preferredLocale,
  recordValues,
  uiText,
  type JsonRecord,
} from "./shared/catalog";
import { tile } from "./ui/tile";
import { catalogCharacterRelationship } from "./shared/catalog-relationships";
import { serverAvailabilityImage, serverAvailabilityLabel } from "./shared/server-availability";
import {
  crossServerDisplayRow,
  crossServerDetail,
  type CrossCatalogDTO,
  type CrossCatalogIdentity,
  type CrossCatalogEntry,
  type CrossCatalogResource,
  type OfficialCatalogServer,
} from "../lib/cross-server/catalog";
import { localizedContent, localizedList } from "./ui/localized-content";
import { eventArtwork } from "./ui/event-artwork";
import { liveMusicTypeMark, songTile } from "./shared/song-tile";
import { LazyImages, localeTaggedCandidates, localizedAssetUrl, nextImageCandidate } from "./ui/lazy-images";
import { segmented } from "./ui/controls";
import {
  BIRTHDAY_UTC_OFFSET,
  BIRTHDAY_DAY_MS,
  birthdayDayStart,
  nextBirthdayAt,
  characterBirthdayOccurrence,
  birthdayCharacterChoices,
  birthdayPeriodMatches,
  birthdayRefreshAt,
  type BirthdayGachaPeriod,
} from "../lib/home-birthday";

type ModuleId = "songs" | "cards" | "birthdays" | "community" | "news" | "fanInfo";
export interface HomeFanInfo {
  status: "ready" | "empty" | "unavailable";
  entries: Array<{
    title: string;
    href: string;
    summary?: string;
    image?: string;
    category?: string;
    publishedAt?: number;
    eventDate?: string;
    allDay?: boolean;
    eventStartAtMs?: number;
    eventStartLocal?: string;
    venue?: string;
  }>;
}
export interface HomeSeed {
  server: import("../lib/release-server").ReleaseServer;
  releaseId: string;
  documents: Record<string, JsonRecord>;
  announcements: Announcement[];
  profiles: { characters: JsonRecord[]; cast: JsonRecord[] };
  fanInfo?: HomeFanInfo;
  crossServerCatalogs?: Partial<Record<Exclude<CrossCatalogResource, "events">, CrossCatalogDTO>>;
  serverMarks?: Partial<
    Record<OfficialCatalogServer, { identity: CrossCatalogIdentity; marks: Record<string, string> }>
  >;
}
type Birthday = {
  key: string;
  color: string;
  href: string;
  image: string;
  kind: "character" | "cast";
  name: string;
  /** For cast birthdays: the characters this person voices. */
  voiceRoles: Array<{ name: unknown; href?: string; image: string }>;
  nextAt: number;
  retainedUntil: number;
  announced: boolean;
  external: boolean;
  characterId: number | null;
  bandName: string;
  bandIcon: string;
};
/** A rotating window (gacha banner, event, live) the game is showing right now. */
type Spotlight = {
  id: string;
  title: string;
  image: string;
  href: string;
  startAt: number;
  endAt: number;
  details: JsonRecord;
};
/** One slide of the home carousel: the game's own MasterHomeBanner rows. */
type Banner = {
  id: string;
  image: string;
  href: string;
  endAt: number;
};

const MODULES: ModuleId[] = ["birthdays", "news", "cards", "songs", "community", "fanInfo"];
const PROFILE_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const STORAGE_KEY = "haneoka:home-layout:v6";
/* MasterBand colours for the character-profile fallback (profiles use slugs, not ids). */
const PROFILE_BAND_SEED: Record<string, string> = {
  mygo: "var(--md-ref-band-1)",
  avemujica: "var(--md-ref-band-2)",
  yumemita: "var(--md-ref-band-3)",
  millsage: "var(--md-ref-band-4)",
  "ikka-dumb-rock": "var(--md-ref-band-5)",
};
/** Fixed in-repo avatars: the birthday list never depends on release assets. */
const CHARACTER_AVATAR = (id: unknown) => `/images/avatars/characters/${String(id || "")}.png`;
const CAST_AVATAR = (id: string) => `/images/avatars/cast/${id}.jpg?v=official-20261002`;
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size} aria-hidden="true">
    <use href=${`/icons.svg#${name}`}></use>
  </svg>
`;
const values = (value: unknown, key?: string): JsonRecord[] =>
  key ? recordValues((value as JsonRecord | undefined)?.[key]) : recordValues(value);
const timestamp = (value: unknown) =>
  Array.isArray(value)
    ? Math.max(0, ...value.map(Number).filter((entry) => Number.isFinite(entry) && entry > 0))
    : Number(value) || 0;
const hideBrokenImage = (event: Event) => {
  const image = event.currentTarget as HTMLImageElement;
  image.hidden = true;
};
let homeActionSequence = 0;
const githubMark = githubVariants.mono.replace(/^<svg[^>]*>|<\/svg>$/gu, "").replace(/<title>.*?<\/title>/u, "");

export class HomeDashboard extends LitElement {
  static properties = {
    locale: { type: String },
    server: { type: String },
    phase: { state: true },
    songs: { state: true },
    cards: { state: true },
    announcements: { state: true },
    announcementsPhase: { state: true },
    fanInfo: { state: true },
    characters: { state: true },
    banners: { state: true },
    events: { state: true },
    counts: { state: true },
    posts: { state: true },
    communityCommentError: { state: true },
    communityPhase: { state: true },
    order: { state: true },
    hiddenModules: { state: true },
    slide: { state: true },
    songLimit: { state: true },
    birthdaySelection: { state: true },
  };
  declare locale: string;
  declare server: HomeSeed["server"];
  declare phase: "loading" | "ready" | "error";
  declare songs: JsonRecord[];
  declare cards: JsonRecord[];
  declare announcements: Announcement[];
  declare announcementsPhase: "loading" | "ready" | "error";
  declare fanInfo: HomeFanInfo;
  private birthdayGacha: JsonRecord[] = [];
  private birthdayGachaServer?: HomeSeed["server"];
  private birthdayStories: Record<string, JsonRecord[]> = {};
  private crossServerCatalogs: NonNullable<HomeSeed["crossServerCatalogs"]> = {};
  private seed?: HomeSeed;
  private catalogRequests = new RequestScope();
  private liveRequests = new RequestScope();
  private communityViewer?: CommunityViewer;
  declare characters: JsonRecord[];
  declare bands: JsonRecord[];
  private marks = new Map<string, string>();
  declare banners: Banner[];
  declare events: Spotlight[];
  declare counts: Record<string, number>;
  declare posts: JsonRecord[];
  declare communityCommentError: string;
  private communityReactions = new CommunityReactions();
  private communityLifetime = new AbortController();
  declare communityPhase: "loading" | "ready" | "error";
  declare order: ModuleId[];
  declare hiddenModules: Record<string, boolean>;
  declare slide: number;
  /** Candidate songs for the single row; available width chooses its visible prefix. */
  declare songLimit: number;
  declare private birthdaySelection: string;
  private readonly appBarOwner = `home-dashboard-${++homeActionSequence}`;
  private characterProfiles: JsonRecord[] = [];
  private castProfiles: JsonRecord[] = [];
  /** Song tiles defer their artwork as data-src; this promotes them. */
  private lazyImages = new LazyImages({ candidates: (source) => localeTaggedCandidates(source, this.locale) });
  private fitObserver?: ResizeObserver;
  private fitFrame = 0;
  private fitObserved = new Set<Element>();
  private slideTimer?: number;
  private clockTimer?: number;
  private visibilityListener = () => {
    if (document.visibilityState === "visible") this.requestUpdate();
  };
  /** False only for the invisible wrap jump between the clone and slide 0. */
  private slideAnimated = true;
  private localeListener = (event: Event) => {
    const locale = String((event as CustomEvent).detail || preferredLocale());
    const changed = locale !== this.locale;
    this.locale = locale;
    this.syncAction();
    if (changed) void this.loadLivePanels();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.server = "intl";
    this.phase = "loading";
    this.songs = [];
    this.cards = [];
    this.announcements = [];
    this.announcementsPhase = "loading";
    this.fanInfo = { status: "unavailable", entries: [] };
    this.characters = [];
    this.bands = [];
    this.banners = [];
    this.events = [];
    this.counts = {};
    this.posts = [];
    this.communityCommentError = "";
    this.communityPhase = "loading";
    this.order = [...MODULES];
    this.hiddenModules = {};
    this.slide = 0;
    this.songLimit = 24;
    this.birthdaySelection = "";
  }
  createRenderRoot() {
    return this;
  }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    if (this.communityLifetime.signal.aborted) this.communityLifetime = new AbortController();
    const seed = this.querySelector<HTMLScriptElement>("script[data-home-seed]");
    if (seed) {
      try {
        this.prepareHome(JSON.parse(seed.textContent || "null"), this.locale);
      } catch {
        /* Keep the independent catalog fallback. */
      }
    }
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.locale = preferredLocale(this.locale);
    this.restoreLayout();
    addEventListener("haneoka:locale-ready", this.localeListener);
    document.addEventListener("visibilitychange", this.visibilityListener);
    if (!this.seed || this.seed.server !== readReleaseServer()) {
      void this.load();
      void this.loadProfiles();
    }
    window.addEventListener("haneoka:session-changed", this.onCommunityContextChange);
    window.addEventListener("haneoka:community-posts-changed", this.onCommunityContextChange);
    window.addEventListener("haneoka:community-forums-changed", this.onCommunityContextChange);
    window.addEventListener("focus", this.onCommunityFocus);
    void this.loadLivePanels();
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) this.startAuto();
    queueMicrotask(() => this.mountAction());
    this.fitObserver = new ResizeObserver(() => this.queueFit());
    void document.fonts?.ready.then(() => this.queueFit());
  }
  disconnectedCallback() {
    this.communityLifetime.abort();
    this.communityReactions.clear();
    window.removeEventListener("haneoka:session-changed", this.onCommunityContextChange);
    window.removeEventListener("haneoka:community-posts-changed", this.onCommunityContextChange);
    window.removeEventListener("haneoka:community-forums-changed", this.onCommunityContextChange);
    window.removeEventListener("focus", this.onCommunityFocus);
    this.disposeSongDisplay?.();
    if (this.slideTimer) window.clearInterval(this.slideTimer);
    if (this.clockTimer) window.clearTimeout(this.clockTimer);
    this.clockTimer = undefined;
    document.removeEventListener("visibilitychange", this.visibilityListener);
    removeEventListener("haneoka:locale-ready", this.localeListener);
    clearAppBarActions(this.appBarOwner);
    this.lazyImages.disconnect();
    this.catalogRequests.cancel();
    this.liveRequests.cancel();
    this.fitObserver?.disconnect();
    this.fitObserved.clear();
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = 0;
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    if (
      this.birthdaySelection &&
      !birthdayCharacterChoices(this.birthdays().filter((item) => item.kind === "character")).some(
        (item) => this.birthdayChoiceKey(item) === this.birthdaySelection,
      )
    )
      this.birthdaySelection = "";
    this.scheduleBirthdayRefresh();
    if (changed.has("locale")) { this.syncAction(); this.communityReactions.clear(); this.communityMessages = undefined; }
    this.lazyImages.observe(this);
    for (const element of this.fitObserved)
      if (!this.contains(element)) {
        this.fitObserver?.unobserve(element);
        this.fitObserved.delete(element);
      }
    for (const element of this.querySelectorAll(".home-card"))
      if (!this.fitObserved.has(element)) {
        this.fitObserved.add(element);
        this.fitObserver?.observe(element);
      }
    this.queueFit();
  }
  private scheduleBirthdayRefresh() {
    if (this.clockTimer) window.clearTimeout(this.clockTimer);
    if (!this.isConnected) return;
    const now = Date.now();
    this.clockTimer = window.setTimeout(
      () => {
        this.clockTimer = undefined;
        this.visibilityListener();
      },
      Math.max(1, birthdayRefreshAt(now, this.birthdayRecruitments()) - now),
    );
  }
  private queueFit() {
    if (!this.isConnected || this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fitContent();
    });
  }
  private fitContent() {
    for (const list of this.querySelectorAll<HTMLElement>("[data-home-fit]")) {
      list.dataset.fitReady = "";
      const style = getComputedStyle(list),
        gap = parseFloat(style.rowGap) || 0;
      const available =
        list.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      let used = 0;
      let full = false;
      for (const [index, child] of [...list.children].entries()) {
        const item = child as HTMLElement;
        item.hidden = false;
        const needed = item.getBoundingClientRect().height + (index ? gap : 0);
        full ||= index > 0 && used + needed > available + 0.5;
        item.hidden = full;
        if (!item.hidden) used += needed;
      }
    }
    for (const list of this.querySelectorAll<HTMLElement>("[data-home-tiles], [data-home-avatars]")) {
      const style = getComputedStyle(list),
        gap = parseFloat(style.columnGap) || 0;
      const available = list.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const minimum = parseFloat(style.getPropertyValue("--home-item-min")) || 132;
      const count = Math.min(
        list.children.length,
        Math.max(list.hasAttribute("data-home-tiles") ? 2 : 1, Math.floor((available + gap) / (minimum + gap))),
      );
      list.dataset.fitReady = "";
      list.style.setProperty("--home-item-count", String(count));
      [...list.children].forEach((child, index) => {
        (child as HTMLElement).hidden = index >= count;
      });
    }
  }
  protected override update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      this.removeAttribute("data-prerendered");
      this.replaceChildren();
    }
    super.update(changed);
  }
  prepareHome(seed: HomeSeed, locale: string) {
    if (this.seed?.server !== seed.server || this.seed?.releaseId !== seed.releaseId) this.birthdaySelection = "";
    this.catalogRequests.cancel();
    this.liveRequests.cancel();
    this.locale = locale;
    this.seed = seed;
    this.server = seed.server;
    this.crossServerCatalogs = Object.fromEntries(
      Object.entries(seed.crossServerCatalogs || {}).filter(
        ([resource, dto]) =>
          dto.schema === "haneoka-cross-server-catalog-v1" &&
          dto.resource === resource &&
          dto.selectedServer === seed.server &&
          dto.identities[dto.selectedServer]?.releaseId === seed.releaseId,
      ),
    );
    this.applyDocuments(seed.documents);
    this.announcements = seed.announcements;
    this.announcementsPhase = "ready";
    this.fanInfo = seed.fanInfo || { status: "unavailable", entries: [] };
    this.characterProfiles = seed.profiles.characters;
    this.castProfiles = seed.profiles.cast;
  }
  private sourceServer() {
    return this.seed?.server ?? this.server;
  }
  private rowServer(row: JsonRecord): HomeSeed["server"] {
    return (row.homeSourceServer as HomeSeed["server"] | undefined) || this.sourceServer();
  }
  private catalogRows(resource: "cards" | "support-cards" | "songs", fallback: unknown): JsonRecord[] {
    const catalog = this.crossServerCatalogs[resource];
    return catalog
      ? catalog.entries.map((entry) => ({
          ...crossServerDisplayRow(entry),
          homeCatalogEntry: entry,
          homeSourceServer: entry.displayServer,
        }))
      : values(fallback);
  }
  private sameVariant(entry: CrossCatalogEntry, row: JsonRecord) {
    const server = this.rowServer(row) as OfficialCatalogServer;
    const source = (row.homeCatalogEntry as CrossCatalogEntry | undefined)?.perServer[server]?.identity;
    const target = entry.perServer[server]?.identity;
    return !source || (!!target && source.releaseId === target.releaseId && source.sourceId === target.sourceId);
  }
  private relationshipCharacter(id: number, row: JsonRecord) {
    const server = this.rowServer(row);
    const entry = this.crossServerCatalogs.characters?.entries.find(
      (entry) =>
        this.sameVariant(entry, row) &&
        Number(entry.perServer[server as OfficialCatalogServer]?.row.characterId) === id,
    );
    return entry
      ? crossServerDetail(entry, server as OfficialCatalogServer).row
      : (server === this.sourceServer()
          ? this.characters.find((person) => Number(person.characterId) === id)
          : undefined) || values(row.characterDetails).find((person) => Number(person.characterId) === id);
  }
  private relationshipBand(id: unknown, row: JsonRecord) {
    const server = this.rowServer(row);
    const entry = this.crossServerCatalogs.bands?.entries.find(
      (entry) =>
        this.sameVariant(entry, row) &&
        Number(entry.perServer[server as OfficialCatalogServer]?.row.bandId) === Number(id),
    );
    return entry
      ? crossServerDetail(entry, server as OfficialCatalogServer).row
      : server === this.sourceServer()
        ? this.bands.find((band) => Number(band.bandId) === Number(id))
        : undefined;
  }
  private marksFor(row?: JsonRecord) {
    const server = row ? this.rowServer(row) : this.sourceServer();
    if (server === this.sourceServer()) return this.marks;
    const document = this.seed?.serverMarks?.[server as OfficialCatalogServer];
    const variant = (row?.homeCatalogEntry as CrossCatalogEntry | undefined)?.perServer[server as OfficialCatalogServer]
      ?.identity;
    if (
      !document ||
      !variant ||
      document.identity.server !== server ||
      document.identity.releaseId !== variant.releaseId ||
      document.identity.sourceId !== variant.sourceId
    )
      return new Map<string, string>();
    return new Map(
      Object.entries(document.marks).map(([logical, path]) => [
        logical,
        `/runtime/${server}/${path.replace(/^runtime\//u, "")}`,
      ]),
    );
  }
  private exclusiveMark(row: JsonRecord) {
    const entry = row.homeCatalogEntry as CrossCatalogEntry | undefined;
    return entry?.exclusive
      ? {
          image: serverAvailabilityImage(entry.exclusive),
          label: serverAvailabilityLabel([entry.exclusive], this.locale),
        }
      : null;
  }
  /** The live music-type emblem, from the same source as its catalogue row. */
  private attributeMark(musicType: unknown, row?: JsonRecord) {
    return liveMusicTypeMark(this.marksFor(row), musicType);
  }

  /* ---------- copy ---------- */
  private text(key: string, fallback: string) {
    return clientText(this.locale, key, clientText(this.locale, `homePage.${key}`, fallback));
  }
  private count(value: number) {
    return value.toLocaleString(this.locale);
  }

  /* ---------- top app bar action ---------- */
  private syncAction() {
    if (!this.isConnected) return;
    const label = this.text("customizeLayout", "Customize layout");
    const docs = this.text("documentation", "API documentation");
    setAppBarActions(
      this.appBarOwner,
      html`
        <a
          class="icon-button"
          href=${SONOLUS_SERVER_LINK}
          aria-label="Sonolus"
          title="Sonolus"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/images/sonolus-icon.png" width="24" height="24" alt="" />
        </a>
        <a
          class="icon-button"
          href=${`https://docs.haneoka.org/${this.locale === "zh-CN" || this.locale === "zh-TW" ? "zh-cn/" : ""}`}
          aria-label=${docs}
          title=${docs}
          target="_blank"
          rel="noopener noreferrer"
        >
          ${icon("description", 24)}
        </a>
        <a
          class="icon-button"
          href="https://github.com/haneoka-gakuen/haneoka"
          aria-label="GitHub"
          title="GitHub"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg class="material-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            ${unsafeSVG(githubMark)}
          </svg>
        </a>
        <button
          class="icon-button"
          type="button"
          aria-label=${label}
          title=${label}
          @click=${() => this.querySelector<HTMLDialogElement>(".home-layout-dialog")?.showModal()}
        >
          ${icon("dashboard_customize", 24)}
        </button>
      `,
      this,
    );
  }
  private mountAction() {
    this.syncAction();
  }

  /* ---------- data ---------- */
  private applyDocuments(documents: Record<string, JsonRecord>) {
    const now = Date.now();
    const resources = (documents.summary?.resources || {}) as Record<string, JsonRecord>;
    this.counts = Object.fromEntries(Object.entries(resources).map(([key, entry]) => [key, Number(entry?.count) || 0]));
    this.songs = this.catalogRows("songs", documents.songs);
    this.characters = values(documents.characters);
    this.bands = values(documents.bands);
    this.cards = [
      ...this.catalogRows("cards", documents.cards).map((entry) => ({ ...entry, homeKind: "cards" })),
      ...this.catalogRows("support-cards", documents["support-cards"]).map((entry) => ({
        ...entry,
        homeKind: "support-cards",
      })),
    ];
    this.birthdayGacha = values(documents.gacha, "entries");
    this.birthdayGachaServer = this.sourceServer();
    const birthdayStories = documents.stories?.birthdayStories;
    this.birthdayStories =
      birthdayStories && typeof birthdayStories === "object" && !Array.isArray(birthdayStories)
        ? Object.fromEntries(Object.entries(birthdayStories).map(([id, rows]) => [id, Array.isArray(rows) ? rows : []]))
        : {};
    this.marks.clear();
    for (const [logical, path] of Object.entries(documents["ui-marks"] || {}))
      if (typeof path === "string")
        this.marks.set(logical, `/runtime/${this.sourceServer()}/${path.replace(/^runtime\//u, "")}`);
    this.banners = this.carousel(documents["home-banners"], now);
    this.events = values(documents.events, "entries").map((entry) => this.spotlightOf(entry, "events"));
    this.phase = "ready";
  }
  private async load() {
    const signal = this.catalogRequests.begin();
    const server = readReleaseServer();
    this.seed = undefined;
    this.crossServerCatalogs = {};
    this.server = server;
    this.birthdaySelection = "";
    this.birthdayGacha = [];
    this.birthdayGachaServer = undefined;
    this.phase = "loading";
    const keys = [
      "catalog/summary",
      "songs",
      "characters",
      "home-banners",
      "events",
      "bands",
      "ui-marks",
      "cards",
      "support-cards",
      "gacha",
      "stories",
    ];
    const results = await Promise.allSettled(
      keys.map((key) => fetchJson<JsonRecord>(catalogUrl(key, "", server), { signal })),
    );
    if (!this.isConnected || !this.catalogRequests.current(signal) || server !== readReleaseServer()) return;
    const documents = Object.fromEntries(
      results.flatMap((result, index) =>
        result.status === "fulfilled"
          ? [[keys[index] === "catalog/summary" ? "summary" : keys[index], result.value]]
          : [],
      ),
    );
    this.seed = undefined;
    this.applyDocuments(documents);
    if (results.every((result) => result.status === "rejected")) this.phase = "error";
  }
  private async loadLivePanels() {
    const server = this.sourceServer();
    const locale = this.locale;
    const signal = this.liveRequests.begin();
    const reactionMark = this.communityReactions.mark();
    const currentPanel = () => this.isConnected && this.liveRequests.current(signal) && server === this.sourceServer() && locale === this.locale;
    const newsWork = fetchAnnouncements(server, AbortSignal.any([signal, AbortSignal.timeout(15000)]), locale)
      .then((news) => {
        if (!currentPanel()) return;
        this.announcements = news.announcements.slice(0, 5);
        this.announcementsPhase = "ready";
      })
      .catch(() => { if (currentPanel()) this.announcementsPhase = this.announcements.length ? "ready" : "error"; });
    try {
      const viewer = await readCommunityViewer(signal);
      if (!currentPanel()) return;
      if (this.communityViewer && this.communityViewer.realm !== viewer.realm) this.posts = [];
      this.communityViewer = viewer;
      const posts = await fetchJson<JsonRecord>("/api/v1/community/posts?" + new URLSearchParams({limit:"5",scope:"recommended",server,locale}), {signal,credentials:"same-origin",cache:"no-store"});
      const current = await readCommunityViewer(signal);
      if (!currentPanel()) return;
      if (current.realm !== viewer.realm) {
        this.posts = [];
        this.communityViewer = current;
        this.communityPhase = "error";
        return;
      }
      const next = communityRecommendationItems(posts);
      if (next.some(isEntityCommentRecommendation)) {
        const client = initializeI18nClient(), version = client.version;
        const messages = await client.ensure(locale as Parameters<typeof client.ensure>[0], ["common", "community"], signal);
        if (!currentPanel() || client.version !== version) return;
        this.communityMessages = messages;
      }
      this.posts = next.map((entry) => {
        if (!isEntityCommentRecommendation(entry)) return entry;
        const comment = entry.comment;
        if (comment.viewer.canLike === false) { this.communityReactions.forget(comment.id); return entry; }
        const state = this.communityReactions.merge(comment.id, {active:Boolean(comment.viewer.liked),likeCount:Number(comment.likeCount||0)}, reactionMark);
        return {...entry,comment:{...comment,likeCount:state.likeCount,viewer:{...comment.viewer,liked:state.active}}};
      });
      this.communityPhase = "ready";
    } catch (error) {
      if (!currentPanel()) return;
      this.posts = [];
      this.communityPhase = "error";
    } finally { await newsWork; }
  }
  private readonly onCommunityContextChange = () => {
    this.liveRequests.cancel();
    this.communityReactions.clear();
    this.communityCommentError = "";
    this.posts = [];
    this.communityViewer = undefined;
    this.communityPhase = "loading";
    void this.loadLivePanels();
  };
  private readonly onCommunityFocus = () => {
    if (this.isConnected && !document.hidden) void this.loadLivePanels();
  };
  private spotlightOf(entry: JsonRecord, resource: string): Spotlight {
    return {
      id: String(entry.id || ""),
      title: localizedText(entry.title, this.locale) || "—",
      image: String(entry.image || ""),
      href: resource ? `/catalog/${resource}?entry=${String(entry.id || "")}` : "",
      startAt: timestamp(entry.startAt),
      endAt: timestamp(entry.endAt),
      details: entry,
    };
  }
  /** Active home banners in the game's own display order. */
  private carousel(value: unknown, now: number): Banner[] {
    return values(value, "entries")
      .map<Banner>((entry) => ({
        id: String(entry.id || ""),
        image: String(entry.image || ""),
        href: String(entry.href || ""),
        endAt: timestamp(entry.endAt),
      }))
      .filter((entry) => entry.image && (!entry.endAt || entry.endAt >= now))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .sort((a, b) => a.endAt - b.endAt);
  }
  /** The carousel keeps a clone of the first slide at the tail: advancing off
   the last slide lands on it, then an unanimated jump rewrites position 0 —
   an endless belt rather than a snap backwards. */
  private startAuto() {
    this.stopAuto();
    this.slideTimer = window.setInterval(() => {
      if (this.banners.length > 1) this.step(1);
    }, 6000);
  }
  private stopAuto() {
    if (this.slideTimer) window.clearInterval(this.slideTimer);
    this.slideTimer = undefined;
  }
  private step(delta: number) {
    const total = this.banners.length;
    if (!total) return;
    this.slideAnimated = true;
    // Previous from the head: hop invisibly onto the tail clone, then step.
    if (delta < 0 && this.slide === 0) {
      this.slideAnimated = false;
      this.slide = total;
      requestAnimationFrame(() => {
        this.slideAnimated = true;
        this.slide = total - 1;
      });
      return;
    }
    this.slide += delta;
  }
  /** After any update, an arrival on the tail clone rewrites to slide 0. */
  protected carouselWrap() {
    if (this.banners.length && this.slide > this.banners.length - 1) {
      requestAnimationFrame(() => {
        this.slideAnimated = false;
        this.slide = 0;
      });
    }
  }
  private async loadProfiles() {
    const [characters, cast] = await Promise.all([import("../data/characterProfiles"), import("../data/castProfiles")]);
    if (!this.isConnected) return;
    this.characterProfiles = characters.characterProfiles as unknown as JsonRecord[];
    this.castProfiles = cast.castProfiles as unknown as JsonRecord[];
    this.requestUpdate();
  }

  /* ---------- layout preferences ---------- */
  private restoreLayout() {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      const state = JSON.parse(
        current ||
          localStorage.getItem("haneoka:home-layout:v5") ||
          localStorage.getItem("haneoka:home-layout:v4") ||
          "null",
      );
      if (
        Array.isArray(state?.order) &&
        new Set(state.order).size === state.order.length &&
        state.order.every((id: string) => (MODULES as string[]).includes(id)) &&
        MODULES.filter((id) => id !== "fanInfo").every((id) => state.order.includes(id))
      ) {
        this.order = [...state.order, ...MODULES.filter((id) => !state.order.includes(id))];
      }
      if (state?.hidden && typeof state.hidden === "object" && !Array.isArray(state.hidden))
        this.hiddenModules = state.hidden;
      if (!current) this.order = this.informationOrder(this.order);
    } catch {
      // Storage unavailable; defaults stay in effect.
    }
  }
  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: this.order, hidden: this.hiddenModules }));
    } catch {
      // Layout changes last for this visit only.
    }
  }
  private informationOrder(order: ModuleId[]): ModuleId[] {
    const rest: ModuleId[] = order.filter((id) => id !== "community" && id !== "fanInfo");
    const position = Math.max(rest.indexOf("cards"), rest.indexOf("songs")) + 1;
    rest.splice(position, 0, "community", "fanInfo");
    return rest;
  }
  private move(id: ModuleId, delta: number) {
    if (!this.canMove(id, delta)) return;
    const order = [...this.order],
      from = order.indexOf(id),
      to = from + delta;
    [order[from], order[to]] = [order[to]!, order[from]!];
    this.order = order;
    this.persist();
  }
  private canMove(id: ModuleId, delta: number) {
    const from = this.order.indexOf(id),
      to = from + delta;
    return from >= 0 && to >= 0 && to < this.order.length;
  }
  private toggle(id: ModuleId) {
    this.hiddenModules = { ...this.hiddenModules, [id]: !this.hiddenModules[id] };
    this.persist();
  }
  private reset() {
    this.order = [...MODULES];
    this.hiddenModules = {};
    this.persist();
  }

  /* ---------- derived ---------- */
  private formatDate(value: number | string, short = false, timeZone?: string) {
    const date = new Date(typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat(
          this.locale,
          short
            ? { month: "short", day: "numeric", timeZone }
            : { year: "numeric", month: "short", day: "numeric", timeZone },
        ).format(date);
  }
  private songTitle(song: JsonRecord) {
    return songTitle(song, this.locale).text;
  }
  /** "2天13小时"-style spans, from milliseconds. */
  private spanText(ms: number) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const day = (value: number) => this.text("spanDays", "{count}d").replace("{count}", this.count(value));
    const hour = (value: number) => this.text("spanHours", "{count}h").replace("{count}", this.count(value));
    if (days >= 1) return hours ? `${day(days)} ${hour(hours)}` : day(days);
    if (hours >= 1) return hour(hours);
    return this.text("spanMinutes", "{count}m").replace("{count}", this.count(minutes));
  }
  /** The event card names its moment relatively — "ends in …", "starts in
   *  …", "ended … ago" — never as a full date range. */
  private eventPhrase(startAt: number, endAt: number) {
    const now = Date.now();
    if (startAt > now) return this.countdown(startAt, false);
    if (endAt && endAt >= now) return this.countdown(endAt, true);
    if (endAt) return this.text("endedAgo", "Ended {time} ago").replace("{time}", this.spanText(now - endAt));
    return this.countdown(startAt, false);
  }
  private countdown(at: number, ending: boolean) {
    const span = this.spanText(at - Date.now());
    return (ending ? this.text("endsIn", "Ends in {time}") : this.text("startsIn", "Starts in {time}")).replace(
      "{time}",
      span,
    );
  }
  /** Days since/until a release, e.g. "3 天前上线"; a release inside the
   *  next day counts down in hours and minutes. */
  private releaseLabel(at: number) {
    if (!at) return "";
    const remaining = at - Date.now();
    const days = Math.round(remaining / 86400000);
    if (days === 0) {
      if (remaining > 0) return this.text("releasesIn", "Added in {time}").replace("{time}", this.spanText(remaining));
      return this.text("releasedToday", "Added today");
    }
    const span = this.text("spanDays", "{count}d").replace("{count}", this.count(Math.abs(days)));
    return (
      days < 0 ? this.text("releasedAgo", "Added {time} ago") : this.text("releasesIn", "Added in {time}")
    ).replace("{time}", span);
  }
  /** The event card: the in-game event ending soonest, or the next to begin. */
  private featuredEvent(): { entry: Spotlight; resource: string; ending: boolean } | null {
    const now = Date.now();
    const ongoing = this.events
      .filter((entry) => entry.startAt <= now && entry.endAt && entry.endAt >= now)
      .sort((a, b) => a.endAt - b.endAt)[0];
    if (ongoing) return { entry: ongoing, resource: "events", ending: true };
    const upcoming = this.events.filter((entry) => entry.startAt > now).sort((a, b) => a.startAt - b.startAt)[0];
    return upcoming ? { entry: upcoming, resource: "events", ending: false } : null;
  }
  private characterFor(slug: string, names: readonly string[]) {
    const normalized = names.map((name) => name.replace(/[\s・]/g, "").normalize("NFKC"));
    return this.characters.find(
      (character) =>
        character.slug === slug ||
        (Array.isArray(character.characterName) &&
          character.characterName.some((name) =>
            normalized.includes(
              String(name)
                .replace(/[\s・]/g, "")
                .normalize("NFKC"),
            ),
          )),
    );
  }
  private birthdays(): Birthday[] {
    const now = Date.now(),
      periods = this.birthdayRecruitments();
    const index = Math.max(0, PROFILE_LOCALES.indexOf(this.locale));
    const characters = this.characterProfiles.flatMap<Birthday>((profile) => {
      const birthdays = profile.birthday as string[] | undefined,
        names = profile.name as string[] | undefined;
      const match = birthdays?.[0]?.match(/^(\d{1,2})月(\d{1,2})日$/);
      if (!match || !names) return [];
      const catalog = this.characterFor(String(profile.slug || ""), names);
      const band = this.bands.find((entry) => Number(entry.bandId) === Number(catalog?.bandId));
      return [
        {
          color: String(catalog?.colorCode || PROFILE_BAND_SEED[String(profile.band)] || "var(--md-sys-color-primary)"),
          ...characterBirthdayOccurrence(
            Number(match[1]),
            Number(match[2]),
            catalog ? Number(catalog.characterId) : null,
            periods,
            this.sourceServer(),
            now,
          ),
          external: !catalog,
          href: catalog
            ? entityHref({
                server: this.sourceServer(),
                locale: this.locale as Locale,
                kind: "characters",
                id: String(catalog.characterId),
              })
            : "#",
          image: catalog
            ? String(catalog.faceImage || catalog.thumbnailImage || CHARACTER_AVATAR(catalog.characterId))
            : "",
          kind: "character",
          key: `character:${String(profile.id || profile.slug)}`,
          name: names[index] || names[0],
          voiceRoles: [],
          characterId: catalog ? Number(catalog.characterId) : null,
          bandName: localizedText(band?.bandName || profile.bandName, this.locale),
          bandIcon: String(band?.icon || ""),
        },
      ];
    });
    const cast = this.castProfiles.flatMap<Birthday>((person) => {
      const birthday = (person.birthday as JsonRecord | undefined)?.value as JsonRecord | undefined;
      if (!birthday) return [];
      const slugs = person.characterSlugs as string[] | undefined,
        personNames = person.name as string[] | undefined;
      const profiles = this.characterProfiles.filter((entry) => slugs?.includes(String(entry.id)));
      const voiceRoles = profiles.map((profile) => {
        const character = this.characterFor(String(profile.slug || ""), (profile.name as string[]) || []);
        return {
          name: profile.name,
          image: String(
            character?.faceImage ||
              character?.thumbnailImage ||
              (character ? CHARACTER_AVATAR(character.characterId) : ""),
          ),
          href: character
            ? entityHref({
                server: this.sourceServer(),
                locale: this.locale as Locale,
                kind: "characters",
                id: String(character.characterId),
              })
            : undefined,
        };
      });
      const catalog = profiles
        .map((profile) => this.characterFor(String(profile.slug || ""), (profile.name as string[]) || []))
        .find(Boolean);
      return [
        {
          color: String(
            catalog?.colorCode ||
              (profiles[0] ? PROFILE_BAND_SEED[String(profiles[0].band)] : "") ||
              "var(--md-sys-color-tertiary)",
          ),
          nextAt: nextBirthdayAt(Number(birthday.month), Number(birthday.day), now),
          retainedUntil: nextBirthdayAt(Number(birthday.month), Number(birthday.day), now) + BIRTHDAY_DAY_MS,
          announced: false,
          external: !catalog,
          href: catalog
            ? entityHref({
                server: this.sourceServer(),
                locale: this.locale as Locale,
                kind: "characters",
                id: String(catalog.characterId),
              })
            : "#",
          image: CAST_AVATAR(String(person.id || "")),
          kind: "cast",
          key: `cast:${String(person.id)}`,
          characterId: null,
          bandName: "",
          bandIcon: "",
          name: personNames?.[index] || personNames?.[0] || "—",
          voiceRoles,
        },
      ];
    });
    return [...characters, ...cast]
      .filter((item) => Number.isFinite(item.nextAt))
      .sort(
        (a, b) =>
          a.nextAt - b.nextAt || Number(a.kind === "cast") - Number(b.kind === "cast") || a.key.localeCompare(b.key),
      );
  }

  /* ---------- render: spotlight (banners + event) ---------- */
  private renderSpotlight() {
    const banners = this.banners;
    const track = banners.length > 1 ? [...banners, banners[0]] : banners;
    const slide = banners.length ? Math.min(this.slide, banners.length - 1) : 0;
    const slideBody = (banner: Banner, index: number) => {
      const countdown = banner.endAt ? this.countdown(banner.endAt, true) : nothing;
      // Banners ship per-locale variants beside the base art; fall back to it.
      const localized = localizedAssetUrl(banner.image, this.locale);
      const body = html`
        <img
          src=${localized}
          alt=""
          loading=${index === slide ? "eager" : "lazy"}
          decoding="async"
          @error=${(event: Event) => {
            const image = event.currentTarget as HTMLImageElement;
            if (!image.src.endsWith(banner.image)) image.src = banner.image;
          }}
        />
        <span class="home-carousel__copy">
          ${
            countdown
              ? html`
                  <small>${countdown}</small>
                `
              : nothing
          }
        </span>
      `;
      return banner.href
        ? html`
            <a class="home-carousel__slide" href=${banner.href} aria-label=${this.text("banners", "Banner")}>${body}</a>
          `
        : html`
            <div class="home-carousel__slide">${body}</div>
          `;
    };
    this.carouselWrap();
    return html`
      <section class="home-spotlight" aria-label=${this.text("banners", "Banners")}>
        <div
          class="home-carousel"
          role="group"
          aria-roledescription="carousel"
          aria-label=${this.text("banners", "Current banners")}
          @pointerenter=${() => this.stopAuto()}
          @pointerleave=${() => !matchMedia("(prefers-reduced-motion: reduce)").matches && this.startAuto()}
        >
          ${
            track.length
              ? html`
                  <div
                    class="home-carousel__track${this.slideAnimated ? "" : " home-carousel__track--snap"}"
                    style=${`transform: translateX(${-(100 * Math.min(this.slide, track.length - 1))}%)`}
                  >
                    ${track.map((banner, index) => slideBody(banner, index))}
                  </div>
                  ${
                    banners.length > 1
                      ? html`
                          <div class="home-carousel__dots" role="tablist">
                            ${banners.map(
                              (_banner, index) => html`
                                <button
                                  role="tab"
                                  type="button"
                                  aria-selected=${String(index === slide)}
                                  aria-label=${`${this.text("banners", "Banner")} ${index + 1}`}
                                  @click=${() => {
                                    this.slideAnimated = true;
                                    this.slide = index;
                                  }}
                                ></button>
                              `,
                            )}
                          </div>
                          <button
                            class="icon-button home-carousel__nav home-carousel__nav--prev"
                            type="button"
                            aria-label=${this.text("previous", "Previous")}
                            @click=${() => this.step(-1)}
                          >
                            ${icon("chevron_left", 22)}
                          </button>
                          <button
                            class="icon-button home-carousel__nav home-carousel__nav--next"
                            type="button"
                            aria-label=${this.text("next", "Next")}
                            @click=${() => this.step(1)}
                          >
                            ${icon("chevron_right", 22)}
                          </button>
                        `
                      : nothing
                  }
                `
              : html`
                  <div class="home-carousel__empty" role="status">
                    <span>${icon("redeem", 28)}</span>
                    <p>
                      ${
                        this.phase === "loading"
                          ? this.text("loading", "Loading…")
                          : this.text("noBanner", "No banner is currently listed.")
                      }
                    </p>
                  </div>
                `
          }
        </div>
        ${this.renderEvents()}
      </section>
    `;
  }

  private renderEvents() {
    const featured = this.featuredEvent();
    const event = featured?.entry;
    const title = event ? localizedText(event.details.title, this.locale) || event.title : "";
    const countdown = event ? this.eventPhrase(event.startAt, event.endAt) : "";
    const targets = event
      ? values(event.details.effects).flatMap((effect) =>
          Object.values((effect.targets || {}) as Record<string, JsonRecord>),
        )
      : [];
    const unique = [
      ...new Map(
        targets
          .filter((target) => target && typeof target === "object")
          .map((target) => [
            String(target.homeTargetKind || target.kind) +
              String(target.resourceId || target.bandId || target.cardType || localizedText(target.name, this.locale)),
            target,
          ]),
      ).values(),
    ];
    const bonusTargets = unique
      .filter((target) => target.homeTargetKind === "band" || target.homeTargetKind === "attribute")
      .map((target) => {
        const band = this.bands.find((entry) => Number(entry.bandId) === Number(target.bandId));
        const source = String(
          (target.homeTargetKind === "band"
            ? band?.icon || target.icon
            : target.image ||
              this.marks.get(
                (
                  {
                    1: "CardType-Red.png",
                    2: "CardType-Blue.png",
                    3: "CardType-Green.png",
                    4: "CardType-Yellow.png",
                    5: "CardType-Purple.png",
                  } as Record<number, string>
                )[Number(target.cardType)] || "",
              )) || "",
        );
        const name = localizedText(target.name || band?.bandName, this.locale);
        const image = source
          ? html`
              <img src=${source} width="24" height="24" alt="" loading="lazy" />
            `
          : nothing;
        return html`
          <span class="home-event__target" data-target=${target.homeTargetKind}>
            ${image}
            <span>${name}</span>
          </span>
        `;
      });
    const bonusCharacters = this.characters
      .filter((character) =>
        unique.some((target) => target.homeTargetKind === "band" && Number(target.bandId) === Number(character.bandId)),
      )
      .map(
        (character) => html`
          <a
            class="home-event__character"
            aria-label=${localizedText(character.characterName, this.locale)}
            title=${localizedText(character.characterName, this.locale)}
            href=${entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "characters", id: String(character.characterId) })}
          >
            <img
              src=${String(character.faceImage || character.thumbnailImage || CHARACTER_AVATAR(character.characterId))}
              width="32"
              height="32"
              alt=""
              loading="lazy"
            />
            <span>${localizedText(character.characterName, this.locale)}</span>
          </a>
        `,
      );
    const bonusContents = html`
      <div class="home-event__targets">${bonusTargets}</div>
      <div class="home-event__characters">${bonusCharacters}</div>
    `;
    return html`
      <section class="home-card home-event" aria-labelledby="home-event-title">
        <h2 id="home-event-title" class="sr-only">${uiText(this.locale, "events")}</h2>
        ${
          event
            ? html`
                <div class="home-event__card">
                  <a
                    class="home-event__media media-loading"
                    href=${entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "events", id: event.id })}
                    aria-label=${`${title} · ${countdown}`}
                  >
                    ${eventArtwork(String(event.details.backgroundImage || event.image), String(event.details.logo || ""), title, false, this.locale)}
                    <span class="home-event__overline">${uiText(this.locale, "events")}</span>
                    <span class="home-event__countdown tabular" role="timer" aria-live="off">${countdown}</span>
                  </a>
                  <div class="home-event__body">
                    <header class="home-event__heading">
                      <h3>
                        <a
                          href=${entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "events", id: event.id })}
                        >
                          ${title}
                        </a>
                      </h3>
                      <p class="home-event__range">
                        <time datetime=${new Date(event.startAt).toISOString()}>${this.formatDate(event.startAt)}</time>
                        –
                        <time datetime=${new Date(event.endAt).toISOString()}>${this.formatDate(event.endAt)}</time>
                      </p>
                    </header>
                    <div class="home-event__bonuses">${bonusContents}</div>
                    <nav class="home-event__links" aria-label=${uiText(this.locale, "events")}>
                      <a
                        class="button button--tonal home-event__action"
                        href=${entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "events", id: event.id })}
                        aria-label=${this.text("viewDetails", "View details")}
                        title=${this.text("viewDetails", "View details")}
                      >
                        ${icon("event_note", 20)}
                        <span>${this.text("viewDetails", "View details")}</span>
                      </a>
                      <a
                        class="button button--tonal home-event__action"
                        href=${`/${this.sourceServer()}/${this.locale}/events/tracker/`}
                        aria-label=${this.text("eventTracker", "Event tracker")}
                        title=${this.text("eventTracker", "Event tracker")}
                      >
                        ${icon("monitoring", 20)}
                        <span>${this.text("eventTracker", "Event tracker")}</span>
                      </a>
                      <a
                        class="button button--tonal home-event__action"
                        href=${event.details.homeStoryId ? entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "stories", id: String(event.details.homeStoryId) }) : resourceCollectionHref("/catalog/stories/event", this.sourceServer(), this.locale as Locale)}
                        aria-label=${this.text("eventStory", "Event story")}
                        title=${this.text("eventStory", "Event story")}
                      >
                        ${icon("auto_stories", 20)}
                        <span>${this.text("eventStory", "Event story")}</span>
                      </a>
                    </nav>
                  </div>
                </div>
              `
            : html`
                <div class="home-event__empty" role="status">
                  ${icon("event", 28)}
                  <p>
                    ${this.phase === "loading" ? this.text("loading", "Loading…") : this.text("noEvent", "No event is currently listed.")}
                  </p>
                </div>
              `
        }
      </section>
    `;
  }
  private renderCards() {
    const cards = [...this.cards]
      .sort(
        (a, b) =>
          timestamp(b.releasedAt) - timestamp(a.releasedAt) ||
          Number(b.homeKind === "support-cards") - Number(a.homeKind === "support-cards") ||
          Number(b.cardId || b.supportCardId) - Number(a.cardId || a.supportCardId),
      )
      .slice(0, 12);
    return html`
      <section class="home-card home-cards" aria-labelledby="home-cards-title">
        ${this.moduleHeader(
          icon("style"),
          this.text("latestCards", "Latest cards"),
          "home-cards-title",
          html`
            <div class="home-card__actions">
              ${["member-cards", "support-cards"].map(
                (kind) => html`
                  <a
                    class="button button--text"
                    href=${resourceCollectionHref(`/catalog/${kind}`, this.sourceServer(), this.locale as Locale)}
                  >
                    ${uiText(this.locale, kind === "member-cards" ? "memberCards" : "supportCards")}
                  </a>
                `,
              )}
            </div>
          `,
        )}
        <div class="collection collection--rail home-cards__grid">
          ${
            cards.length
              ? cards.map((card) => {
                  const kind = card.homeKind === "cards" ? "member-cards" : "support-cards";
                  const id = String(card.cardId || card.supportCardId);
                  const ids = [
                    ...new Set(
                      (Array.isArray(card.characterIds) ? card.characterIds : [card.characterId])
                        .map(Number)
                        .filter(Boolean),
                    ),
                  ];
                  const related = catalogCharacterRelationship(ids, this.locale, (id) =>
                    this.relationshipCharacter(id, card),
                  );
                  const names = related.label;
                  const title =
                    localizedText(card.prefix, this.locale) ||
                    localizedText(card.cardName, this.locale) ||
                    names ||
                    "—";
                  const attribute =
                    this.marksFor(card).get(
                      (
                        {
                          1: "CardType-Red.png",
                          2: "CardType-Blue.png",
                          3: "CardType-Green.png",
                          4: "CardType-Yellow.png",
                          5: "CardType-Purple.png",
                        } as Record<number, string>
                      )[Number(card.cardType)] || "",
                    ) || "";
                  const rarityName =
                    ({ 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" } as Record<number, string>)[
                      Number(card.rarity)
                    ] || "";
                  const rarity = this.marksFor(card).get(`RarityIconCenter_${rarityName}.png`) || "";
                  const images = (card.images || {}) as JsonRecord;
                  const releasedAt = timestamp(card.releasedAt);
                  return tile({
                    title,
                    subtitle: related.content,
                    label: [
                      title,
                      names,
                      uiText(this.locale, kind === "member-cards" ? "memberCards" : "supportCards"),
                      rarityName,
                      this.releaseLabel(releasedAt),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    kind: kind === "member-cards" ? "member" : "support",
                    fit: "contain",
                    adornment: related.adornment,
                    serverMark: this.exclusiveMark(card) ?? undefined,
                    image: String(images.thumbnail || card.thumbnail || card.image || ""),
                    href: entityHref({ server: this.rowServer(card), locale: this.locale as Locale, kind, id }),
                    aspectRatio: 1,
                    marks: [
                      attribute ? { at: "start", image: attribute, label: this.text("attribute", "Attribute") } : null,
                      rarity ? { at: "end", image: rarity, label: rarityName } : null,
                      releasedAt
                        ? {
                            at: "bottom-start",
                            text: this.releaseLabel(releasedAt),
                            label: this.releaseLabel(releasedAt),
                          }
                        : null,
                    ],
                  });
                })
              : Array.from(
                  { length: 8 },
                  () => html`
                    <div class="home-tile-placeholder" aria-hidden="true"></div>
                  `,
                )
          }
        </div>
      </section>
    `;
  }

  /* ---------- render: modules ---------- */
  private moduleHeader(leading: unknown, title: string, id: string, aside: unknown = nothing) {
    return html`
      <header class="home-card__header">
        <h2 id=${id}>
          ${leading}
          <span>${title}</span>
        </h2>
        ${aside}
      </header>
    `;
  }
  /** Latest songs, in the same grid the catalogue uses — difficulty gives way to recency. */
  private renderSongs() {
    const songs = this.songs
      .map((song) => ({ song, time: timestamp(song.publishedAt) }))
      // Release date first; same-day releases fall back to ID, both newest first.
      .sort((a, b) => b.time - a.time || Number(b.song.musicId) - Number(a.song.musicId))
      .slice(0, this.songLimit);
    return html`
      <section class="home-card home-songs" aria-labelledby="home-songs-title">
        ${this.moduleHeader(
          icon("library_music"),
          this.text("latestSongs", "Songs"),
          "home-songs-title",
          html`
            <div class="home-card__actions">
              <a
                class="button button--text"
                href=${resourceCollectionHref("/catalog/songs", this.sourceServer(), this.locale as Locale)}
              >
                ${this.text("viewAll", "View all")}${icon("arrow_forward", 18)}
              </a>
            </div>
          `,
        )}
        ${
          songs.length
            ? html`
                <div class="collection collection--rail collection--song home-songs__grid">
                  ${songs.map(({ song }) => {
                    // The catalogue's own song tile, built by the same shared
                    // code — identical anatomy; only the date mark is added.
                    const release = this.releaseLabel(timestamp(song.publishedAt));
                    const options = songTile(
                      song,
                      {
                        locale: this.locale,
                        title: (entry) => ({
                          text: this.songTitle(entry),
                          locale: songTitle(entry, this.locale).locale,
                        }),
                        image: (entry) => String(entry.jacketUrl || entry.jacketThumbUrl || ""),
                        artist: (entry) => {
                          for (const value of [entry.artistName, entry.bandName])
                            if (localizedText(value, this.locale)) return localizedContent(value, this.locale);
                          const ids = Array.isArray(entry.bandIds) ? entry.bandIds : [entry.bandId];
                          return localizedList(
                            ids.map((id) => this.relationshipBand(id, entry)?.bandName),
                            this.locale,
                          );
                        },
                        bandIcon: (entry) => String(this.relationshipBand(entry.bandId, entry)?.icon || ""),
                        imageForLocale: (source) => localizedAssetUrl(source, this.locale),
                        attributeMark: (entry) => this.attributeMark(entry.musicType, entry),
                        attributeLabel: () => String(song.musicType || ""),
                      },
                      entityHref({
                        server: this.rowServer(song),
                        locale: this.locale as Locale,
                        kind: "songs",
                        id: String(song.musicId || song.id),
                      }),
                      [release ? { at: "bottom-start" as const, text: release } : null],
                    );
                    return tile({
                      ...options,
                      label: [options.label, release].filter(Boolean).join(" · "),
                      serverMark: this.exclusiveMark(song) ?? undefined,
                    });
                  })}
                </div>
              `
            : html`
                <div class="collection collection--rail home-songs__grid">
                  ${Array.from(
                    { length: 8 },
                    () => html`
                      <div class="home-tile-placeholder" aria-hidden="true"></div>
                    `,
                  )}
                </div>
              `
        }
      </section>
    `;
  }
  private birthdayCountdown(item: Birthday) {
    const today = birthdayDayStart();
    if (item.nextAt < today) {
      const recruitment = this.birthdayRecruitment(item);
      return recruitment && recruitment.start > Date.now()
        ? this.text("upcoming", "Upcoming")
        : this.text("ongoing", "Ongoing");
    }
    const days = Math.round((item.nextAt - today) / 86400000);
    return days === 0
      ? this.text("birthdayGreeting", "Happy birthday")
      : this.text(days === 1 ? "daysAwayOne" : "daysAway", "{count} days").replace("{count}", this.count(days));
  }
  private birthdayShortCountdown(item: Birthday) {
    if (item.nextAt < birthdayDayStart()) return this.spanText(item.retainedUntil - Date.now());
    const days = Math.round((item.nextAt - birthdayDayStart()) / 86400000);
    return days === 0
      ? this.text("birthdayGreeting", "Happy birthday")
      : this.text("spanDays", "{count}d").replace("{count}", this.count(days));
  }
  private birthdayRecruitments(): Array<BirthdayGachaPeriod & { gacha: JsonRecord; artwork: string }> {
    if (this.birthdayGachaServer !== this.sourceServer()) return [];
    return this.birthdayGacha.flatMap((gacha) => {
      const server = String(gacha.sourceServer || this.sourceServer());
      if (server !== this.sourceServer()) return [];
      return values(gacha.featured).flatMap((prize) => {
        if (Number(prize.resourceType) !== 2 || prize.pickup === false) return [];
        const card =
          this.cards.find(
            (entry) =>
              entry.homeKind === "cards" &&
              this.rowServer(entry) === server &&
              Number(entry.cardId) === Number(prize.resourceId),
          ) || (this.seed?.documents.cards?.[String(prize.resourceId)] as JsonRecord | undefined);
        if (Number(prize.rarity ?? card?.rarity) !== 20) return [];
        const characterId = Number(prize.characterId ?? card?.characterId);
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return [];
        const cardYear = Number(prize.cardYear ?? card?.cardYear);
        const images = card?.images as JsonRecord | undefined;
        return [
          {
            server,
            characterId,
            ...(Number.isSafeInteger(cardYear) && cardYear > 0 ? { cardYear } : {}),
            cardReleasedAt: timestamp(card?.releasedAt),
            start: timestamp(gacha.startAt),
            end: timestamp(gacha.endAt),
            gacha,
            artwork: String(
              (prize.cardImages as JsonRecord | undefined)?.full ||
                prize.cardImage ||
                images?.full ||
                images?.thumbnail ||
                "",
            ),
          },
        ];
      });
    });
  }
  private birthdayRecruitment(item: Birthday) {
    if (!item.characterId) return undefined;
    const now = Date.now();
    const candidates = this.birthdayRecruitments().filter(
      (period) =>
        period.characterId === item.characterId && birthdayPeriodMatches(period, item.nextAt, this.sourceServer()),
    );
    const state = (row: (typeof candidates)[number]) =>
      row.start > now ? 1 : row.end <= 0 ? 3 : row.end <= now ? 2 : 0;
    return candidates.sort(
      (a, b) => state(a) - state(b) || Math.abs(a.start - item.nextAt) - Math.abs(b.start - item.nextAt),
    )[0];
  }
  private birthdayChoiceKey(item: Birthday) {
    return `${this.sourceServer()}:${item.key}:${item.nextAt}`;
  }
  private birthdayCard(item: Birthday) {
    if (!item.characterId) return undefined;
    return this.cards
      .filter(
        (card) =>
          card.homeKind === "cards" &&
          this.rowServer(card) === this.sourceServer() &&
          Number(card.characterId) === item.characterId &&
          Number(card.rarity) === 20 &&
          timestamp(card.releasedAt) > 0 &&
          Math.abs(timestamp(card.releasedAt) - item.nextAt) <= 45 * 86400000,
      )
      .sort(
        (a, b) => Math.abs(timestamp(a.releasedAt) - item.nextAt) - Math.abs(timestamp(b.releasedAt) - item.nextAt),
      )[0];
  }
  private birthdayStory(item: Birthday) {
    if (!item.characterId) return undefined;
    const date = new Date(item.nextAt + BIRTHDAY_UTC_OFFSET);
    return (this.birthdayStories[String(item.characterId)] || [])
      .filter((story) => {
        const birthday = story.birthday as JsonRecord | undefined;
        return (
          story.sourceServer === this.sourceServer() &&
          Number(story.characterId) === item.characterId &&
          Number(birthday?.characterId) === item.characterId &&
          Number(birthday?.month) === date.getUTCMonth() + 1 &&
          Number(birthday?.day) === date.getUTCDate() &&
          Boolean(story.storyKey || story.storyId)
        );
      })
      .sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt))[0];
  }
  private renderBirthdays() {
    const items = this.birthdays();
    const choices = birthdayCharacterChoices(items.filter((item) => item.kind === "character"));
    const featured = choices.find((item) => this.birthdayChoiceKey(item) === this.birthdaySelection) || choices[0];
    const recruitment = featured ? this.birthdayRecruitment(featured) : undefined;
    const recruitmentStatus =
      recruitment && recruitment.start > Date.now()
        ? this.text("upcoming", "Upcoming")
        : recruitment?.end && recruitment.end > Date.now()
          ? this.text("ongoing", "Ongoing")
          : "";
    const story = featured ? this.birthdayStory(featured) : undefined;
    const card = featured ? this.birthdayCard(featured) : undefined;
    const sourceCard = card ? (this.seed?.documents.cards?.[String(card.cardId)] as JsonRecord | undefined) : undefined;
    const cardImages = {
      ...((sourceCard?.images as JsonRecord | undefined) || {}),
      ...((card?.images as JsonRecord | undefined) || {}),
    };
    const cardArt = String(cardImages?.full || cardImages?.thumbnail || "");
    const art = String(recruitment?.gacha.image || recruitment?.artwork || cardArt || featured?.image || "");
    const artHref = recruitment
      ? entityHref({
          server: this.sourceServer(),
          locale: this.locale as Locale,
          kind: "gacha",
          id: String(recruitment.gacha.id),
        })
      : card && cardArt
        ? entityHref({
            server: this.sourceServer(),
            locale: this.locale as Locale,
            kind: "member-cards",
            id: String(card.cardId),
          })
        : featured?.characterId
          ? featured.href
          : "";
    const artLabel = recruitment
      ? localizedText(recruitment.gacha.title, this.locale)
      : card && cardArt
        ? localizedText(card.prefix || card.cardName, this.locale)
        : featured?.name || "";
    const artCandidates = localeTaggedCandidates(art, this.locale);
    const artContent = art
      ? html`
          <img
            src=${artCandidates[0]}
            alt=""
            decoding="async"
            @error=${(event: Event) => {
              const image = event.currentTarget as HTMLImageElement;
              image.dataset.candidates = JSON.stringify(artCandidates);
              image.dataset.candidateIndex = String(
                artCandidates.findIndex((source) => new URL(source, document.baseURI).href === image.src),
              );
              nextImageCandidate(event);
            }}
          />
        `
      : html`
          ${icon("cake", 40)}
        `;
    const avatars = featured
      ? html`
          <ul class="home-birthday-avatars" data-home-avatars>
            ${items
              .filter((item) => item.key !== featured.key)
              .slice(0, 12)
              .map((item) => {
                const role = item.voiceRoles.find((entry) => entry.href);
                const href = item.kind === "cast" ? role?.href : item.characterId ? item.href : undefined;
                const label = [
                  item.name,
                  this.text(item.kind, item.kind),
                  item.kind === "cast"
                    ? formatList(
                        item.voiceRoles.map((value) => localizedText(value.name, this.locale)),
                        this.locale,
                      )
                    : "",
                  this.formatDate(item.nextAt, true, "Asia/Tokyo"),
                  this.birthdayCountdown(item),
                ]
                  .filter(Boolean)
                  .join(" · ");
                const content = html`
                  <span class="home-birthday-portrait" style=${`--member:${item.color}`}>
                    ${
                      item.image
                        ? html`
                            <img
                              class="home-birthday-portrait__main"
                              src=${item.image}
                              alt=""
                              loading="lazy"
                              @error=${hideBrokenImage}
                            />
                          `
                        : Array.from(item.name)[0]
                    }
                    ${
                      item.kind === "cast" && role?.image
                        ? html`
                            <img
                              class="home-birthday-portrait__role"
                              src=${role.image}
                              alt=""
                              loading="lazy"
                              @error=${hideBrokenImage}
                            />
                          `
                        : nothing
                    }
                  </span>
                  <span class="home-birthday-avatar-name">${item.name}</span>
                  <span class="home-birthday-avatar-days tabular">${this.birthdayShortCountdown(item)}</span>
                `;
                return html`
                  <li>
                    ${
                      href
                        ? html`
                            <a href=${href} aria-label=${label} title=${label}>${content}</a>
                          `
                        : html`
                            <span aria-label=${label} title=${label}>${content}</span>
                          `
                    }
                  </li>
                `;
              })}
          </ul>
        `
      : nothing;
    return html`
      <section class="home-card home-info home-birthdays" aria-labelledby="home-birthdays-title">
        <h2 class="sr-only" id="home-birthdays-title">${this.text("birthdaysTitle", "Birthday countdown")}</h2>
        <a
          class="icon-button home-birthday-calendar"
          href=${resourceCollectionHref("/calendar", this.sourceServer(), this.locale as Locale)}
          aria-label=${clientText(this.locale, "calendar.title", "Calendar")}
          title=${clientText(this.locale, "calendar.title", "Calendar")}
        >
          ${icon("event", 20)}
        </a>
        ${
          featured
            ? html`
                <div class="home-birthday-feature">
                  ${
                    artHref
                      ? html`
                          <a
                            class=${`home-birthday-art${recruitment || cardArt ? "" : " home-birthday-art--portrait"}`}
                            href=${artHref}
                            aria-label=${artLabel}
                          >
                            ${artContent}
                          </a>
                        `
                      : html`
                          <div class="home-birthday-art home-birthday-art--portrait">${artContent}</div>
                        `
                  }
                  <div class="home-birthday-copy">
                    <span class="home-birthday-eyebrow">
                      ${icon("cake", 16)}${this.text("birthdaysTitle", "Birthday countdown")}
                    </span>
                    ${
                      featured.characterId
                        ? html`
                            <a class="home-birthday-name" href=${featured.href}>
                              ${
                                featured.image
                                  ? html`
                                      <img
                                        src=${featured.image}
                                        width="32"
                                        height="32"
                                        alt=""
                                        decoding="async"
                                        @error=${hideBrokenImage}
                                      />
                                    `
                                  : nothing
                              }
                              <span>${featured.name}</span>
                            </a>
                          `
                        : html`
                            <strong class="home-birthday-name">
                              ${
                                featured.image
                                  ? html`
                                      <img
                                        src=${featured.image}
                                        width="32"
                                        height="32"
                                        alt=""
                                        decoding="async"
                                        @error=${hideBrokenImage}
                                      />
                                    `
                                  : nothing
                              }
                              <span>${featured.name}</span>
                            </strong>
                          `
                    }
                    ${
                      featured.bandName
                        ? html`
                            <span class="home-birthday-band">
                              ${
                                featured.bandIcon
                                  ? html`
                                      <img
                                        src=${localizedAssetUrl(featured.bandIcon, this.locale)}
                                        width="16"
                                        height="16"
                                        alt=""
                                      />
                                    `
                                  : nothing
                              }
                              <span>${featured.bandName}</span>
                            </span>
                          `
                        : nothing
                    }
                    <span class="home-birthday-due">
                      <b class="tabular" aria-label=${this.birthdayCountdown(featured)}>
                        ${
                          choices.length > 1 && featured.nextAt > birthdayDayStart()
                            ? this.birthdayShortCountdown(featured)
                            : this.birthdayCountdown(featured)
                        }
                      </b>
                      <time datetime=${new Date(featured.nextAt + BIRTHDAY_UTC_OFFSET).toISOString().slice(0, 10)}>
                        ${this.formatDate(featured.nextAt, true, "Asia/Tokyo")}
                      </time>
                    </span>
                    ${
                      recruitment
                        ? html`
                            <span class="home-birthday-recruitment-time">
                              ${
                                recruitment.end || recruitment.start > Date.now()
                                  ? this.eventPhrase(recruitment.start, recruitment.end)
                                  : this.formatDate(recruitment.start, true, "Asia/Tokyo")
                              }
                            </span>
                          `
                        : nothing
                    }
                  </div>
                </div>
                <div class="home-birthday-bottom">
                  ${
                    choices.length > 1
                      ? html`
                          <div style="min-width:0;max-width:100%;overflow-x:auto">
                            <div style="display:flex;align-items:center;gap:var(--md-sys-spacing-2);width:max-content">
                              ${segmented({
                                label: `${this.text("birthdaysTitle", "Birthday countdown")} · ${uiText(this.locale, "gacha")}`,
                                value: this.birthdayChoiceKey(featured),
                                options: choices.map((item) => {
                                  const pool = this.birthdayRecruitment(item);
                                  const status =
                                    pool?.start && pool.start > Date.now()
                                      ? this.text("upcoming", "Upcoming")
                                      : pool?.end && pool.end > Date.now()
                                        ? this.text("ongoing", "Ongoing")
                                        : "";
                                  return {
                                    value: this.birthdayChoiceKey(item),
                                    label: [item.name, status].filter(Boolean).join(" · "),
                                  };
                                }),
                                onSelect: (value) => {
                                  this.birthdaySelection = value;
                                },
                              })}
                              ${avatars}
                            </div>
                          </div>
                        `
                      : avatars
                  }
                  <nav class="home-birthday-actions" aria-label=${this.text("birthdaysTitle", "Birthday countdown")}>
                    ${
                      choices.length === 1 && featured.nextAt >= birthdayDayStart() && recruitmentStatus
                        ? html`
                            <span
                              class="home-birthday-recruitment-time"
                              style="display:inline"
                              aria-label=${`${uiText(this.locale, "gacha")}: ${recruitmentStatus}`}
                            >
                              ${recruitmentStatus}
                            </span>
                          `
                        : nothing
                    }
                    ${
                      story
                        ? html`
                            <a
                              class="icon-button"
                              href=${entityHref({ server: this.sourceServer(), locale: this.locale as Locale, kind: "stories", id: String(story.storyKey || story.storyId) })}
                              aria-label=${clientText(this.locale, "birthdayStory", uiText(this.locale, "story"))}
                              title=${clientText(this.locale, "birthdayStory", uiText(this.locale, "story"))}
                            >
                              ${icon("auto_stories", 20)}
                            </a>
                          `
                        : nothing
                    }
                  </nav>
                </div>
              `
            : html`
                <div class="state state--inline" role="status">${this.text("loading", "Loading…")}</div>
              `
        }
      </section>
    `;
  }
  private renderCommunity() {
    return html`
      <section class=${`home-card home-info home-community${this.posts.slice(0, 2).some(isEntityCommentRecommendation) ? " home-community--comments" : ""}`} aria-labelledby="home-community-title">
        ${this.moduleHeader(
          icon("forum"),
          this.text("communityTitle", "Trending community"),
          "home-community-title",
          html`
            <a
              class="icon-button"
              href="/community/feeds"
              aria-label=${this.text("openCommunity", "Open community")}
              title=${this.text("openCommunity", "Open community")}
            >
              ${icon("arrow_forward", 20)}
            </a>
          `,
        )}
        ${this.communityCommentError ? html`<div class="inline-message error" role="alert">${this.communityCommentError}</div>` : nothing}
        ${
          this.posts.length
            ? html`
                <ol class="community-hot-list home-info__body" data-home-fit role="list">
                  ${this.posts.slice(0, this.posts.some(isEntityCommentRecommendation) ? 2 : 8).map(
                    (post, index) => isEntityCommentRecommendation(post)
                      ? html`<li>${this.renderRecommendedComment(post)}</li>`
                      : html`
                      <li class=${index === 0 ? "home-community-lead" : ""}>
                        <a class="list-item list-item--interactive" href=${`/community/posts/${post.id}`}>
                          <span class="list-item__marker tabular" aria-hidden="true">${index + 1}</span>
                          <span class="list-item__body">
                            <span class="list-item__headline">${String(post.title || post.excerpt || "—")}</span>
                            ${
                              index === 0 && post.excerpt && post.excerpt !== post.title
                                ? html`
                                    <span class="home-community-excerpt">${String(post.excerpt)}</span>
                                  `
                                : nothing
                            }
                            <span class="list-item__supporting">
                              ${String(post.authorName || "")}${post.createdAt ? ` · ${this.formatDate(String(post.lastEditedAt || post.createdAt))}` : ""}
                            </span>
                          </span>
                          <span class="list-item__meta community-hot-list__score tabular">
                            ${icon("favorite", 16)}${Number(post.likeCount || 0)}
                            ${icon("chat_bubble", 16)}${Number(post.commentCount || 0)}
                          </span>
                        </a>
                      </li>
                    `,
                  )}
                </ol>
              `
            : html`
                <div class="state state--inline" role="status">
                  <span class="state__icon">${icon("forum", 28)}</span>
                  <p class="state__body">
                    ${this.communityPhase === "loading" ? this.text("loading", "Loading…") : this.communityPhase === "error" ? this.text("sourceUnavailable", "Unavailable") : this.text("communityEmpty", "There are no public community posts yet.")}
                  </p>
                </div>
              `
        }
      </section>
    `;
  }
  private renderNews() {
    return html`
      <section class="home-card home-info home-news" aria-labelledby="home-news-title">
        ${this.moduleHeader(
          icon("newspaper"),
          announcementText(this.locale, "title", "Announcements"),
          "home-news-title",
          html`
            <a
              class="icon-button"
              href=${announcementPath(this.sourceServer(), this.locale as Locale)}
              aria-label=${announcementText(this.locale, "viewAll", "View all")}
              title=${announcementText(this.locale, "viewAll", "View all")}
            >
              ${icon("arrow_forward", 20)}
            </a>
          `,
        )}
        ${
          this.announcements.length
            ? html`
                <ul class="list list--divided announcement-list home-info__body" data-home-fit role="list">
                  ${this.announcements.map((entry) => announcementRow(entry, this.sourceServer(), this.locale as Locale))}
                </ul>
              `
            : html`
                <div class="state state--inline home-info__body" role="status">
                  <p class="state__body">
                    ${this.announcementsPhase === "loading" ? this.text("loading", "Loading…") : this.announcementsPhase === "error" ? this.text("sourceUnavailable", "Unavailable") : announcementText(this.locale, "empty", "No announcements yet.")}
                  </p>
                </div>
              `
        }
      </section>
    `;
  }
  private safeFanUrl(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        ["bandori.fans", "www.bandori.fans"].includes(url.hostname) &&
        !url.username &&
        !url.password
        ? url.href
        : "";
    } catch {
      return "";
    }
  }
  private fanSummary(entry: HomeFanInfo["entries"][number]) {
    const instant =
      entry.allDay !== true && entry.eventStartAtMs && Number.isFinite(entry.eventStartAtMs)
        ? entry.eventStartAtMs
        : undefined;
    let date = "";
    if (instant)
      date = new Intl.DateTimeFormat(this.locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(instant);
    else if (entry.eventDate && /^\d{4}-\d{2}-\d{2}$/u.test(entry.eventDate))
      date = new Intl.DateTimeFormat(this.locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${entry.eventDate}T00:00:00Z`));
    return date
      ? [date, entry.venue].filter(Boolean).join(" · ")
      : entry.summary ||
          (["live", "real-live"].includes(entry.category || "")
            ? clientText(this.locale, "calendar.live", "Live")
            : "");
  }
  private renderFanInfo() {
    const entries = this.fanInfo.entries.filter((entry) => entry.title && this.safeFanUrl(entry.href)).slice(0, 8);
    const rows = entries.map(
      (entry, index) => html`
        <li class=${index === 0 ? "home-fan-lead" : ""}>
          <a
            class="list-item list-item--two-line list-item--interactive"
            href=${this.safeFanUrl(entry.href)}
            target="_blank"
            rel="noopener noreferrer"
          >
            ${
              entry.image && /^\/images\/calendar-lives\/[a-f0-9]{64}\.png$/u.test(entry.image)
                ? html`
                    <span class="list-item__leading">
                      <img
                        class="home-fan-info__image"
                        src=${entry.image}
                        width="56"
                        height="32"
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    </span>
                  `
                : nothing
            }
            <span class="list-item__body">
              <strong class="list-item__headline">${entry.title}</strong>
              <span class="list-item__supporting">
                ${this.fanSummary(entry)}${entry.publishedAt ? ` · ${announcementText(this.locale, "published", "Published")} ${this.formatDate(entry.publishedAt, true)}` : ""}
              </span>
            </span>
            <span class="list-item__trailing">${icon("open_in_new", 18)}</span>
          </a>
        </li>
      `,
    );
    return html`
      <section class="home-card home-info home-fan-info" aria-labelledby="home-fan-info-title">
        ${this.moduleHeader(
          icon("feed"),
          "bandori.fans",
          "home-fan-info-title",
          html`
            <a
              class="icon-button"
              href="https://bandori.fans/"
              aria-label="bandori.fans"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${icon("open_in_new", 20)}
            </a>
          `,
        )}
        ${
          rows.length
            ? html`
                <ul class="list home-info__body home-fan-info__list" data-home-fit>
                  ${rows}
                </ul>
              `
            : html`
                <div class="state state--inline home-info__body" role="status">
                  <p class="state__body">
                    ${this.text(this.fanInfo.status === "empty" ? "fanInfoEmpty" : "sourceUnavailable", this.fanInfo.status === "empty" ? "No current updates." : "Unavailable")}
                  </p>
                </div>
              `
        }
      </section>
    `;
  }
  private renderModule(id: ModuleId) {
    if (id === "songs") return this.renderSongs();
    if (id === "cards") return this.renderCards();
    if (id === "birthdays") return this.renderBirthdays();
    if (id === "community") return this.renderCommunity();
    if (id === "fanInfo") return this.renderFanInfo();
    return this.renderNews();
  }
  private moduleLabel(id: ModuleId) {
    return {
      songs: this.text("latestSongs", "Songs"),
      cards: this.text("latestCards", "Latest cards"),
      birthdays: this.text("birthdaysTitle", "Birthday countdown"),
      community: this.text("communityTitle", "Trending community"),
      fanInfo: "bandori.fans",
      news: announcementText(this.locale, "title", "Announcements"),
    }[id];
  }
  private renderDialog() {
    const close = (event: Event) => (event.currentTarget as HTMLElement).closest("dialog")?.close();
    return html`
      <dialog
        class="dialog home-layout-dialog"
        aria-labelledby="home-layout-title"
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) (event.currentTarget as HTMLDialogElement).close();
        }}
      >
        <div class="dialog__surface">
          <header class="dialog__header">
            ${icon("dashboard_customize", 24)}
            <h2 id="home-layout-title">${this.text("customizeLayout", "Customize layout")}</h2>
          </header>
          <ul class="layout-list" role="list">
            ${this.order.map(
              (id, index) => html`
                <li class=${this.hiddenModules[id] ? "is-hidden" : ""}>
                  <button
                    class="icon-button"
                    type="button"
                    aria-pressed=${String(!this.hiddenModules[id])}
                    aria-label=${`${this.hiddenModules[id] ? this.text("showModule", "Show") : this.text("hideModule", "Hide")}: ${this.moduleLabel(id)}`}
                    @click=${() => this.toggle(id)}
                  >
                    ${icon(this.hiddenModules[id] ? "visibility_off" : "visibility", 22)}
                  </button>
                  <span>${this.moduleLabel(id)}</span>
                  <button
                    class="icon-button"
                    type="button"
                    ?disabled=${!this.canMove(id, -1)}
                    aria-label=${this.text("moveUp", "Move up")}
                    @click=${() => this.move(id, -1)}
                  >
                    ${icon("arrow_upward", 22)}
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    ?disabled=${!this.canMove(id, 1)}
                    aria-label=${this.text("moveDown", "Move down")}
                    @click=${() => this.move(id, 1)}
                  >
                    ${icon("arrow_downward", 22)}
                  </button>
                </li>
              `,
            )}
          </ul>
          <footer class="dialog__actions">
            <button class="button button--text" type="button" @click=${() => this.reset()}>
              ${this.text("resetLayout", "Restore default layout")}
            </button>
            <button class="button button--text" type="button" @click=${close}>
              ${this.text("closeLayout", "Close")}
            </button>
          </footer>
        </div>
      </dialog>
    `;
  }
  render() {
    const visible = this.order.filter((id) => !this.hiddenModules[id]);
    return html`
      <div class="home">
        ${this.renderSpotlight()}
        <div class="home-board">
          ${repeat(
            visible,
            (id) => id,
            (id) => html`
              <div class=${`home-board__slot home-board__slot--${id}`}>${this.renderModule(id)}</div>
            `,
          )}
        </div>
        ${this.renderDialog()}
      </div>
    `;
  }

  private communityMessages?: Catalog;
  private communityLabel(key: string, fallback: string, params?: MessageParams) {
    for (const candidate of [...catalogLookupKeys("communityPage." + key), ...catalogLookupKeys(key)])
      if (this.communityMessages?.has(candidate)) return this.communityMessages.text(candidate, params, fallback);
    return fallback;
  }
  private entityCommentHref(entry: JsonRecord, reply = false) {
    return isEntityCommentRecommendation(entry) ? entityCommentRecommendationHref(entry, this.sourceServer(), location.pathname + location.search + location.hash, reply) : "";
  }
  private openRecommendedComment(entry: JsonRecord, action: "reply" | "edit" | "delete" | "report" | "appeal") {
    const href = this.entityCommentHref(entry, action === "reply");
    if (!href) return;
    const target = new URL(href, location.origin);
    if (action !== "reply") target.searchParams.set("commentAction", action);
    void navigateDetailPage(target.pathname + target.search + target.hash);
  }
  private likeRecommendedComment(entry: JsonRecord) {
    if (!isEntityCommentRecommendation(entry)) return;
    if (!this.communityViewer?.userId) {
      location.assign("/" + this.locale + "/account/?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
      return;
    }
    const id = entry.comment.id, realm = this.communityViewer.realm, locale = this.locale, server = this.sourceServer(), lifetime = this.communityLifetime;
    const find = () => this.posts.find((item) => isEntityCommentRecommendation(item) && item.comment.id === id);
    const current = () => this.isConnected && !lifetime.signal.aborted && lifetime === this.communityLifetime &&
      realm === this.communityViewer?.realm && locale === this.locale && server === this.sourceServer() && !!find();
    if (entry.comment.viewer.canLike === false) return;
    this.communityCommentError = "";
    this.communityReactions.toggle(id, { active: Boolean(entry.comment.viewer.liked), likeCount: Number(entry.comment.likeCount || 0) }, {
      current,
      terminal: (error) => !!error && typeof error === "object" && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500,
      send: async (active, signal) => {
        const result = await fetchJson<JsonRecord>("/api/v1/community/comments/" + encodeURIComponent(id) + "/reaction", {
          method: "PUT", body: JSON.stringify({ active }), headers: {"content-type":"application/json"},
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([signal, lifetime.signal]),
        });
        return { active: Boolean(result.active), likeCount: Number(result.likeCount) };
      },
      apply: (state) => {
        if (!current()) return;
        this.posts = this.posts.map((item) => isEntityCommentRecommendation(item) && item.comment.id === id
          ? { ...item, comment: { ...item.comment, likeCount: state.likeCount, viewer: { ...item.comment.viewer, liked: state.active } } } : item);
      },
      reject: (error) => {
        if (!current()) return;
        this.communityCommentError = this.communityLabel("reactionFailed", "Could not save like. Try again.");
        if (error && typeof error === "object" && "status" in error && [401, 404].includes(Number(error.status)))
          this.posts = this.posts.filter((item) => !(isEntityCommentRecommendation(item) && item.comment.id === id));
      },
    });
  }
  private renderRecommendedComment(entry: JsonRecord) {
    if (!isEntityCommentRecommendation(entry)) return nothing;
    const href = this.entityCommentHref(entry);
    return renderLazyEntityCommentActivity({
      contextLabel: this.communityLabel("comments", "Comments"),
      targetTitle: entry.entityRef.titles[this.locale] || Object.values(entry.entityRef.titles).find(Boolean) || entry.entityRef.originalId,
      targetHref: href,
      privateLabel: entry.adminOnlyContext ? this.communityLabel("visibilityPrivate", "Private") : undefined,
      comment: {
        record: entry.comment,
        locale: this.locale,
        label: (key, fallback, params?: MessageParams) => this.communityLabel(key, fallback, params),
        authorHref: `/${this.locale}/community/users/${encodeURIComponent(entry.comment.authorUid)}?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
        canReply: Boolean(href),
        allowStickers: true,
        preview: true,
        previewStickers: communityStickerPreview(entry.comment.body, 1),
        actions: {
          like: () => this.likeRecommendedComment(entry),
          reply: href ? () => this.openRecommendedComment(entry, "reply") : undefined,
          edit: href ? () => this.openRecommendedComment(entry, "edit") : undefined,
          report: href ? () => this.openRecommendedComment(entry, "report") : undefined,
          appeal: href ? () => this.openRecommendedComment(entry, "appeal") : undefined,
          remove: href ? () => this.openRecommendedComment(entry, "delete") : undefined,
        },
      },
    }, () => this.requestUpdate());
  }
}
if (!customElements.get("home-dashboard")) customElements.define("home-dashboard", HomeDashboard);
