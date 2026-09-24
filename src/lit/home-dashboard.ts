import { observeSongDisplay, songTitle } from "../lib/song-display";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import {
  catalogUrl,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  uiText,
  type JsonRecord,
} from "./shared/catalog";

type ModuleId = "band" | "hub" | "birthdays" | "community" | "news";
type Birthday = {
  color: string;
  href: string;
  image: string;
  kind: "character" | "cast";
  name: string;
  nextAt: number;
  external: boolean;
};
type Band = { id: number; name: string; image: string; songs: JsonRecord[] };

const MODULES: ModuleId[] = ["band", "hub", "birthdays", "community", "news"];
const PROFILE_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const STORAGE_KEY = "haneoka:home-layout:v2";
const HUB = [
  ["songs", "library_music", "/catalog/songs", "songs"],
  ["memberCards", "style", "/catalog/member-cards", "cards"],
  ["supportCards", "collections", "/catalog/support-cards", "support-cards"],
  ["characters", "group", "/catalog/characters", "characters"],
  ["stories", "auto_stories", "/catalog/stories", "stories"],
  ["stamps", "emoji_emotions", "/catalog/stamps", "stamps"],
  ["comics", "menu_book", "/catalog/comics", "comics"],
  ["items", "inventory_2", "/catalog/items", "items"],
  ["bandItems", "piano", "/catalog/band-items", "band-items"],
  ["help", "help", "/catalog/help", "help"],
] as const;
/* MasterBand colours for the character-profile fallback (profiles use slugs, not ids). */
const PROFILE_BAND_SEED: Record<string, string> = {
  mygo: "var(--md-ref-band-1)",
  avemujica: "var(--md-ref-band-2)",
  yumemita: "var(--md-ref-band-3)",
  millsage: "var(--md-ref-band-4)",
  "ikka-dumb-rock": "var(--md-ref-band-5)",
};

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
const expertRow = (song: JsonRecord) => {
  const rows = Array.isArray(song.difficulty) ? (song.difficulty as JsonRecord[]) : [];
  return rows.find((row) => row.difficultyName === "expert") ?? rows.at(-1);
};
/** The level players see in game (an integer). */
const expertDisplayLevel = (song: JsonRecord) => {
  const expert = expertRow(song);
  const level = Number(expert?.displayLevel ?? expert?.playLevel);
  return Number.isFinite(level) && level > 0 ? level : 0;
};
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
    bandRecords: { state: true },
    counts: { state: true },
    posts: { state: true },
    order: { state: true },
    hiddenModules: { state: true },
    selectedBand: { state: true },
  };
  declare locale: string;
  declare labels: string;
  declare phase: "loading" | "ready" | "error";
  declare songs: JsonRecord[];
  declare characters: JsonRecord[];
  declare bandRecords: JsonRecord[];
  declare counts: Record<string, number>;
  declare posts: JsonRecord[];
  declare order: ModuleId[];
  declare hiddenModules: Record<string, boolean>;
  declare selectedBand: number;
  private copies: Record<string, Record<string, string>> = {};
  private action?: HTMLButtonElement;
  private characterProfiles: JsonRecord[] = [];
  private castProfiles: JsonRecord[] = [];
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
    this.bandRecords = [];
    this.counts = {};
    this.posts = [];
    this.order = [...MODULES];
    this.hiddenModules = {};
    this.selectedBand = 0;
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
    try {
      this.selectedBand = Math.max(0, Number(sessionStorage.getItem("haneoka.home.band")) || 0);
    } catch {}
    this.restoreLayout();
    addEventListener("haneoka:locale-ready", this.localeListener);
    void this.load();
    void this.loadProfiles();
    queueMicrotask(() => this.mountAction());
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    this.action?.remove();
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("locale")) this.syncAction();
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
    const [summary, songs, characters, bands, posts] = await Promise.allSettled([
      fetchJson<JsonRecord>(catalogUrl("catalog/summary")),
      fetchJson<JsonRecord>(catalogUrl("songs")),
      fetchJson<JsonRecord>(catalogUrl("characters")),
      fetchJson<JsonRecord>(catalogUrl("bands")),
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
    if (bands.status === "fulfilled") this.bandRecords = values(bands.value);
    if (posts.status === "fulfilled")
      this.posts = Array.isArray(posts.value.posts) ? (posts.value.posts as JsonRecord[]) : [];
    this.phase = [summary, songs, characters].some((result) => result.status === "fulfilled") ? "ready" : "error";
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
  private bands(): Band[] {
    const names = new Map(this.bandRecords.map((band) => [Number(band.bandId), band]));
    return [...names.keys()]
      .filter((id) => id > 0)
      .sort((a, b) => a - b)
      .map((id) => {
        const songs = this.songs.filter((song) =>
          Array.isArray(song.bandIds)
            ? (song.bandIds as unknown[]).map(Number).includes(id)
            : Number(song.bandId) === id,
        );
        return {
          id,
          image: String(names.get(id)?.icon || names.get(id)?.logo || ""),
          name: localizedText(names.get(id)?.bandName, this.locale) || `Band ${id}`,
          songs,
        };
      });
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
        names = profile.name as string[] | undefined,
        sources = profile.sources as JsonRecord | undefined,
        images = profile.images as string[] | undefined;
      const match = birthdays?.[0]?.match(/^(\d{1,2})月(\d{1,2})日$/);
      if (!match || !names) return [];
      const catalog = this.characterFor(String(profile.slug || ""), names);
      return [
        {
          color: String(catalog?.colorCode || PROFILE_BAND_SEED[String(profile.band)] || "var(--md-sys-color-primary)"),
          nextAt: next(Number(match[1]), Number(match[2])),
          external: !catalog,
          href: catalog ? `/catalog/characters?character=${catalog.characterId}` : String(sources?.global || "#"),
          image: String(catalog?.faceImage || catalog?.thumbnailImage || catalog?.profileImage || images?.[0] || ""),
          kind: "character",
          name: names[index] || names[0],
        },
      ];
    });
    const cast = this.castProfiles.flatMap<Birthday>((person) => {
      const birthday = (person.birthday as JsonRecord | undefined)?.value as JsonRecord | undefined;
      if (!birthday) return [];
      const slugs = person.characterSlugs as string[] | undefined,
        personNames = person.name as string[] | undefined,
        links = person.officialLinks as JsonRecord[] | undefined,
        birthdaySources = (person.birthday as JsonRecord | undefined)?.sourceUrls as string[] | undefined;
      const profile = this.characterProfiles.find((entry) => slugs?.includes(String(entry.id)));
      const names = profile?.name as string[] | undefined;
      const catalog = profile && names ? this.characterFor(String(profile.slug || ""), names) : undefined;
      const profileImages = profile?.images as string[] | undefined;
      return [
        {
          color: String(
            catalog?.colorCode ||
              (profile ? PROFILE_BAND_SEED[String(profile.band)] : "") ||
              "var(--md-sys-color-tertiary)",
          ),
          nextAt: next(Number(birthday.month), Number(birthday.day)),
          external: true,
          href: String(links?.[0]?.url || birthdaySources?.[0] || "#"),
          image: String(
            catalog?.faceImage || catalog?.thumbnailImage || catalog?.profileImage || profileImages?.[0] || "",
          ),
          kind: "cast",
          name: personNames?.[index] || personNames?.[0] || "—",
        },
      ];
    });
    return [...characters, ...cast].sort((a, b) => a.nextAt - b.nextAt || a.kind.localeCompare(b.kind)).slice(0, 6);
  }

  /* ---------- tuning ---------- */
  private selectBand(id: number) {
    this.selectedBand = id;
    try {
      sessionStorage.setItem("haneoka.home.band", String(id));
    } catch {}
  }

  /* ---------- render: hero ---------- */
  private renderHero(bands: Band[]) {
    const ready = this.phase !== "loading";
    const stats = [
      ["songs", this.counts.songs ?? this.songs.length],
      ["memberCards", this.counts.cards],
      ["stories", this.counts.stories],
      ["characters", this.counts.characters ?? this.characters.length],
    ] as const;
    return html`
      <section class="home-hero" aria-labelledby="home-hero-title">
        <div class="home-hero__intro">
          <p class="home-hero__overline">BanG Dream! Our Notes</p>
          <h2 id="home-hero-title" class="home-hero__title">
            ${this.text("purpose", "BanG Dream! Our Notes archive and community")}
          </h2>
          <dl class="home-stats" aria-label=${this.text("archiveOverview", "Archive overview")}>
            ${stats.map(
              ([key, value]) => html`
                <div>
                  <dt>${this.text(key, key)}</dt>
                  <dd class="tabular">${ready && Number.isFinite(value) ? this.count(Number(value)) : "—"}</dd>
                </div>
              `,
            )}
          </dl>
        </div>
        <section class="home-bands" aria-labelledby="home-bands-title">
          <header class="home-bands__header">
            <h3 id="home-bands-title">${uiText(this.locale, "bands")}</h3>
            <button
              class="button button--text"
              type="button"
              aria-pressed=${String(this.selectedBand === 0)}
              @click=${() => this.selectBand(0)}
            >
              ${uiText(this.locale, "all")}
            </button>
          </header>
          <div class="home-bands__list">
            ${bands.map((band) => {
              const shown = band.songs.map(expertDisplayLevel).filter(Boolean);
              const summary = this.text("songsCount", "{count} songs").replace(
                "{count}",
                this.count(band.songs.length),
              );
              return html`
                <button
                  class="home-bands__item state-layer"
                  type="button"
                  aria-pressed=${String(this.selectedBand === band.id)}
                  @click=${() => this.selectBand(band.id)}
                >
                  <span class="home-bands__art">
                    ${
                      band.image
                        ? html`
                            <img src=${band.image} alt="" loading="lazy" @error=${hideBrokenImage} />
                          `
                        : icon("groups", 24)
                    }
                  </span>
                  <span>
                    <strong>${band.name}</strong>
                    <small>
                      ${summary}${shown.length ? ` · EXPERT ${Math.min(...shown)}–${Math.max(...shown)}` : ""}
                    </small>
                  </span>
                  ${icon(this.selectedBand === band.id ? "check" : "chevron_right", 20)}
                </button>
              `;
            })}
          </div>
        </section>
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
  private renderBand(bands: Band[]) {
    const band = bands.find((entry) => entry.id === this.selectedBand);
    const songs = (band ? band.songs : this.songs)
      .map((song) => ({ song, time: timestamp(song.publishedAt), level: expertDisplayLevel(song) }))
      .sort((a, b) => b.time - a.time || Number(b.song.musicId) - Number(a.song.musicId))
      .slice(0, 16);
    const members = band
      ? this.characters
          .filter((character) => Number(character.bandId) === band.id)
          .sort(
            (a, b) => Number(a.displayOrder) - Number(b.displayOrder) || Number(a.characterId) - Number(b.characterId),
          )
      : [];
    const title = band ? band.name : this.text("latestSongs", "Songs");
    const allHref = band ? `/catalog/songs?band=${band.id}` : "/catalog/songs";
    return html`
      <section class="home-card home-band" aria-labelledby="home-band-title">
        ${this.moduleHeader(
          band ? icon("queue_music") : icon("library_music"),
          title,
          "home-band-title",
          html`
            <a class="button button--text" href=${allHref}>
              ${this.text("viewAll", "View all")}${icon("arrow_forward", 18)}
            </a>
          `,
        )}
        ${
          members.length
            ? html`
                <ul class="member-row" role="list" aria-label=${this.text("members", "Members")}>
                  ${members.map((member) => {
                    const name = localizedText(member.characterName, this.locale);
                    const image = String(member.faceImage || member.thumbnailImage || "");
                    return html`
                      <li>
                        <a
                          class="member-chip"
                          href=${`/catalog/characters?character=${member.characterId}`}
                          style=${`--member:${String(member.colorCode || "var(--band)")}`}
                        >
                          <span class="member-chip__avatar" aria-hidden="true">
                            ${
                              image
                                ? html`
                                    <img src=${image} alt="" loading="lazy" @error=${hideBrokenImage} />
                                  `
                                : nothing
                            }
                            <span>${Array.from(name)[0] ?? "?"}</span>
                          </span>
                          <span class="member-chip__name">${name}</span>
                        </a>
                      </li>
                    `;
                  })}
                </ul>
              `
            : nothing
        }
        ${
          songs.length
            ? html`
                <ol class="strip strip--inset" role="list">
                  ${songs.map(({ song, level }) => {
                    const image = String(song.jacketThumbUrl || song.jacketUrl || "");
                    return html`
                      <li>
                        <a
                          class="tile tile--interactive tile--plain tile--song"
                          href=${`/catalog/songs?song=${song.musicId || song.id}`}
                        >
                          <span class="tile__media">
                            ${icon("music_note", 28)}
                            ${
                              image
                                ? html`
                                    <img src=${image} alt="" loading="lazy" @error=${hideBrokenImage} />
                                  `
                                : nothing
                            }
                            ${
                              level
                                ? html`
                                    <span class="tile__mark tile__mark--bottom-end tile__mark--accent tabular">
                                      ${level}
                                    </span>
                                  `
                                : nothing
                            }
                          </span>
                          <span class="tile__identity">
                            <strong class="tile__title" lang=${songTitle(song, this.locale).locale}>
                              ${this.songTitle(song)}
                            </strong>
                          </span>
                        </a>
                      </li>
                    `;
                  })}
                </ol>
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
  private renderHub() {
    const ready = this.phase !== "loading";
    return html`
      <section class="home-hub" aria-labelledby="home-hub-title">
        <h2 id="home-hub-title" class="sr-only">${this.text("catalog", "Catalog")}</h2>
        <ul class="hub-grid" role="list">
          ${HUB.map(([key, iconName, href, resource]) => {
            const value = this.counts[resource];
            return html`
              <li>
                <a class="hub-link state-layer" href=${href}>
                  <span class="hub-link__icon">${icon(iconName, 22)}</span>
                  <span class="hub-link__label">${this.text(key, key)}</span>
                  <span class="hub-link__count tabular">${ready && value !== undefined ? this.count(value) : ""}</span>
                </a>
              </li>
            `;
          })}
          <li>
            <a class="hub-link hub-link--more state-layer" href="/catalog">
              <span class="hub-link__icon">${icon("apps", 22)}</span>
              <span class="hub-link__label">${this.text("viewAll", "View all")}</span>
              <span class="hub-link__count">${icon("arrow_forward", 18)}</span>
            </a>
          </li>
        </ul>
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
                            <span>${Array.from(item.name)[0] ?? "?"}</span>
                          </span>
                          <span class="list-item__body">
                            <span class="list-item__headline">${item.name}</span>
                            <span class="list-item__supporting">
                              ${this.text(item.kind, item.kind)} · ${this.formatDate(item.nextAt, true)}
                            </span>
                          </span>
                          <span class=${`list-item__meta birthday-list__days tabular${days === 0 ? " is-today" : ""}`}>
                            ${days === 0 ? this.text("today", "Today") : this.text("daysAway", "{count} days").replace("{count}", String(days))}
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
  private renderModule(id: ModuleId, bands: Band[]) {
    if (id === "band") return this.renderBand(bands);
    if (id === "hub") return this.renderHub();
    if (id === "birthdays") return this.renderBirthdays();
    if (id === "community") return this.renderCommunity();
    return this.renderNews();
  }
  private moduleLabel(id: ModuleId) {
    return {
      band: this.text("latestSongs", "Songs"),
      hub: this.text("catalog", "Catalog"),
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
    const bands = this.bands();
    const visible = this.order.filter((id) => !this.hiddenModules[id]);
    return html`
      <div class="home">
        ${this.renderHero(bands)}
        <div class="home-board">
          ${visible.map(
            (id) => html`
              <div class=${`home-board__slot home-board__slot--${id}`}>${this.renderModule(id, bands)}</div>
            `,
          )}
        </div>
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
