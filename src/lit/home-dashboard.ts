import { LitElement, html, nothing, type PropertyValues } from "lit";
import { catalogUrl, fetchJson, localizedText, preferredLocale, recordValues, type JsonRecord } from "./shared/catalog";
import { SEED_EVENT, applySeed, currentSeed, isSeed, seedForBand, type Seed } from "../lib/tuning";

/* The home page is "the score": five bands are five staff lines, every song is a
 * note placed by its Expert level, and choosing a line re-tunes the whole site's
 * Material color scheme to that band (see lib/tuning.ts). */

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
type Band = { id: number; seed: Seed; name: string; songs: JsonRecord[]; levels: number[] };
type Note = { x: number; dy: number; title: string; level: number };

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
const NOTE_OFFSETS = [0, -7, 7, -14, 14, -21, 21];

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
/** Fine-grained level (e.g. 25.9) used to place a note along the staff. */
const expertLevel = (song: JsonRecord) => {
  const expert = expertRow(song);
  const level = Number(expert?.sortLevel ?? expert?.playLevel);
  return Number.isFinite(level) && level > 0 ? level : 0;
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
    seed: { state: true },
    playing: { state: true },
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
  declare seed: Seed;
  declare playing: Seed | "";
  private copies: Record<string, Record<string, string>> = {};
  private action?: HTMLButtonElement;
  private characterProfiles: JsonRecord[] = [];
  private castProfiles: JsonRecord[] = [];
  private playTimer = 0;
  private localeListener = (event: Event) => {
    this.locale = String((event as CustomEvent).detail || preferredLocale());
    this.syncAction();
  };
  private seedListener = (event: Event) => {
    const seed = (event as CustomEvent).detail;
    if (isSeed(seed)) this.seed = seed;
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
    this.seed = "haneoka";
    this.playing = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.copies = JSON.parse(this.labels || "{}");
    this.locale = preferredLocale(this.locale);
    this.seed = currentSeed();
    this.restoreLayout();
    addEventListener("haneoka:locale-ready", this.localeListener);
    addEventListener(SEED_EVENT, this.seedListener);
    void this.load();
    void this.loadProfiles();
    queueMicrotask(() => this.mountAction());
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.localeListener);
    removeEventListener(SEED_EVENT, this.seedListener);
    clearTimeout(this.playTimer);
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
    return localizedText(song.musicTitle || song.title, this.locale) || String(song.musicId || "—");
  }
  private bands(): Band[] {
    const names = new Map(this.bandRecords.map((band) => [Number(band.bandId), band]));
    return [1, 2, 3, 4, 5].map((id) => {
      const songs = this.songs.filter((song) =>
        Array.isArray(song.bandIds) ? (song.bandIds as unknown[]).map(Number).includes(id) : Number(song.bandId) === id,
      );
      return {
        id,
        seed: seedForBand(id),
        name: localizedText(names.get(id)?.bandName, this.locale) || `Band ${id}`,
        songs,
        levels: songs.map(expertLevel).filter(Boolean),
      };
    });
  }
  private levelDomain(bands: Band[]): [number, number] {
    const levels = bands.flatMap((band) => band.levels);
    if (!levels.length) return [18, 30];
    return [Math.floor(Math.min(...levels)) - 0.5, Math.ceil(Math.max(...levels)) + 0.5];
  }
  private notes(band: Band, [min, max]: [number, number]): Note[] {
    const seen = new Map<number, number>();
    return band.songs
      .map((song) => ({ song, level: expertLevel(song) }))
      .filter((entry) => entry.level)
      .sort((a, b) => a.level - b.level || Number(a.song.musicId) - Number(b.song.musicId))
      .map(({ song, level }) => {
        const key = Math.round(level * 2) / 2;
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        // Songs at the same level stack like a chord; a 7th+ note nudges sideways.
        const nudge = Math.floor(index / NOTE_OFFSETS.length) * 0.8;
        return {
          x: ((level - min) / (max - min)) * 100 + nudge,
          dy: NOTE_OFFSETS[index % NOTE_OFFSETS.length],
          title: `${this.songTitle(song)} · EXPERT ${expertDisplayLevel(song) || Math.round(level)}`,
          level,
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
  private tune(seed: Seed, source?: HTMLElement) {
    const rect = source?.getBoundingClientRect();
    applySeed(seed, rect ? { x: rect.left + Math.min(rect.width, 160) / 2, y: rect.top + rect.height / 2 } : undefined);
    this.seed = seed;
    if (seed === "haneoka") return;
    // "Play" the chosen line once: its notes bounce left to right.
    clearTimeout(this.playTimer);
    this.playing = seed;
    this.playTimer = window.setTimeout(() => (this.playing = ""), 900);
  }
  private onStaffKeydown(event: KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const radios = [...this.querySelectorAll<HTMLElement>(".staff [role='radio']")];
    const current = radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : (Math.max(0, current) + step + radios.length) % radios.length;
    const target = radios[next];
    const seed = target?.dataset.seed;
    if (!target || !isSeed(seed)) return;
    this.tune(seed, target);
    void this.updateComplete.then(() => target.focus());
  }

  /* ---------- render: hero ---------- */
  private renderHero(bands: Band[]) {
    const domain = this.levelDomain(bands);
    const ticks: number[] = [];
    for (let level = Math.ceil(domain[0]); level <= domain[1]; level += 1) if (level % 2 === 0) ticks.push(level);
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
        <div
          class="staff"
          role="radiogroup"
          aria-labelledby="staff-title"
          aria-describedby="staff-hint"
          @keydown=${this.onStaffKeydown}
        >
          <div class="staff__header">
            <h3 id="staff-title" class="staff__title">
              ${icon("tune", 20)}${this.text("tuneTitle", "Tune the archive")}
            </h3>
            <button
              class="chip staff__default"
              type="button"
              role="radio"
              data-seed="haneoka"
              aria-checked=${String(this.seed === "haneoka")}
              tabindex=${this.seed === "haneoka" ? 0 : -1}
              @click=${(event: Event) => this.tune("haneoka", event.currentTarget as HTMLElement)}
            >
              ${this.seed === "haneoka" ? icon("check", 18) : icon("restart_alt", 18)}${this.text("tuneDefault", "Original key")}
            </button>
          </div>
          <p id="staff-hint" class="staff__hint">
            ${this.text("tuneHint", "Pick a line of the staff and the whole site re-tunes to that band.")}
          </p>
          <div class="staff__lines">
            ${bands.map((band) => {
              const checked = this.seed === band.seed;
              const notes = this.notes(band, domain);
              const shown = band.songs.map(expertDisplayLevel).filter(Boolean);
              const range = shown.length ? `EXPERT ${Math.min(...shown)}–${Math.max(...shown)}` : "";
              const summary = this.text("songsCount", "{count} songs").replace(
                "{count}",
                this.count(band.songs.length),
              );
              return html`
                <button
                  class=${`staff-line${checked ? " is-checked" : ""}${this.playing === band.seed ? " is-playing" : ""}`}
                  type="button"
                  role="radio"
                  data-seed=${band.seed}
                  aria-checked=${String(checked)}
                  tabindex=${checked ? 0 : -1}
                  aria-label=${`${band.name}, ${summary}${range ? `, ${range}` : ""}`}
                  style=${`--band: var(--md-ref-${band.seed}); --band-container: var(--md-ref-${band.seed}-container); --band-on-container: var(--md-ref-${band.seed}-on-container)`}
                  @click=${(event: Event) => this.tune(band.seed, event.currentTarget as HTMLElement)}
                >
                  <span class="staff-line__clef">
                    <strong>${band.name}</strong>
                    <small class="tabular">
                      ${ready ? summary : "—"}${
                        ready && range
                          ? html`
                              <span class="staff-line__range">· ${range.replace("EXPERT ", "Lv ")}</span>
                            `
                          : nothing
                      }
                    </small>
                  </span>
                  <span class="staff-line__track" aria-hidden="true">
                    ${notes.map(
                      (note, index) => html`
                        <i
                          class="staff-note"
                          style=${`--x:${note.x.toFixed(2)}%;--dy:${note.dy}px;--i:${index}`}
                          title=${note.title}
                        ></i>
                      `,
                    )}
                  </span>
                </button>
              `;
            })}
          </div>
          <div class="staff__axis" aria-hidden="true">
            <span class="staff__axis-label">${this.text("expertLevel", "Expert level")}</span>
            <span class="staff__ticks">
              ${ticks.map(
                (level) => html`
                  <span style=${`--x:${(((level - domain[0]) / (domain[1] - domain[0])) * 100).toFixed(2)}%`}>
                    ${level}
                  </span>
                `,
              )}
            </span>
          </div>
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
  private renderBand(bands: Band[]) {
    const band = bands.find((entry) => entry.seed === this.seed);
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
                <ol class="song-strip" role="list">
                  ${songs.map(({ song, level }) => {
                    const image = String(song.jacketThumbUrl || song.jacketUrl || "");
                    return html`
                      <li>
                        <a class="song-tile" href=${`/catalog/songs?song=${song.musicId || song.id}`}>
                          <span class="song-tile__jacket">
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
                                    <span class="song-tile__level tabular">${level}</span>
                                  `
                                : nothing
                            }
                          </span>
                          <span class="song-tile__title">${this.songTitle(song)}</span>
                        </a>
                      </li>
                    `;
                  })}
                </ol>
              `
            : html`
                <p class="home-empty">
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
                          <span class="birthday-list__avatar" aria-hidden="true">
                            ${
                              item.image
                                ? html`
                                    <img src=${item.image} alt="" loading="lazy" @error=${hideBrokenImage} />
                                  `
                                : nothing
                            }
                            <span>${Array.from(item.name)[0] ?? "?"}</span>
                          </span>
                          <span class="birthday-list__copy">
                            <span class="list-item__headline">${item.name}</span>
                            <span class="list-item__supporting">
                              ${this.text(item.kind, item.kind)} · ${this.formatDate(item.nextAt, true)}
                            </span>
                          </span>
                          <span class=${`birthday-list__days tabular${days === 0 ? " is-today" : ""}`}>
                            ${days === 0 ? this.text("today", "Today") : this.text("daysAway", "{count} days").replace("{count}", String(days))}
                          </span>
                        </a>
                      </li>
                    `;
                  })}
                </ul>
              `
            : html`
                <p class="home-empty">${this.text("loading", "Loading…")}</p>
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
                          <span class="community-hot-list__rank tabular" aria-hidden="true">${index + 1}</span>
                          <span class="community-hot-list__copy">
                            <span class="list-item__headline">${String(post.title || post.excerpt || "—")}</span>
                            <span class="list-item__supporting">
                              ${String(post.authorName || "")}${post.createdAt ? ` · ${this.formatDate(String(post.lastEditedAt || post.createdAt))}` : ""}
                            </span>
                          </span>
                          <span class="community-hot-list__score tabular">
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
                <div class="home-empty home-empty--illustrated">
                  ${icon("forum", 32)}
                  <p>
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
                  <span class="news-list__mark" aria-hidden="true">${icon("public", 20)}</span>
                  <span>
                    <span class="list-item__headline">${name}</span>
                    <span class="list-item__supporting">${host}</span>
                  </span>
                  ${icon("open_in_new", 18)}
                </a>
              </li>
            `,
          )}
          <li>
            <div class="list-item">
              <span class="news-list__mark" aria-hidden="true">${icon("calendar_month", 20)}</span>
              <span>
                <span class="list-item__headline">${this.text("scheduleTitle", "Event schedule")}</span>
                <span class="list-item__supporting">
                  ${this.text("scheduleEmpty", "There is no event schedule available for this server yet.")}
                </span>
              </span>
              <span></span>
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
