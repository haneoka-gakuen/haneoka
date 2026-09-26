import { observeSongDisplay, songTitle } from "../lib/song-display";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  uiText,
  type JsonRecord,
} from "./shared/catalog";
import { CATALOG_HUB, NAV_SECTIONS, type NavItem } from "../config/navigation";
import { tile } from "./ui/tile";
import { liveMusicTypeMark, songTile } from "./shared/song-tile";
import { LazyImages, localizedAssetUrl } from "./ui/lazy-images";

type ModuleId = "songs" | "birthdays" | "community" | "news";
type Birthday = {
  color: string;
  href: string;
  image: string;
  kind: "character" | "cast";
  name: string;
  /** For cast birthdays: the characters this person voices. */
  voices: string;
  nextAt: number;
  external: boolean;
};
/** A rotating window (gacha banner, event, live) the game is showing right now. */
type Spotlight = {
  id: string;
  title: string;
  image: string;
  href: string;
  startAt: number;
  endAt: number;
};
/** One slide of the home carousel: the game's own MasterHomeBanner rows. */
type Banner = {
  id: string;
  image: string;
  href: string;
  endAt: number;
};

const MODULES: ModuleId[] = ["songs", "birthdays", "community", "news"];
const PROFILE_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const STORAGE_KEY = "haneoka:home-layout:v3";
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
const CAST_AVATAR = (id: string) => `/images/avatars/cast/${id}.jpg`;
/**
 * The bottom directory is the navigation drawer's own catalogue listing: the
 * same NAV_SECTIONS, restricted to the routes the catalogue serves, with
 * counts joined from CATALOG_HUB where the route exposes one. One source of
 * truth — the two listings cannot drift apart again.
 */
const directoryGroups = (): ReadonlyArray<readonly [label: string, items: NavItem[]]> =>
  NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => item.route.startsWith("/catalog/")),
  }))
    .filter((section) => section.items.length > 0)
    .map(({ label, items }) => [label, items] as const);

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

export class HomeDashboard extends LitElement {
  static properties = {
    locale: { type: String },
    labels: { type: String },
    phase: { state: true },
    songs: { state: true },
    characters: { state: true },
    banners: { state: true },
    events: { state: true },
    counts: { state: true },
    posts: { state: true },
    order: { state: true },
    hiddenModules: { state: true },
    slide: { state: true },
    songLimit: { state: true },
  };
  declare locale: string;
  declare labels: string;
  declare phase: "loading" | "ready" | "error";
  declare songs: JsonRecord[];
  declare characters: JsonRecord[];
  declare bands: JsonRecord[];
  private marks = new Map<string, string>();
  declare banners: Banner[];
  declare events: Spotlight[];
  declare counts: Record<string, number>;
  declare posts: JsonRecord[];
  declare order: ModuleId[];
  declare hiddenModules: Record<string, boolean>;
  declare slide: number;
  /** How many songs fill exactly two grid rows; measured, clamped 8–14. */
  declare songLimit: number;
  private copies: Record<string, Record<string, string>> = {};
  private action?: HTMLButtonElement;
  private characterProfiles: JsonRecord[] = [];
  private castProfiles: JsonRecord[] = [];
  /** Song tiles defer their artwork as data-src; this promotes them. */
  private lazyImages = new LazyImages({ candidates: (source) => [localizedAssetUrl(source, this.locale)] });
  private songsResize?: ResizeObserver;
  private slideTimer?: number;
  /** False only for the invisible wrap jump between the clone and slide 0. */
  private slideAnimated = true;
  private localeListener = (event: Event) => {
    this.locale = String((event as CustomEvent).detail || preferredLocale());
    this.syncAction();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.labels = "{}";
    this.phase = "loading";
    this.songs = [];
    this.characters = [];
    this.banners = [];
    this.events = [];
    this.counts = {};
    this.posts = [];
    this.order = [...MODULES];
    this.hiddenModules = {};
    this.slide = 0;
    this.songLimit = 12;
  }
  createRenderRoot() {
    return this;
  }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.copies = JSON.parse(this.labels || "{}");
    this.locale = preferredLocale(this.locale);
    this.restoreLayout();
    addEventListener("haneoka:locale-ready", this.localeListener);
    void this.load();
    void this.loadProfiles();
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) this.startAuto();
    queueMicrotask(() => this.mountAction());
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    if (this.slideTimer) window.clearInterval(this.slideTimer);
    removeEventListener("haneoka:locale-ready", this.localeListener);
    this.action?.remove();
    this.lazyImages.disconnect();
    this.songsResize?.disconnect();
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("locale")) this.syncAction();
    this.lazyImages.observe(this);
    this.measureSongs();
  }
  /** The live music-type emblem, from the same ui-marks the catalogue reads. */
  private attributeMark(musicType: unknown) {
    return liveMusicTypeMark(this.marks, musicType);
  }
  /** Exactly two full rows of songs: the column count is chosen by width —
   four per row at least, seven at most — and the grid renders twice that
   many songs. 8–14 songs at every size, never a partial row. */
  private measureSongs() {
    const grid = this.querySelector<HTMLElement>(".home-songs__grid");
    if (!grid || typeof ResizeObserver === "undefined") return;
    if (!this.songsResize) {
      this.songsResize = new ResizeObserver(() => this.measureSongs());
      this.songsResize.observe(grid);
    }
    const width = grid.clientWidth;
    if (!width) return;
    const columns = Math.min(7, Math.max(4, Math.floor(width / 140)));
    grid.style.setProperty("--song-columns", String(columns));
    const limit = columns * 2;
    if (limit !== this.songLimit) this.songLimit = limit;
  }

  /* ---------- copy ---------- */
  private get copy() {
    return this.copies[this.locale] || this.copies.ja || {};
  }
  private text(key: string, fallback: string) {
    return this.copy[key] || fallback;
  }
  private count(value: number) {
    return value.toLocaleString(this.locale);
  }

  /* ---------- top app bar action ---------- */
  private syncAction() {
    if (!this.action) return;
    const label = this.text("customizeLayout", "Customize layout");
    this.action.setAttribute("aria-label", label);
    this.action.title = label;
  }
  private mountAction() {
    const host = document.querySelector("[data-top-app-bar-actions]");
    if (!host || this.action?.isConnected) return;
    const button = document.createElement("button");
    button.className = "icon-button";
    button.type = "button";
    button.innerHTML = `<svg class="material-icon" width="24" height="24" aria-hidden="true"><use href="/icons.svg#dashboard_customize"></use></svg>`;
    button.addEventListener("click", () => this.querySelector<HTMLDialogElement>(".home-layout-dialog")?.showModal());
    host.append(button);
    this.action = button;
    this.syncAction();
  }

  /* ---------- data ---------- */
  private async load() {
    this.phase = "loading";
    const now = Date.now();
    const active = (value: unknown) =>
      values(value, "entries")
        .map((entry) => this.spotlightOf(entry, ""))
        .filter(
          (entry) => entry.image && (!entry.startAt || entry.startAt <= now) && (!entry.endAt || entry.endAt >= now),
        )
        .sort((a, b) => (a.endAt || Infinity) - (b.endAt || Infinity));
    const [summary, songs, characters, banners, events, bands, marks, posts] = await Promise.allSettled([
      fetchJson<JsonRecord>(catalogUrl("catalog/summary")),
      fetchJson<JsonRecord>(catalogUrl("songs")),
      fetchJson<JsonRecord>(catalogUrl("characters")),
      fetchJson<JsonRecord>(catalogUrl("home-banners")),
      fetchJson<JsonRecord>(catalogUrl("events")),
      fetchJson<JsonRecord>(catalogUrl("bands")),
      fetchJson<JsonRecord>(catalogUrl("ui-marks")),
      fetchJson<JsonRecord>("/api/v1/community/posts?limit=5&scope=recommended"),
    ]);
    if (summary.status === "fulfilled") {
      const resources = (summary.value.resources || {}) as Record<string, JsonRecord>;
      this.counts = Object.fromEntries(
        Object.entries(resources).map(([key, entry]) => [key, Number(entry?.count) || 0]),
      );
    }
    if (songs.status === "fulfilled") this.songs = values(songs.value);
    if (characters.status === "fulfilled") this.characters = values(characters.value);
    if (bands.status === "fulfilled") this.bands = values(bands.value);
    if (marks.status === "fulfilled")
      for (const [logical, path] of Object.entries(marks.value as Record<string, string>))
        this.marks.set(logical, `/runtime/${currentReleaseServer()}/${path.slice("runtime/".length)}`);
    if (banners.status === "fulfilled") this.banners = this.carousel(banners.value, now);
    if (events.status === "fulfilled")
      this.events = active(events.value).map((entry) => ({ ...entry, href: `/catalog/events?entry=${entry.id}` }));
    if (posts.status === "fulfilled")
      this.posts = Array.isArray(posts.value.posts) ? (posts.value.posts as JsonRecord[]) : [];
    this.phase = [summary, songs, characters].some((result) => result.status === "fulfilled") ? "ready" : "error";
  }
  private spotlightOf(entry: JsonRecord, resource: string): Spotlight {
    return {
      id: String(entry.id || ""),
      title: localizedText(entry.title, this.locale) || "—",
      image: String(entry.image || ""),
      href: resource ? `/catalog/${resource}?entry=${String(entry.id || "")}` : "",
      startAt: timestamp(entry.startAt),
      endAt: timestamp(entry.endAt),
    };
  }
  /** Active home banners in the game's own display order. */
  private carousel(value: unknown, now: number): Banner[] {
    return values(value, "entries")
      .map<Banner>((entry) => ({
        id: String(entry.id || ""),
        image: String(entry.image || ""),
        href: String(entry.href || ""),
        endAt: timestamp(entry.endAt) || now,
      }))
      .filter((entry) => entry.image && entry.endAt >= now)
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
    if (this.slide > this.banners.length - 1) {
      requestAnimationFrame(() => {
        this.slideAnimated = false;
        this.slide = 0;
      });
    }
  }
  private async loadProfiles() {
    const [characters, cast] = await Promise.all([import("../data/characterProfiles"), import("../data/castProfiles")]);
    this.characterProfiles = characters.characterProfiles as unknown as JsonRecord[];
    this.castProfiles = cast.castProfiles as unknown as JsonRecord[];
    this.requestUpdate();
  }

  /* ---------- layout preferences ---------- */
  private restoreLayout() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (
        Array.isArray(state?.order) &&
        state.order.length === MODULES.length &&
        MODULES.every((id) => state.order.includes(id))
      )
        this.order = state.order;
      if (state?.hidden && typeof state.hidden === "object") this.hiddenModules = state.hidden;
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage unavailable; defaults stay in effect.
      }
    }
  }
  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: this.order, hidden: this.hiddenModules }));
    } catch {
      // Layout changes last for this visit only.
    }
  }
  private move(id: ModuleId, delta: number) {
    const from = this.order.indexOf(id),
      to = from + delta;
    if (to < 0 || to >= this.order.length) return;
    const order = [...this.order];
    [order[from], order[to]] = [order[to], order[from]];
    this.order = order;
    this.persist();
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
  private formatDate(value: number | string, short = false) {
    const date = new Date(typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat(
          this.locale,
          short ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
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
  private countdown(at: number, ending: boolean) {
    const span = this.spanText(at - Date.now());
    return (ending ? this.text("endsIn", "Ends in {time}") : this.text("startsIn", "Starts in {time}")).replace(
      "{time}",
      span,
    );
  }
  /** Days since/until a release, e.g. "3 天前上线". */
  private releaseLabel(at: number) {
    if (!at) return "";
    const days = Math.round((at - Date.now()) / 86400000);
    if (days === 0) return this.text("releasedToday", "Added today");
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
    const now = new Date(),
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const next = (month: number, day: number) => {
      let date = new Date(now.getFullYear(), month - 1, day);
      if (date.getTime() < start) date = new Date(now.getFullYear() + 1, month - 1, day);
      return date.getTime();
    };
    const index = Math.max(0, PROFILE_LOCALES.indexOf(this.locale));
    const characters = this.characterProfiles.flatMap<Birthday>((profile) => {
      const birthdays = profile.birthday as string[] | undefined,
        names = profile.name as string[] | undefined;
      const match = birthdays?.[0]?.match(/^(\d{1,2})月(\d{1,2})日$/);
      if (!match || !names) return [];
      const catalog = this.characterFor(String(profile.slug || ""), names);
      return [
        {
          color: String(catalog?.colorCode || PROFILE_BAND_SEED[String(profile.band)] || "var(--md-sys-color-primary)"),
          nextAt: next(Number(match[1]), Number(match[2])),
          external: !catalog,
          href: catalog ? `/catalog/characters?character=${catalog.characterId}` : "#",
          image: catalog ? CHARACTER_AVATAR(catalog.characterId) : "",
          kind: "character",
          name: names[index] || names[0],
          voices: "",
        },
      ];
    });
    const cast = this.castProfiles.flatMap<Birthday>((person) => {
      const birthday = (person.birthday as JsonRecord | undefined)?.value as JsonRecord | undefined;
      if (!birthday) return [];
      const slugs = person.characterSlugs as string[] | undefined,
        personNames = person.name as string[] | undefined;
      const profiles = this.characterProfiles.filter((entry) => slugs?.includes(String(entry.id)));
      const voices = profiles
        .map((profile) => {
          const list = profile.name as string[] | undefined;
          return list?.[index] || list?.[0] || "";
        })
        .filter(Boolean)
        .join(" / ");
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
          nextAt: next(Number(birthday.month), Number(birthday.day)),
          external: !catalog,
          href: catalog ? `/catalog/characters?character=${catalog.characterId}` : "#",
          image: CAST_AVATAR(String(person.id || "")),
          kind: "cast",
          name: personNames?.[index] || personNames?.[0] || "—",
          voices: voices ? this.text("voicesRole", "Voices {name}").replace("{name}", voices) : "",
        },
      ];
    });
    return [...characters, ...cast].sort((a, b) => a.nextAt - b.nextAt || a.kind.localeCompare(b.kind)).slice(0, 6);
  }

  /* ---------- render: spotlight (banners + event) ---------- */
  private renderSpotlight() {
    const banners = this.banners;
    const track = banners.length > 1 ? [...banners, banners[0]] : banners;
    const slide = banners.length ? Math.min(this.slide, banners.length - 1) : 0;
    const event = this.featuredEvent();
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
        <div class="home-event" aria-label=${uiText(this.locale, "events")}>
          ${
            event
              ? html`
                  <a class="home-event__card" href=${`/catalog/${event.resource}?entry=${event.entry.id}`}>
                    <span class="home-event__overline">
                      ${uiText(this.locale, event.resource === "events" ? "events" : "realLives")}
                    </span>
                    <strong class="home-event__title">${event.entry.title}</strong>
                    ${
                      event.entry.image
                        ? html`
                            <img class="home-event__art" src=${event.entry.image} alt="" loading="lazy" />
                          `
                        : nothing
                    }
                    <span class="home-event__countdown tabular">
                      ${event.ending ? this.countdown(event.entry.endAt, true) : this.countdown(event.entry.startAt, false)}
                    </span>
                    <small class="home-event__range">
                      ${this.formatDate(event.entry.startAt)} – ${this.formatDate(event.entry.endAt)}
                    </small>
                  </a>
                `
              : html`
                  <div class="home-event__empty" role="status">
                    <span>${icon("event", 28)}</span>
                    <p>${this.text("noEvent", "No event is currently listed.")}</p>
                  </div>
                `
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
            <a class="button button--text" href="/catalog/songs">
              ${this.text("viewAll", "View all")}${icon("arrow_forward", 18)}
            </a>
          `,
        )}
        ${
          songs.length
            ? html`
                <div class="collection collection--song home-songs__grid">
                  ${songs.map(({ song }) => {
                    // The catalogue's own song tile, built by the same shared
                    // code — identical anatomy; only the date mark is added.
                    const release = this.releaseLabel(timestamp(song.publishedAt));
                    return tile(
                      songTile(
                        song,
                        {
                          locale: this.locale,
                          title: (entry) => ({
                            text: this.songTitle(entry),
                            locale: songTitle(entry, this.locale).locale,
                          }),
                          image: (entry) => String(entry.jacketThumbUrl || entry.jacketUrl || ""),
                          artist: (entry) =>
                            localizedText(entry.bandName, this.locale) ||
                            localizedText(
                              this.bands.find((band) => Number(band.bandId) === Number(entry.bandId))?.bandName,
                              this.locale,
                            ),
                          bandIcon: (entry) =>
                            String(this.bands.find((band) => Number(band.bandId) === Number(entry.bandId))?.icon || ""),
                          imageForLocale: (source) => localizedAssetUrl(source, this.locale),
                          attributeMark: (entry) => this.attributeMark(entry.musicType),
                          attributeLabel: () => String(song.musicType || ""),
                        },
                        `/catalog/songs?song=${song.musicId || song.id}`,
                        [release ? { at: "bottom-start" as const, text: release } : null],
                      ),
                    );
                  })}
                </div>
              `
            : html`
                <p class="home-empty" role="status">
                  ${this.phase === "loading" ? this.text("loading", "Loading…") : this.text("sourceUnavailable", "Unavailable")}
                </p>
              `
        }
      </section>
    `;
  }
  private renderDirectory() {
    const ready = this.phase !== "loading";
    return html`
      <section class="home-directory" aria-labelledby="home-directory-title">
        <h2 id="home-directory-title">${this.text("catalog", "Catalog")}</h2>
        ${directoryGroups().map(
          ([group, items]) => html`
            <div class="home-directory__group">
              <h3>${this.text(group, group)}</h3>
              <ul class="hub-grid" role="list">
                ${items.map((item) => {
                  const resource = CATALOG_HUB.find((entry) => entry.route === item.route)?.resource;
                  const value = resource ? this.counts[resource] : undefined;
                  return html`
                    <li>
                      <a class="hub-link state-layer" href=${item.route}>
                        <span class="hub-link__icon">${icon(item.icon, 22)}</span>
                        <span class="hub-link__label">${this.text(item.label, item.label)}</span>
                        <span class="hub-link__count tabular">
                          ${ready && value !== undefined ? this.count(value) : ""}
                        </span>
                      </a>
                    </li>
                  `;
                })}
              </ul>
            </div>
          `,
        )}
      </section>
    `;
  }
  private renderBirthdays() {
    const items = this.birthdays();
    const today = new Date().setHours(0, 0, 0, 0);
    return html`
      <section class="home-card" aria-labelledby="home-birthdays-title">
        ${this.moduleHeader(icon("cake"), this.text("birthdaysTitle", "Birthday countdown"), "home-birthdays-title")}
        ${
          items.length
            ? html`
                <ul class="birthday-list" role="list">
                  ${items.map((item) => {
                    const days = Math.round((item.nextAt - today) / 86400000);
                    return html`
                      <li>
                        <a
                          class="list-item list-item--interactive"
                          href=${item.href}
                          target=${item.external ? "_blank" : nothing}
                          rel=${item.external ? "noopener noreferrer" : nothing}
                          style=${`--accent:${item.color}`}
                        >
                          <span class="list-item__leading" aria-hidden="true">
                            ${
                              item.image
                                ? html`
                                    <img src=${item.image} alt="" loading="lazy" @error=${hideBrokenImage} />
                                  `
                                : nothing
                            }
                            ${
                              item.external
                                ? html`
                                    <span>${Array.from(item.name)[0] ?? "?"}</span>
                                  `
                                : nothing
                            }
                          </span>
                          <span class="list-item__body">
                            <span class="list-item__headline">${item.name}</span>
                            <span class="list-item__supporting">
                              ${this.text(item.kind, item.kind)}${item.voices ? ` · ${item.voices}` : ""} ·
                              ${this.formatDate(item.nextAt, true)}
                            </span>
                          </span>
                          <span class=${`list-item__meta birthday-list__days tabular${days === 0 ? " is-today" : ""}`}>
                            ${
                              days === 0
                                ? this.text("today", "Today")
                                : this.text(days === 1 ? "daysAwayOne" : "daysAway", "{count} days").replace(
                                    "{count}",
                                    String(days),
                                  )
                            }
                          </span>
                        </a>
                      </li>
                    `;
                  })}
                </ul>
              `
            : html`
                <p class="home-empty" role="status">${this.text("loading", "Loading…")}</p>
              `
        }
      </section>
    `;
  }
  private renderCommunity() {
    return html`
      <section class="home-card" aria-labelledby="home-community-title">
        ${this.moduleHeader(
          icon("forum"),
          this.text("communityTitle", "Trending community"),
          "home-community-title",
          html`
            <a class="button button--text" href="/community/feeds">
              ${this.text("openCommunity", "Open community")}${icon("arrow_forward", 18)}
            </a>
          `,
        )}
        ${
          this.posts.length
            ? html`
                <ol class="community-hot-list" role="list">
                  ${this.posts.map(
                    (post, index) => html`
                      <li>
                        <a class="list-item list-item--interactive" href=${`/community/posts/${post.id}`}>
                          <span class="list-item__marker tabular" aria-hidden="true">${index + 1}</span>
                          <span class="list-item__body">
                            <span class="list-item__headline">${String(post.title || post.excerpt || "—")}</span>
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
                    ${this.phase === "loading" ? this.text("loading", "Loading…") : this.text("communityEmpty", "There are no public community posts yet.")}
                  </p>
                </div>
              `
        }
      </section>
    `;
  }
  private renderNews() {
    const sources = [
      ["Our Notes", "bdon.biligames.com", "https://bdon.biligames.com/news/"],
      ["BanG Dream!", "bang-dream.com", "https://bang-dream.com/news"],
    ];
    return html`
      <section class="home-card" aria-labelledby="home-news-title">
        ${this.moduleHeader(
          icon("newspaper"),
          this.text("newsTitle", "News"),
          "home-news-title",
          html`
            <span class="home-card__meta">${this.text("officialSources", "Official sources")}</span>
          `,
        )}
        <ul class="news-list" role="list">
          ${sources.map(
            ([name, host, href]) => html`
              <li>
                <a class="list-item list-item--interactive" href=${href} target="_blank" rel="noopener noreferrer">
                  <span class="list-item__leading news-list__mark" aria-hidden="true">${icon("public", 20)}</span>
                  <span class="list-item__body">
                    <span class="list-item__headline">${name}</span>
                    <span class="list-item__supporting">${host}</span>
                  </span>
                  <span class="list-item__trailing">${icon("open_in_new", 18)}</span>
                </a>
              </li>
            `,
          )}
          <li>
            <div class="list-item">
              <span class="list-item__leading news-list__mark" aria-hidden="true">${icon("calendar_month", 20)}</span>
              <span class="list-item__body">
                <span class="list-item__headline">${this.text("scheduleTitle", "Event schedule")}</span>
                <span class="list-item__supporting">
                  ${this.text("scheduleEmpty", "There is no event schedule available for this server yet.")}
                </span>
              </span>
            </div>
          </li>
        </ul>
      </section>
    `;
  }
  private renderModule(id: ModuleId) {
    if (id === "songs") return this.renderSongs();
    if (id === "birthdays") return this.renderBirthdays();
    if (id === "community") return this.renderCommunity();
    return this.renderNews();
  }
  private moduleLabel(id: ModuleId) {
    return {
      songs: this.text("latestSongs", "Songs"),
      birthdays: this.text("birthdaysTitle", "Birthday countdown"),
      community: this.text("communityTitle", "Trending community"),
      news: this.text("newsTitle", "News"),
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
                    ?disabled=${index === 0}
                    aria-label=${this.text("moveUp", "Move up")}
                    @click=${() => this.move(id, -1)}
                  >
                    ${icon("arrow_upward", 22)}
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    ?disabled=${index === this.order.length - 1}
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
          ${visible.map(
            (id) => html`
              <div class=${`home-board__slot home-board__slot--${id}`}>${this.renderModule(id)}</div>
            `,
          )}
        </div>
        ${this.renderDirectory()}
        <footer class="home-footer">
          <p>haneoka · ${this.text("fanArchive", "Unofficial archive and community")}</p>
          <nav aria-label=${this.text("legalNavigation", "Policies and project information")}>
            <a class="text-link" href="/privacy">${this.text("privacy", "Privacy Policy")}</a>
            <a class="text-link" href="/terms">${this.text("terms", "Terms of Use")}</a>
            <a class="text-link" href="/about">${this.text("about", "About")}</a>
          </nav>
        </footer>
        ${this.renderDialog()}
      </div>
    `;
  }
}
if (!customElements.get("home-dashboard")) customElements.define("home-dashboard", HomeDashboard);
