import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson, localizedText, preferredLocale, recordValues, type JsonRecord } from "./shared/catalog";

type ModuleId = "schedule" | "news" | "birthdays" | "community" | "updates";
type Birthday = {
  color: string;
  href: string;
  image: string;
  kind: "character" | "cast";
  name: string;
  nextAt: number;
  external: boolean;
};
const MODULES: ModuleId[] = ["schedule", "news", "birthdays", "community", "updates"];
const PROFILE_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const STORAGE_KEY = "haneoka:home-layout:v1";
const icon = (name: string, size = 18) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
`;
const values = (value: unknown, key?: string): JsonRecord[] =>
  key ? recordValues((value as JsonRecord | undefined)?.[key]) : recordValues(value);
const timestamp = (value: unknown) =>
  Array.isArray(value)
    ? Math.max(0, ...value.map(Number).filter((entry) => Number.isFinite(entry) && entry > 0))
    : Number(value) || 0;

export class HomeDashboard extends LitElement {
  static properties = {
    locale: { type: String },
    labels: { type: String },
    phase: { state: true },
    stories: { state: true },
    songs: { state: true },
    characters: { state: true },
    posts: { state: true },
    density: { state: true },
    order: { state: true },
    hiddenModules: { state: true },
    layoutOpen: { state: true },
  };
  declare locale: string;
  declare labels: string;
  declare phase: string;
  declare stories: JsonRecord[];
  declare songs: JsonRecord[];
  declare characters: JsonRecord[];
  declare posts: JsonRecord[];
  declare density: "compact" | "comfortable";
  declare order: ModuleId[];
  declare hiddenModules: Record<string, boolean>;
  declare layoutOpen: boolean;
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
    this.stories = [];
    this.songs = [];
    this.characters = [];
    this.posts = [];
    this.density = "compact";
    this.order = [...MODULES];
    this.hiddenModules = {};
    this.layoutOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.copies = JSON.parse(this.labels || "{}");
    this.locale = preferredLocale(this.locale);
    this.restoreLayout();
    addEventListener("haneoka:locale-ready", this.localeListener);
    void this.load();
    void this.loadProfiles();
    queueMicrotask(() => this.mountAction());
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.localeListener);
    this.action?.remove();
    super.disconnectedCallback();
  }
  private get copy() {
    return this.copies[this.locale] || this.copies.ja || {};
  }
  private text(key: string, fallback: string) {
    return this.copy[key] || fallback;
  }
  private syncAction() {
    if (!this.action) return;
    const label = this.text("customizeLayout", "Customize layout");
    this.action.ariaLabel = label;
    const copy = this.action.querySelector("span");
    if (copy) copy.textContent = label;
  }
  private mountAction() {
    const host = document.querySelector("[data-top-app-bar-actions]");
    if (!host || this.action?.isConnected) return;
    const button = document.createElement("button");
    button.className = "home-toolbar-action";
    button.type = "button";
    button.innerHTML = `<svg class="material-icon" width="20" height="20"><use href="/icons.svg#dashboard_customize"></use></svg><span></span>`;
    button.addEventListener("click", () => {
      this.layoutOpen = true;
    });
    host.append(button);
    this.action = button;
    this.syncAction();
  }
  private async load() {
    this.phase = "loading";
    const results = await Promise.allSettled([
      fetchJson<JsonRecord>(catalogUrl("stories")),
      fetchJson<JsonRecord>(catalogUrl("songs")),
      fetchJson<JsonRecord>(catalogUrl("characters")),
      fetchJson<JsonRecord>("/api/v1/community/posts?limit=5&scope=recommended"),
    ]);
    if (results[0].status === "fulfilled") this.stories = values(results[0].value, "episodes");
    if (results[1].status === "fulfilled") this.songs = values(results[1].value);
    if (results[2].status === "fulfilled") this.characters = values(results[2].value);
    if (results[3].status === "fulfilled")
      this.posts = Array.isArray(results[3].value.posts) ? (results[3].value.posts as JsonRecord[]) : [];
    this.phase = results.slice(0, 3).some((result) => result.status === "fulfilled") ? "ready" : "error";
  }
  private async loadProfiles() {
    const [characters, cast] = await Promise.all([import("../data/characterProfiles"), import("../data/castProfiles")]);
    this.characterProfiles = characters.characterProfiles as unknown as JsonRecord[];
    this.castProfiles = cast.castProfiles as unknown as JsonRecord[];
    this.requestUpdate();
  }
  private restoreLayout() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (state?.density === "compact" || state?.density === "comfortable") this.density = state.density;
      if (
        Array.isArray(state?.order) &&
        state.order.length === MODULES.length &&
        MODULES.every((id) => state.order.includes(id))
      )
        this.order = state.order;
      if (state?.hidden && typeof state.hidden === "object") this.hiddenModules = state.hidden;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  private persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ density: this.density, order: this.order, hidden: this.hiddenModules }),
      );
    } catch {}
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
    this.density = "compact";
    this.persist();
  }
  private formatDate(value: number | string, short = false) {
    const date = new Date(typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat(
          this.locale,
          short ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
        ).format(date);
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
    const color: Record<string, string> = {
      mygo: "#3388bb",
      avemujica: "#745387",
      yumemita: "#d950a7",
      millsage: "#3d998e",
      "ikka-dumb-rock": "#d96558",
    };
    const characters = this.characterProfiles.flatMap<Birthday>((profile) => {
      const birthdays = profile.birthday as string[] | undefined,
        names = profile.name as string[] | undefined,
        sources = profile.sources as JsonRecord | undefined,
        images = profile.images as string[] | undefined;
      const match = birthdays?.[0]?.match(/^(\d{1,2})月(\d{1,2})日$/);
      if (!match || !names) return [];
      const catalog = this.characterFor(String(profile.slug || ""), names);
      const month = Number(match[1]),
        day = Number(match[2]);
      return [
        {
          color: String(catalog?.colorCode || color[String(profile.band)]),
          nextAt: next(month, day),
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
          color: String(catalog?.colorCode || (profile ? color[String(profile.band)] : "#a63666")),
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
    return [...characters, ...cast].sort((a, b) => a.nextAt - b.nextAt || a.kind.localeCompare(b.kind)).slice(0, 5);
  }
  private latestSongs() {
    return [...this.songs]
      .map((song) => ({ song, time: timestamp(song.publishedAt || song.releasedAt) }))
      .filter((item) => item.time)
      .sort((a, b) => b.time - a.time)
      .slice(0, 6);
  }
  private itemTitle(item: JsonRecord) {
    return (
      localizedText(item.musicTitle || item.title || item.name, this.locale) || String(item.musicId || item.id || "—")
    );
  }
  private renderHeader(iconName: string, title: string, aside: unknown = nothing) {
    return html`
      <header class="home-module__header">
        <div>
          ${icon(iconName)}
          <h2>${title}</h2>
        </div>
        ${aside}
      </header>
    `;
  }
  private renderModule(id: ModuleId) {
    if (id === "schedule")
      return html`
        <section class="home-module home-module--wide">
          ${this.renderHeader("calendar_month", this.text("scheduleTitle", "Event schedule"))}
          <p class="home-empty">
            ${this.text("scheduleEmpty", "There is no event schedule available for this server yet.")}
          </p>
        </section>
      `;
    if (id === "news")
      return html`
        <section class="home-module home-module--news">
          ${this.renderHeader(
            "newspaper",
            this.text("newsTitle", "News"),
            html`
              <span>${this.text("officialSources", "Official sources")}</span>
            `,
          )}
          <div class="news-columns">
            ${[
              ["Our Notes", "https://bdon.biligames.com/news/"],
              ["BanG Dream!", "https://bang-dream.com/news"],
            ].map(
              ([name, href]) => html`
                <article class="news-column">
                  <header>
                    <h3>${name}</h3>
                    <a href=${href} target="_blank" rel="noopener noreferrer" aria-label=${name}>
                      ${icon("open_in_new", 14)}
                    </a>
                  </header>
                  <p class="home-empty">${this.text("sourceUnavailable", "Source temporarily unavailable")}</p>
                </article>
              `,
            )}
          </div>
        </section>
      `;
    if (id === "birthdays") {
      const items = this.birthdays();
      return html`
        <section class="home-module home-module--birthdays">
          ${this.renderHeader(
            "cake",
            this.text("birthdaysTitle", "Birthday countdown"),
            html`
              <span>${this.text("characterAndCast", "Characters / cast")}</span>
            `,
          )}
          <ul class="birthday-list">
            ${items.map((item) => {
              const days = Math.round((item.nextAt - new Date().setHours(0, 0, 0, 0)) / 86400000);
              return html`
                <li>
                  <a
                    href=${item.href}
                    target=${item.external ? "_blank" : nothing}
                    rel=${item.external ? "noopener noreferrer" : nothing}
                    style=${`--birthday-accent:${item.color}`}
                  >
                    <span class="birthday-list__portrait">
                      ${
                        item.image
                          ? html`
                              <img src=${item.image} alt="" loading="lazy" />
                            `
                          : icon("cake", 16)
                      }
                    </span>
                    <span class="birthday-list__identity">
                      <strong>${item.name}</strong>
                      <small>${this.text(item.kind, item.kind)}</small>
                    </span>
                    <time datetime=${new Date(item.nextAt).toISOString()}>
                      <strong>${this.formatDate(item.nextAt, true)}</strong>
                      <small>
                        ${days === 0 ? this.text("today", "Today") : this.text("daysAway", "{count} days").replace("{count}", String(days))}
                      </small>
                    </time>
                  </a>
                </li>
              `;
            })}
          </ul>
        </section>
      `;
    }
    if (id === "community")
      return html`
        <section class="home-module home-module--community">
          ${this.renderHeader(
            "forum",
            this.text("communityTitle", "Trending community"),
            html`
              <a href="/community">${this.text("openCommunity", "Open community")}${icon("chevron_right", 16)}</a>
            `,
          )}${
            this.posts.length
              ? html`
                  <ol class="community-hot-list">
                    ${this.posts.map(
                      (post, index) => html`
                        <li>
                          <a href=${`/community/posts/${post.id}`}>
                            <span class="community-hot-list__rank">${String(index + 1).padStart(2, "0")}</span>
                            <span class="community-hot-list__copy">
                              <strong>${String(post.title || post.excerpt || "—")}</strong>
                              <small>
                                ${String(post.authorName || "")}${
                                  post.createdAt
                                    ? html`
                                        <span class="meta-separator" aria-hidden="true"></span>
                                        ${this.formatDate(String(post.lastEditedAt || post.createdAt))}
                                      `
                                    : nothing
                                }
                              </small>
                            </span>
                            <span class="community-hot-list__score">
                              ${icon("favorite", 13)} ${Number(post.likeCount || 0)} ${icon("chat_bubble", 13)}
                              ${Number(post.commentCount || 0)}
                            </span>
                          </a>
                        </li>
                      `,
                    )}
                  </ol>
                `
              : html`
                  <p class="home-empty">
                    ${this.phase === "loading" ? this.text("loading", "Loading…") : this.text("communityEmpty", "There are no public community posts yet.")}
                  </p>
                `
          }
        </section>
      `;
    const songs = this.latestSongs();
    return html`
      <section class="home-module home-module--updates">
        ${this.renderHeader(
          "inventory_2",
          this.text("updatesTitle", "Recent archive updates"),
          html`
            <a href="/catalog/songs">${this.text("browseSongs", "Browse songs")}${icon("chevron_right", 16)}</a>
          `,
        )}${
          songs.length
            ? html`
                <div class="release-strip">
                  ${songs.map(
                    ({ song, time }) => html`
                      <a href=${`/catalog/songs?song=${song.musicId || song.id}`}>
                        <img
                          src=${String(song.jacketThumbUrl || song.jacketUrl || song.jacket || "")}
                          data-fallback=${String(song.jacketUrl || "")}
                          alt=""
                          loading="lazy"
                          @error=${(event: Event) => {
                            const image = event.currentTarget as HTMLImageElement,
                              fallback = image.dataset.fallback || "";
                            if (fallback && image.src !== new URL(fallback, location.href).href) image.src = fallback;
                            else image.hidden = true;
                          }}
                        />
                        <span>
                          <strong>${this.itemTitle(song)}</strong>
                          <time datetime=${new Date(time).toISOString()}>${this.formatDate(time)}</time>
                        </span>
                      </a>
                    `,
                  )}
                </div>
              `
            : html`
                <p class="home-empty">${this.text("loading", "Loading…")}</p>
              `
        }
      </section>
    `;
  }
  private renderDialog() {
    if (!this.layoutOpen) return nothing;
    const labels: Record<ModuleId, string> = {
      schedule: this.text("scheduleTitle", "Event schedule"),
      news: this.text("newsTitle", "News"),
      birthdays: this.text("birthdaysTitle", "Birthday countdown"),
      community: this.text("communityTitle", "Trending community"),
      updates: this.text("updatesTitle", "Recent archive updates"),
    };
    return html`
      <div class="layout-dialog-layer">
        <button
          class="layout-dialog-backdrop"
          aria-label=${this.text("closeLayout", "Close layout settings")}
          @click=${() => {
            this.layoutOpen = false;
          }}
        ></button>
        <aside class="layout-dialog" role="dialog" aria-modal="true">
          <header>
            <div>
              ${icon("dashboard_customize")}
              <h2>${this.text("customizeLayout", "Customize layout")}</h2>
            </div>
            <button
              class="icon-button"
              aria-label=${this.text("closeLayout", "Close")}
              @click=${() => {
                this.layoutOpen = false;
              }}
            >
              ${icon("close")}
            </button>
          </header>
          <fieldset>
            <legend>${this.text("density", "Information density")}</legend>
            ${(["compact", "comfortable"] as const).map(
              (value) => html`
                <label>
                  <input
                    type="radio"
                    name="home-density"
                    value=${value}
                    .checked=${this.density === value}
                    @change=${() => {
                      this.density = value;
                      this.persist();
                    }}
                  />
                  ${this.text(value, value)}
                </label>
              `,
            )}
          </fieldset>
          <div class="layout-dialog__modules">
            ${this.order.map(
              (id, index) => html`
                <div>
                  <button
                    aria-label=${`${this.hiddenModules[id] ? this.text("showModule", "Show") : this.text("hideModule", "Hide")}: ${labels[id]}`}
                    @click=${() => this.toggle(id)}
                  >
                    ${icon(this.hiddenModules[id] ? "visibility_off" : "visibility", 18)}
                  </button>
                  <span>${labels[id]}</span>
                  <button
                    ?disabled=${index === 0}
                    aria-label=${this.text("moveUp", "Move up")}
                    @click=${() => this.move(id, -1)}
                  >
                    ${icon("arrow_upward", 18)}
                  </button>
                  <button
                    ?disabled=${index === this.order.length - 1}
                    aria-label=${this.text("moveDown", "Move down")}
                    @click=${() => this.move(id, 1)}
                  >
                    ${icon("arrow_downward", 18)}
                  </button>
                </div>
              `,
            )}
          </div>
          <button class="layout-dialog__reset" @click=${this.reset}>
            ${icon("restart_alt", 18)}${this.text("resetLayout", "Restore default layout")}
          </button>
        </aside>
      </div>
    `;
  }
  render() {
    const visible = this.order.filter((id) => !this.hiddenModules[id]);
    return html`
      <div class="home-stage">
        <section class="home-hero">
          <div class="home-hero__content">
            <span class="home-hero__pin"></span>
            <h2>${this.text("purpose", "BanG Dream! Our Notes archive and community")}</h2>
          </div>
          <dl class="home-hero__stats" aria-label=${this.text("archiveOverview", "Archive overview")}>
            ${[
              ["stories", this.stories.length],
              ["songs", this.songs.length],
              ["characters", this.characters.length],
            ].map(
              ([key, count]) => html`
                <div>
                  <dt>${this.text(String(key), String(key))}</dt>
                  <dd>${this.phase === "loading" ? "—" : Number(count).toLocaleString(this.locale)}</dd>
                </div>
              `,
            )}
          </dl>
        </section>
        <div
          class=${`home-board home-board--${this.density} ${this.hiddenModules.birthdays ? "home-board--without-birthdays" : ""} ${this.hiddenModules.news ? "home-board--without-news" : ""}`}
        >
          ${visible.map((id) => this.renderModule(id))}
        </div>
        <footer class="home-footer">
          <p>
            haneoka
            <span class="meta-separator" aria-hidden="true"></span>
            ${this.text("fanArchive", "Unofficial archive and community")}
          </p>
          <nav aria-label=${this.text("legalNavigation", "Policies and project information")}>
            <a href="/privacy">${this.text("privacy", "Privacy Policy")}</a>
            <a href="/terms">${this.text("terms", "Terms of Use")}</a>
            <a href="/about">${this.text("about", "About")}</a>
          </nav>
        </footer>
        ${this.renderDialog()}
      </div>
    `;
  }
}
if (!customElements.get("home-dashboard")) customElements.define("home-dashboard", HomeDashboard);
