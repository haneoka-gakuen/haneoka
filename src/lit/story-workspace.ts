import { LitElement, html, nothing } from "lit";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";
import { HomeSpotStage } from "./runtime/home-spot-stage";
import { renderGridIdentity } from "./shared/grid-identity";

type StoryMode = "band" | "link" | "home" | "afterlive" | "tutorial";
type ViewMode = "grid" | "list";
const FRIENDSHIP_SELF_SLOTS = [
  ["18.82622%", "43.36100%", "90.85714%", "68.57143%", "-11.853991deg"],
  ["27.59146%", "77.80083%", "93.28571%", "33.08571%", "-44.430576deg"],
  ["74.16159%", "67.20954%", "3.51429%", "40.37143%", "29.744215deg"],
  ["73.93293%", "25.82988%", "7.42857%", "80.62857%", "-29.195091deg"],
] as const;
const FRIENDSHIP_OTHER_SLOTS = [
  ["19.28354%", "30.18672%", "90.60000%", "75.37143%", "29.658096deg"],
  ["20.88415%", "69.91701%", "96.00000%", "44.85714%", "-36.740987deg"],
  ["68.90244%", "80.18672%", "10.71429%", "13.57143%", "52.050356deg"],
  ["79.64939%", "49.48133%", "-0.28571%", "50.00000%", "3.755137deg"],
  ["71.95122%", "20.12448%", "9.34286%", "86.82857%", "-43.944990deg"],
] as const;

export class StoryWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    phase: { state: true },
    chapters: { state: true },
    episodes: { state: true },
    spots: { state: true },
    characters: { state: true },
    bands: { state: true },
    selectedRail: { state: true },
    selectedPartner: { state: true },
    selectedStory: { state: true },
    detailEpisode: { state: true },
    detailLoading: { state: true },
    query: { state: true },
    view: { state: true },
    filtersOpen: { state: true },
    selectedCharacters: { state: true },
    selectedBands: { state: true },
    selectedLevels: { state: true },
    sort: { state: true },
    order: { state: true },
    error: { state: true },
    detailMode: { state: true },
  };
  declare locale: string;
  declare mode: StoryMode;
  declare phase: "loading" | "ready" | "error";
  declare chapters: JsonRecord[];
  declare episodes: Record<string, JsonRecord>;
  declare spots: JsonRecord[];
  declare characters: JsonRecord[];
  declare bands: JsonRecord[];
  declare selectedRail: string;
  declare selectedPartner: string;
  declare selectedStory: string;
  declare detailEpisode: JsonRecord | null;
  declare detailLoading: boolean;
  declare query: string;
  declare view: ViewMode;
  declare filtersOpen: boolean;
  declare selectedCharacters: number[];
  declare selectedBands: number[];
  declare selectedLevels: number[];
  declare sort: string;
  declare order: "asc" | "desc";
  declare error: string;
  declare detailMode: "text" | "play";
  private homeStage?: HomeSpotStage;
  private homeStageSpot = "";
  private storyAudio?: HTMLAudioElement;
  private onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (this.detailEpisode) {
      this.detailEpisode = null;
      this.selectedStory = "";
      this.stopStoryPlayback();
      this.sync();
    } else if (this.filtersOpen) this.filtersOpen = false;
  };

  constructor() {
    super();
    this.locale = "ja";
    this.mode = "band";
    this.phase = "loading";
    this.chapters = [];
    this.episodes = {};
    this.spots = [];
    this.characters = [];
    this.bands = [];
    this.selectedRail = "";
    this.selectedPartner = "";
    this.selectedStory = "";
    this.detailEpisode = null;
    this.detailLoading = false;
    this.query = "";
    this.view = "grid";
    this.filtersOpen = false;
    this.selectedCharacters = [];
    this.selectedBands = [];
    this.selectedLevels = [];
    this.sort = "id";
    this.order = "asc";
    this.error = "";
    this.detailMode = "text";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    document.querySelector(".top-app-bar")?.classList.add("has-catalog-actions");
    window.addEventListener("keydown", this.onKeydown);
    window.setTimeout(() => {
      const p = new URLSearchParams(location.search);
      this.selectedStory = p.get("story") || "";
      this.selectedRail = p.get("first") || "";
      this.selectedPartner = p.get("second") || "";
      this.query = p.get("q") || "";
      this.view = ["band", "tutorial", "link"].includes(this.mode)
        ? "grid"
        : p.get("view") === "list"
          ? "list"
          : "grid";
      const defaultSort = this.mode === "link" || this.mode === "afterlive" ? "release" : "id";
      const defaultOrder = this.mode === "link" || this.mode === "afterlive" ? "desc" : "asc";
      this.sort = p.get("sort") || defaultSort;
      this.order = p.has("order") ? (p.get("order") === "desc" ? "desc" : "asc") : defaultOrder;
      this.selectedCharacters = p.getAll("character").map(Number).filter(Boolean);
      this.selectedBands = p.getAll("band").map(Number).filter(Boolean);
      this.selectedLevels = p
        .getAll("level")
        .map(Number)
        .filter((value) => Number.isFinite(value));
      void this.load();
    }, 0);
  }
  disconnectedCallback() {
    document.querySelector(".top-app-bar")?.classList.remove("has-catalog-actions");
    this.homeStage?.dispose();
    this.storyAudio?.pause();
    window.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
  }
  updated() {
    if (this.mode === "home" && this.phase === "ready") {
      const host = this.querySelector<HTMLElement>("[data-home-spine-stage]");
      const spot = this.spots.find((item) => String(item.spotId) === this.selectedRail) || this.spots[0];
      const key = String(spot?.spotId || "");
      if (host && spot && key && (this.homeStageSpot !== key || !this.homeStage)) {
        this.homeStage?.dispose();
        this.homeStage = new HomeSpotStage(host);
        this.homeStageSpot = key;
        host.classList.remove("ready", "failed");
        void this.homeStage
          .load(spot)
          .then(() => host.classList.add("ready"))
          .catch(() => host.classList.add("failed"));
      }
    }
  }
  private text(value: unknown) {
    return localizedText(value, this.locale);
  }
  private taggedImage(source: string, localeTag: string) {
    const slash = source.lastIndexOf("/");
    const dot = source.lastIndexOf(".");
    return dot > slash ? `${source.slice(0, dot)}(${localeTag})${source.slice(dot)}` : `${source}(${localeTag})`;
  }
  private localizedImages(source: string) {
    if (!source || this.locale === "ja" || !["band", "tutorial"].includes(this.mode)) return [source];
    const tags: Record<string, string[]> = {
      en: ["en"],
      "zh-TW": ["zh-Hant", "zh-Hans"],
      "zh-CN": ["zh-Hans", "zh-Hant"],
      ko: ["ko"],
    };
    return [...(tags[this.locale] || []).map((tag) => this.taggedImage(source, tag)), source];
  }
  private localizedImage(source: string) {
    return this.localizedImages(source)[0] || source;
  }
  private imageError(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    const fallback = image.dataset.fallback || "";
    const candidates = this.localizedImages(fallback);
    const next = Number(image.dataset.candidateIndex || 0) + 1;
    if (candidates[next]) {
      image.dataset.candidateIndex = String(next);
      image.src = candidates[next];
      return;
    }
    image.classList.add("is-error");
  }
  private async load() {
    this.phase = "loading";
    try {
      const [stories, characters, bands] = await Promise.all([
        fetchJson<JsonRecord>(catalogUrl("stories")),
        fetchJson<Record<string, JsonRecord>>(catalogUrl("characters")),
        fetchJson<Record<string, JsonRecord>>(catalogUrl("bands")),
      ]);
      this.chapters = recordValues(stories.chapters);
      this.episodes = (stories.episodes as Record<string, JsonRecord>) || {};
      this.spots = recordValues(stories.homeSpots);
      this.characters = recordValues(characters);
      this.bands = recordValues(bands);
      this.ensureRail();
      this.phase = "ready";
      if (this.selectedStory) void this.loadStoryDetail(this.selectedStory);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private ensureRail() {
    const rail = this.railItems();
    if (!rail.some((item) => item.id === this.selectedRail)) this.selectedRail = rail[0]?.id || "";
  }
  private chapterKind(chapter: JsonRecord) {
    return String(chapter.chapterKey || "").toLowerCase();
  }
  private relevantChapters() {
    if (this.mode === "band")
      return this.chapters
        .filter((c) => Number(c.chapterId) < 900000)
        .sort((a, b) => Number(a.chapterSort) - Number(b.chapterSort));
    const key = this.mode === "link" ? "asset_linkstory" : `asset_${this.mode}`;
    return this.chapters.filter((c) => this.chapterKind(c) === key);
  }
  private railItems(): Array<{ id: string; title: string; image: string; subtitle: string }> {
    if (this.mode === "home")
      return this.spots.map((spot) => ({
        id: String(spot.spotId),
        title:
          this.text(spot.name) ||
          this.text(spot.spotName) ||
          this.text(spot.title) ||
          String(spot.assetName || "Home scene"),
        image: String((spot.spine as JsonRecord)?.backgroundPreview || spot.backgroundPreview || ""),
        subtitle: this.bandName(Number(spot.bandId)),
      }));
    if (this.mode === "link")
      return this.characters.map((character) => ({
        id: String(character.characterId),
        title: this.characterName(character),
        image: String(character.faceImage || character.thumbnailImage || ""),
        subtitle: this.bandName(Number(character.bandId)),
      }));
    return this.relevantChapters().map((chapter) => ({
      id: String(chapter.chapterId),
      title: this.text(chapter.chapterName) || "—",
      image: String(chapter.banner || chapter.image || chapter.icon || ""),
      subtitle: `${Array.isArray(chapter.episodes) ? chapter.episodes.length : 0}`,
    }));
  }
  private bandName(id: number) {
    const band = this.bands.find((item) => Number(item.bandId) === id);
    return this.text(band?.bandName) || "";
  }
  private characterName(character: JsonRecord) {
    return this.text(character.characterName) || this.text(character.englishName) || "—";
  }
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private chapterEpisodes(chapter: JsonRecord | undefined) {
    return (Array.isArray(chapter?.episodes) ? chapter.episodes : [])
      .map(String)
      .map((id) => this.episodes[id])
      .filter(Boolean);
  }
  private baseEpisodes(): JsonRecord[] {
    if (this.mode === "home") {
      const spot = this.spots.find((item) => String(item.spotId) === this.selectedRail);
      return (Array.isArray(spot?.talks) ? (spot.talks as JsonRecord[]) : [])
        .map((talk) => this.episodes[String(talk.storyKey)])
        .filter(Boolean);
    }
    if (this.mode === "link" || this.mode === "afterlive") {
      const chapter = this.relevantChapters()[0];
      return this.chapterEpisodes(chapter);
    }
    const chapter =
      this.relevantChapters().find((item) => String(item.chapterId) === this.selectedRail) ||
      this.relevantChapters()[0];
    return this.chapterEpisodes(chapter);
  }
  private visibleEpisodes() {
    const needle = this.query.trim().toLowerCase();
    const railCharacter = this.mode === "link" ? Number(this.selectedRail) : 0;
    const partnerCharacter = this.mode === "link" ? Number(this.selectedPartner) : 0;
    const list = this.baseEpisodes().filter((episode) => {
      const ids = (Array.isArray(episode.characterIds) ? episode.characterIds : []).map(Number);
      if (railCharacter && !ids.includes(railCharacter)) return false;
      if (partnerCharacter && !ids.includes(partnerCharacter)) return false;
      if (this.selectedCharacters.length && !this.selectedCharacters.some((id) => ids.includes(id))) return false;
      if (
        this.selectedBands.length &&
        !ids.some((id) => this.selectedBands.includes(Number(this.character(id)?.bandId)))
      )
        return false;
      if (
        this.selectedLevels.length &&
        !this.selectedLevels.includes(Number(episode.unlockCharacterFriendshipLevel || 0))
      )
        return false;
      return (
        !needle ||
        `${this.text(episode.title)} ${ids.map((id) => this.characterName(this.character(id) || {})).join(" ")}`
          .toLowerCase()
          .includes(needle)
      );
    });
    const direction = this.order === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      let result = String(a.storyId).localeCompare(String(b.storyId), "en", { numeric: true });
      if (this.sort === "title") result = this.text(a.title).localeCompare(this.text(b.title), this.locale);
      if (this.sort === "release") result = this.releaseValue(a) - this.releaseValue(b);
      if (this.sort === "duration") result = Number(a.playTime || 0) - Number(b.playTime || 0);
      if (this.sort === "level")
        result = Number(a.unlockCharacterFriendshipLevel || 0) - Number(b.unlockCharacterFriendshipLevel || 0);
      return direction * (result || Number(a.storySort || 0) - Number(b.storySort || 0));
    });
  }
  private releaseValue(item: JsonRecord) {
    const value = item.publishedAt || item.startAt;
    return Array.isArray(value) ? Number(value[0] || 0) : Number(value || 0);
  }
  private duration(item: JsonRecord) {
    const value = Number(item.playTime || 0);
    if (!value) return "";
    const seconds = Math.round(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  private episodeImage(item: JsonRecord) {
    return String(item.banner || item.image || this.relevantChapters()[0]?.banner || "");
  }
  private sync() {
    const p = new URLSearchParams();
    if (this.query) p.set("q", this.query);
    if (this.selectedStory) p.set("story", this.selectedStory);
    if (this.mode === "link" && this.selectedRail) p.set("first", this.selectedRail);
    if (this.mode === "link" && this.selectedPartner) p.set("second", this.selectedPartner);
    if (this.view !== "grid") p.set("view", this.view);
    const defaultSort = this.mode === "link" || this.mode === "afterlive" ? "release" : "id";
    const defaultOrder = this.mode === "link" || this.mode === "afterlive" ? "desc" : "asc";
    if (this.sort !== defaultSort) p.set("sort", this.sort);
    if (this.order !== defaultOrder) p.set("order", this.order);
    this.selectedCharacters.forEach((id) => p.append("character", String(id)));
    this.selectedBands.forEach((id) => p.append("band", String(id)));
    this.selectedLevels.forEach((level) => p.append("level", String(level)));
    history.replaceState(history.state, "", `${location.pathname}${p.size ? `?${p}` : ""}`);
  }
  private chooseRail(id: string) {
    this.selectedRail = id;
    if (this.selectedPartner === id) this.selectedPartner = "";
    this.selectedStory = "";
    this.sync();
  }
  private choosePartner(id: string) {
    this.selectedPartner = this.selectedPartner === id ? "" : id;
    this.selectedStory = "";
    this.sync();
  }
  private choosePreview(id: string) {
    this.selectedStory = id;
    this.sync();
  }
  private chooseStory(id: string) {
    this.selectedStory = id;
    this.sync();
    this.detailMode = "text";
    this.stopStoryPlayback();
    void this.loadStoryDetail(id);
  }
  private async loadStoryDetail(id: string) {
    this.detailLoading = true;
    try {
      this.detailEpisode = await fetchJson<JsonRecord>(catalogUrl("stories", id));
    } catch {
      this.detailEpisode = this.episodes[id] || null;
    } finally {
      this.detailLoading = false;
    }
  }
  private toggleCharacter(id: number) {
    this.selectedCharacters = this.selectedCharacters.includes(id)
      ? this.selectedCharacters.filter((v) => v !== id)
      : [...this.selectedCharacters, id];
    this.sync();
  }
  private toggleBand(id: number) {
    this.selectedBands = this.selectedBands.includes(id)
      ? this.selectedBands.filter((v) => v !== id)
      : [...this.selectedBands, id];
    this.sync();
  }
  private toggleLevel(level: number) {
    this.selectedLevels = this.selectedLevels.includes(level)
      ? this.selectedLevels.filter((value) => value !== level)
      : [...this.selectedLevels, level];
    this.sync();
  }
  render() {
    const episodes = this.visibleEpisodes();
    const selected = this.episodes[this.selectedStory];
    return html`
      <section class=${`story-workspace story-${this.mode}`}>
        <div class="catalog__toolbar">
          <span class="catalog__count">${episodes.length}</span>
          ${
            ["band", "tutorial", "link", "home"].includes(this.mode)
              ? nothing
              : html`
                  <div class="catalog__view">
                    <button
                      aria-pressed=${this.view === "grid"}
                      @click=${() => {
                        this.view = "grid";
                        this.sync();
                      }}
                    >
                      <svg class="material-icon" width="20" height="20">
                        <use href=${`/icons.svg#grid_view${this.view === "grid" ? "-filled" : ""}`}></use>
                      </svg>
                    </button>
                    <button
                      aria-pressed=${this.view === "list"}
                      @click=${() => {
                        this.view = "list";
                        this.sync();
                      }}
                    >
                      <svg class="material-icon" width="20" height="20">
                        <use href=${`/icons.svg#view_list${this.view === "list" ? "-filled" : ""}`}></use>
                      </svg>
                    </button>
                  </div>
                `
          }
          <button
            class="icon-button catalog__filter-toggle"
            @click=${() => (this.filtersOpen = !this.filtersOpen)}
            aria-label=${uiText(this.locale, "filter")}
          >
            <svg class="material-icon" width="24" height="24">
              <use href=${`/icons.svg#filter_alt${this.filtersOpen ? "-filled" : ""}`}></use>
            </svg>
          </button>
        </div>
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
              `
            : this.phase === "error"
              ? html`
                  <div class="notice"><p>${this.error}</p></div>
                `
              : this.mode === "link"
                ? this.renderLinkWorkspace(episodes, this.detailEpisode || undefined)
                : this.renderStandardWorkspace(episodes, selected, this.detailEpisode || undefined)
        }${this.filtersOpen ? this.renderFilters() : nothing}
      </section>
    `;
  }
  private renderRail(compact = false) {
    return html`
      <aside class=${`story-rail ${compact ? "story-rail--compact" : ""}`}>
        ${this.railItems().map(
          (item) => html`
            <button
              class=${`${item.id === this.selectedRail ? "selected" : ""} ${item.image ? "media-loading" : ""}`}
              @click=${() => this.chooseRail(item.id)}
              aria-label=${item.title}
              title=${item.title}
            >
              ${
                item.image
                  ? html`
                      <img
                        src=${this.localizedImage(item.image)}
                        data-fallback=${item.image}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                        @error=${this.imageError}
                      />
                    `
                  : html`
                      <span class="story-rail__fallback">
                        <svg class="material-icon" width="24" height="24">
                          <use href="/icons.svg#auto_stories"></use>
                        </svg>
                      </span>
                    `
              }
              <span>
                <strong>${item.title}</strong>
                <small>${item.subtitle}</small>
              </span>
            </button>
          `,
        )}
      </aside>
    `;
  }
  private renderStandardWorkspace(episodes: JsonRecord[], selected?: JsonRecord, detail?: JsonRecord) {
    if (this.mode === "afterlive") {
      return html`
        <main class="story-browser afterlive-browser">
          <div class=${`story-list ${this.view}`}>${episodes.map((episode) => this.renderEpisode(episode))}</div>
        </main>
        ${detail ? this.renderDetail(detail) : nothing}
      `;
    }
    if (this.mode === "home") {
      const spot = this.spots.find((item) => String(item.spotId) === this.selectedRail) || this.spots[0];
      const preview = String((spot?.spine as JsonRecord | undefined)?.backgroundPreview || "");
      return html`
        ${this.renderRail()}
        <main class="home-story-browser">
          <section class=${`home-story-scene ${preview ? "media-loading" : ""}`}>
            ${
              preview
                ? html`
                    <img
                      src=${preview}
                      alt=${this.text(spot?.name)}
                      @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    />
                  `
                : nothing
            }
            <div class="home-story-scene__runtime" data-home-spine-stage>
              <md-circular-progress indeterminate></md-circular-progress>
            </div>
            <button
              class="icon-button home-story-scene__replay"
              @click=${() => this.homeStage?.replay()}
              aria-label="Replay"
            >
              <svg class="material-icon" width="20" height="20"><use href="/icons.svg#replay"></use></svg>
            </button>
            <div class="home-story-scene__label">
              <strong>${this.text(spot?.name)}</strong>
              <small>${this.text(spot?.bandName)}</small>
            </div>
          </section>
          <section class="home-story-dialogues">
            <div class="story-list grid">
              ${episodes.map((episode) =>
                this.renderEpisode(
                  episode,
                  (id) => this.chooseStory(id),
                  this.selectedStory,
                  preview,
                  String(this.bands.find((band) => Number(band.bandId) === Number(spot?.bandId))?.logo || ""),
                ),
              )}
            </div>
          </section>
        </main>
        ${detail ? this.renderDetail(detail) : nothing}
      `;
    }
    if ((this.mode === "band" || this.mode === "tutorial") && this.view === "grid") {
      const chapter =
        this.relevantChapters().find((item) => String(item.chapterId) === this.selectedRail) ||
        this.relevantChapters()[0];
      const staged = selected || episodes[0];
      const stagedImage = staged
        ? String(staged.image || chapter?.image || staged.banner || chapter?.banner || "")
        : "";
      return html`
        ${this.mode === "tutorial" ? nothing : this.renderRail()}
        <main class=${`chapter-story-browser ${this.mode === "tutorial" ? "chapter-story-browser--tutorial" : ""}`}>
          ${
            staged
              ? html`
                  <section class="chapter-story-stage">
                    <header>
                      ${
                        chapter?.icon
                          ? html`
                              <img src=${String(chapter.icon)} alt="" />
                            `
                          : nothing
                      }
                      <span>
                        <small>${uiText(this.locale, "chapters")}</small>
                        <strong>${this.text(chapter?.chapterName) || String(chapter?.chapterKey || "")}</strong>
                      </span>
                    </header>
                    <div class="chapter-story-stage__main">
                      <div class=${`chapter-story-stage__media ${stagedImage ? "media-loading" : ""}`}>
                        ${
                          stagedImage
                            ? html`
                                <img
                                  src=${this.localizedImage(stagedImage)}
                                  data-fallback=${stagedImage}
                                  alt=""
                                  @load=${(event: Event) =>
                                    (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                                  @error=${this.imageError}
                                />
                              `
                            : html`
                                <span class="chapter-story-stage__fallback">
                                  <svg class="material-icon" width="36" height="36">
                                    <use href="/icons.svg#auto_stories"></use>
                                  </svg>
                                  <strong>${this.text(staged.title) || uiText(this.locale, "story")}</strong>
                                </span>
                              `
                        }
                      </div>
                      <article>
                        <span class="chapter-story-stage__number">
                          ${String(staged.episodeNumber || staged.storySort || 0).padStart(2, "0")}
                        </span>
                        <h2>${this.text(staged.title) || uiText(this.locale, "story")}</h2>
                        <p>${this.text(staged.description) || this.text(chapter?.description)}</p>
                        <footer>
                          ${
                            this.releaseValue(staged)
                              ? html`
                                  <span>
                                    <svg class="material-icon" width="16" height="16">
                                      <use href="/icons.svg#calendar_month"></use>
                                    </svg>
                                    ${new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(
                                      new Date(this.releaseValue(staged)),
                                    )}
                                  </span>
                                `
                              : nothing
                          }
                          ${
                            this.duration(staged)
                              ? html`
                                  <span>
                                    <svg class="material-icon" width="16" height="16">
                                      <use href="/icons.svg#schedule"></use>
                                    </svg>
                                    ${this.duration(staged)}
                                  </span>
                                `
                              : nothing
                          }
                        </footer>
                        <button class="button" @click=${() => this.chooseStory(String(staged.storyId))}>
                          <svg class="material-icon" width="20" height="20">
                            <use href="/icons.svg#play_arrow"></use>
                          </svg>
                          ${uiText(this.locale, "openStory")}
                        </button>
                      </article>
                    </div>
                  </section>
                `
              : nothing
          }
          <nav class="story-list grid" aria-label=${uiText(this.locale, "openStory")}>
            ${episodes.map((episode) =>
              this.renderEpisode(episode, (id) => this.choosePreview(id), String(staged?.storyId || "")),
            )}
          </nav>
        </main>
        ${detail ? this.renderDetail(detail) : nothing}
      `;
    }
    return html`
      ${this.renderRail()}
      <main class="story-browser">
        <div class=${`story-list ${this.view}`}>${episodes.map((episode) => this.renderEpisode(episode))}</div>
      </main>
      ${detail ? this.renderDetail(detail) : nothing}
    `;
  }
  private renderLinkWorkspace(episodes: JsonRecord[], selected?: JsonRecord) {
    const first = this.character(Number(this.selectedRail));
    const firstBand = Number(first?.bandId || 1);
    const partner = this.character(Number(this.selectedPartner));
    const partnerBand = Number(partner?.bandId || firstBand);
    const bands = [
      ...new Set(
        this.characters
          .filter((item) => String(item.characterId) !== this.selectedRail)
          .map((item) => Number(item.bandId))
          .filter(Boolean),
      ),
    ];
    const activeBand = this.selectedPartner ? partnerBand : firstBand;
    const sameBand = Boolean(first) && firstBand === activeBand;
    const slots = sameBand ? FRIENDSHIP_SELF_SLOTS : FRIENDSHIP_OTHER_SLOTS;
    const partners = this.characters.filter(
      (item) => String(item.characterId) !== this.selectedRail && Number(item.bandId) === activeBand,
    );
    const root = `/assets/${currentReleaseServer()}/Assets/AddressableResources`;
    return html`
      ${this.renderRail(true)}
      <main class="link-story-browser">
        <section
          class="link-story-stage"
          style=${`--friendship-stage:url('${root}/Image/Background/FriendshipBackground.png')`}
        >
          <div class="link-story-board">
            <img
              class="link-story-board__background"
              src=${`${root}/Band/${activeBand}/Friendship/photo_board.png`}
              alt=""
            />
            ${
              sameBand
                ? html`
                    <img class="link-story-band-logo" src=${`${root}/Band/${activeBand}/band_logo.png`} alt="" />
                  `
                : nothing
            }
            ${
              first
                ? html`
                    <img
                      class="link-story-board__lead"
                      src=${`${root}/Character/Image/${String(first.characterId)}/character_sprite.png`}
                      alt=${this.characterName(first)}
                    />
                  `
                : nothing
            }
            <nav class="link-story-partners" aria-label=${`${uiText(this.locale, "characters")} 2`}>
              ${partners.map((character, index) => {
                const id = String(character.characterId);
                const source = `${root}/Character/Image/${id}/board_icon.png`;
                const slot = slots[index] || FRIENDSHIP_OTHER_SLOTS[0];
                const rotation = sameBand && activeBand === 2 && index === 0 ? "168.146055deg" : slot[4];
                return html`
                  <button
                    class=${id === this.selectedPartner ? "selected" : ""}
                    style=${`--slot-x:${slot[0]};--slot-y:${slot[1]};--arrow-x:${slot[2]};--arrow-y:${slot[3]};--arrow-rotation:${rotation}`}
                    @click=${() => this.choosePartner(id)}
                    aria-label=${this.characterName(character)}
                    title=${this.characterName(character)}
                  >
                    <img
                      class="link-story-partner-arrow"
                      src=${`${root}/Band/${activeBand}/Friendship/FriendshipArrow_1.png`}
                      alt=""
                    />
                    <span><img src=${source} alt="" /></span>
                  </button>
                `;
              })}
            </nav>
            <nav class="link-story-bands" aria-label=${uiText(this.locale, "bands")}>
              ${bands.map(
                (bandId) => html`
                  <button
                    class=${bandId === activeBand ? "selected" : ""}
                    @click=${() => {
                      const next = this.characters.find(
                        (item) => Number(item.bandId) === bandId && String(item.characterId) !== this.selectedRail,
                      );
                      this.selectedPartner = next ? String(next.characterId) : "";
                      this.sync();
                    }}
                    aria-label=${this.bandName(bandId)}
                  >
                    <img src=${`${root}/Band/${bandId}/band_logo.png`} alt="" />
                  </button>
                `,
              )}
            </nav>
            <button
              class="icon-button link-story-swap"
              ?disabled=${!this.selectedPartner}
              @click=${() => {
                if (!this.selectedPartner) return;
                const previous = this.selectedRail;
                this.selectedRail = this.selectedPartner;
                this.selectedPartner = previous;
                this.sync();
              }}
              aria-label=${uiText(this.locale, "swap")}
            >
              <svg class="material-icon" width="20" height="20"><use href="/icons.svg#swap_horiz"></use></svg>
            </button>
          </div>
        </section>
        <section class="link-story-results">
          <div class="story-list grid">${episodes.map((episode) => this.renderEpisode(episode))}</div>
        </section>
      </main>
      ${selected ? this.renderDetail(selected) : nothing}
    `;
  }
  private renderEpisode(
    episode: JsonRecord,
    choose: (id: string) => void = (id) => this.chooseStory(id),
    active = this.selectedStory,
    imageOverride = "",
    overlayImage = "",
  ) {
    const id = String(episode.storyId),
      image = imageOverride || this.episodeImage(episode),
      characterIds = (Array.isArray(episode.characterIds) ? episode.characterIds : []).map(Number);
    const characterNames = characterIds
      .map((characterId) => this.characterName(this.character(characterId) || {}))
      .join("、");
    const gridDescription =
      this.mode === "link" && episode.unlockCharacterFriendshipLevel
        ? `${uiText(this.locale, "friendship")} ${episode.unlockCharacterFriendshipLevel}`
        : characterNames || this.text(episode.chapterName) || this.duration(episode);
    const avatarAdornment = characterIds.length
      ? html`
          <span class="story-card__avatars" aria-hidden="true">
            ${characterIds.slice(0, 5).map((characterId) => {
              const character = this.character(characterId);
              const source = String(character?.faceImage || character?.thumbnailImage || "");
              return source
                ? html`
                    <img src=${source} alt="" loading="lazy" />
                  `
                : nothing;
            })}
          </span>
        `
      : nothing;
    return html`
      <button class=${`story-card content-grid-tile ${id === active ? "selected" : ""}`} @click=${() => choose(id)}>
        ${
          image
            ? html`
                <span class="story-card__media media-loading">
                  <img
                    src=${image}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                  />
                  ${
                    overlayImage
                      ? html`
                          <img class="story-card__logo" src=${overlayImage} alt="" loading="lazy" />
                        `
                      : nothing
                  }
                  ${
                    characterIds.length
                      ? html`
                          <span class="story-card__media-avatars">
                            ${characterIds.slice(0, 5).map((characterId) => {
                              const character = this.character(characterId);
                              const source = String(character?.faceImage || character?.thumbnailImage || "");
                              return source
                                ? html`
                                    <img src=${source} alt="" loading="lazy" />
                                  `
                                : nothing;
                            })}
                          </span>
                        `
                      : nothing
                  }
                </span>
              `
            : nothing
        }
        <span class="story-card__body">
          ${
            this.view === "grid"
              ? renderGridIdentity(
                  this.text(episode.title) || uiText(this.locale, "story"),
                  gridDescription,
                  this.mode === "link" && episode.unlockCharacterFriendshipLevel ? nothing : avatarAdornment,
                )
              : html`
                  <strong>${this.text(episode.title) || uiText(this.locale, "story")}</strong>
                  ${
                    this.mode !== "link" && this.text(episode.chapterName)
                      ? html`
                          <span class="story-card__chapter">${this.text(episode.chapterName)}</span>
                        `
                      : nothing
                  }
                  <span class="story-card__characters">
                    ${avatarAdornment}
                    <span>${characterNames}</span>
                  </span>
                  <small class="story-card__meta">
                    ${
                      episode.episodeNumber
                        ? html`
                            <span>${String(episode.episodeNumber).padStart(2, "0")}</span>
                          `
                        : nothing
                    }
                    ${
                      this.duration(episode)
                        ? html`
                            <span>${this.duration(episode)}</span>
                          `
                        : nothing
                    }
                    ${
                      episode.unlockCharacterFriendshipLevel
                        ? html`
                            <span>${uiText(this.locale, "friendship")} ${episode.unlockCharacterFriendshipLevel}</span>
                          `
                        : nothing
                    }
                    ${
                      this.releaseValue(episode)
                        ? html`
                            <span>
                              ${new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(
                                new Date(this.releaseValue(episode)),
                              )}
                            </span>
                          `
                        : nothing
                    }
                  </small>
                `
          }
        </span>
      </button>
    `;
  }
  private stopStoryPlayback() {
    this.storyAudio?.pause();
  }
  private async openVegaPlayer() {
    await import("./runtime/vega-story-stage");
    this.detailMode = "play";
    this.stopStoryPlayback();
  }
  private renderDetail(episode: JsonRecord) {
    const ids = (Array.isArray(episode.characterIds) ? episode.characterIds : []).map(Number);
    const allCommands = Array.isArray(episode.commands) ? (episode.commands as JsonRecord[]) : [];
    const assets = (episode.assets as JsonRecord | undefined) || {};
    const sounds = Array.isArray(assets.sounds) ? (assets.sounds as JsonRecord[]) : [];
    const visualAssets = ["backgrounds", "stills", "frames"].flatMap((group) =>
      (Array.isArray(assets[group]) ? (assets[group] as JsonRecord[]) : []).map((asset) => ({ group, asset })),
    );
    const visualByReference = new Map<string, string>();
    visualAssets.forEach(({ asset }) => {
      const source = String(asset.url || "");
      [asset.assetName, asset.stageRef, asset.stillRef, asset.frameRef, asset.sourcePath]
        .map(String)
        .filter(Boolean)
        .forEach((key) => visualByReference.set(key, source));
    });
    let currentVisual = "";
    let emittedVisual = "";
    const commands = allCommands.flatMap((command) => {
      const reference = String(
        command.backgroundRef || command.stillRef || command.frameRef || command.targetAssetName || "",
      );
      const normalizedReference = reference.split("/").at(-1) || reference;
      const resolvedVisual = visualByReference.get(reference) || visualByReference.get(normalizedReference) || "";
      if (resolvedVisual) currentVisual = resolvedVisual;
      if (!this.text(command.text)) return [];
      const visual = currentVisual !== emittedVisual ? currentVisual : "";
      if (visual) emittedVisual = visual;
      return [{ command, visual }];
    });
    return html`
      <aside class="story-detail">
        <header>
          <button
            class="icon-button"
            @click=${() => {
              this.detailEpisode = null;
              this.selectedStory = "";
              this.stopStoryPlayback();
              this.sync();
            }}
          >
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#arrow_back"></use></svg>
          </button>
          <span class="story-detail__title">
            <strong>${this.text(episode.title) || uiText(this.locale, "story")}</strong>
            <small>${this.text(episode.chapterName)}</small>
          </span>
          <div class="story-detail__mode segmented" aria-label=${uiText(this.locale, "playback")}>
            <button
              aria-pressed=${this.detailMode === "text"}
              @click=${() => {
                this.detailMode = "text";
                this.stopStoryPlayback();
              }}
            >
              ${uiText(this.locale, "storyText")}
            </button>
            <button aria-pressed=${this.detailMode === "play"} @click=${this.openVegaPlayer}>
              ${uiText(this.locale, "player")}
            </button>
          </div>
        </header>
        ${
          this.detailMode === "play"
            ? html`
                <vega-story-stage
                  .story=${episode}
                  server=${currentReleaseServer()}
                  locale=${this.locale}
                  @open-text=${() => (this.detailMode = "text")}
                ></vega-story-stage>
              `
            : html`
                <div class="story-detail__content">
                  <p>${this.text(episode.description)}</p>
                  <dl class="detail-list">
                    <div>
                      <dt>${uiText(this.locale, "chapter")}</dt>
                      <dd>${this.text(episode.chapterName) || "—"}</dd>
                    </div>
                    <div>
                      <dt>${uiText(this.locale, "duration")}</dt>
                      <dd>${this.duration(episode) || "—"}</dd>
                    </div>
                    <div>
                      <dt>${uiText(this.locale, "release")}</dt>
                      <dd>
                        ${this.releaseValue(episode) ? new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(this.releaseValue(episode))) : "—"}
                      </dd>
                    </div>
                    ${
                      episode.unlockCharacterFriendshipLevel
                        ? html`
                            <div>
                              <dt>${uiText(this.locale, "friendship")}</dt>
                              <dd>Lv.${episode.unlockCharacterFriendshipLevel}</dd>
                            </div>
                          `
                        : nothing
                    }
                  </dl>
                  <div class="story-character-list">
                    ${ids.map((id) => {
                      const character = this.character(id);
                      return html`
                        <span>
                          ${
                            character?.faceImage
                              ? html`
                                  <img src=${String(character.faceImage)} alt="" />
                                `
                              : nothing
                          }${this.characterName(character || {})}
                        </span>
                      `;
                    })}
                  </div>
                  ${
                    commands.length
                      ? html`
                          <section class="story-detail-section">
                            <h2>
                              ${uiText(this.locale, "storyText")}
                              <span>${commands.length}</span>
                            </h2>
                            <div class="story-transcript">
                              ${commands.map(({ command, visual }) => {
                                const names = (Array.isArray(command.targetTextNames) ? command.targetTextNames : [])
                                  .map((name) => this.text(name))
                                  .filter(Boolean)
                                  .join("、");
                                const voiceRef = String(
                                  (Array.isArray(command.voiceRefs) ? command.voiceRefs[0] : "") || "",
                                );
                                const voice = sounds.find((sound) => String(sound.resourceRef || "") === voiceRef);
                                return html`
                                  <article class=${visual ? "has-visual" : ""}>
                                    ${
                                      visual
                                        ? html`
                                            <img class="story-transcript__visual" src=${visual} alt="" loading="lazy" />
                                          `
                                        : nothing
                                    }
                                    <strong>${names || String(command.targetName || "")}</strong>
                                    <p>${this.text(command.text)}</p>
                                    ${
                                      voice?.playableUrl
                                        ? html`
                                            <button
                                              class="icon-button"
                                              @click=${() => this.playStoryAudio(String(voice.playableUrl))}
                                              aria-label=${uiText(this.locale, "play")}
                                            >
                                              <svg class="material-icon" width="18" height="18">
                                                <use href="/icons.svg#volume_up"></use>
                                              </svg>
                                            </button>
                                          `
                                        : nothing
                                    }
                                  </article>
                                `;
                              })}
                            </div>
                          </section>
                        `
                      : this.detailLoading
                        ? html`
                            <div class="catalog-state">
                              <md-circular-progress indeterminate></md-circular-progress>
                            </div>
                          `
                        : nothing
                  }
                </div>
              `
        }
      </aside>
    `;
  }
  private playStoryAudio(url: string) {
    this.storyAudio?.pause();
    this.storyAudio = new Audio(url);
    void this.storyAudio.play();
  }
  private renderFilters() {
    const usedCharacters = [
      ...new Set(
        this.baseEpisodes().flatMap((episode) =>
          (Array.isArray(episode.characterIds) ? episode.characterIds : []).map(Number),
        ),
      ),
    ];
    const usedBands = [...new Set(usedCharacters.map((id) => Number(this.character(id)?.bandId)).filter(Boolean))];
    const usedLevels = [
      ...new Set(this.baseEpisodes().map((episode) => Number(episode.unlockCharacterFriendshipLevel || 0))),
    ].sort((a, b) => a - b);
    return html`
      <button class="sheet-scrim" @click=${() => (this.filtersOpen = false)}></button>
      <aside class="catalog__filters open">
        <div class="catalog__filter-header">
          <h2>${uiText(this.locale, "filter")}</h2>
          <button class="icon-button" @click=${() => (this.filtersOpen = false)}>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#close"></use></svg>
          </button>
        </div>
        <div class="catalog__filter-stack">
          <md-outlined-text-field
            type="search"
            label=${uiText(this.locale, "searchStories")}
            .value=${this.query}
            @input=${(event: Event) => {
              this.query = String((event.target as HTMLElement & { value?: string }).value || "");
              this.sync();
            }}
          >
            <svg slot="leading-icon" class="material-icon" width="20" height="20">
              <use href="/icons.svg#search"></use>
            </svg>
          </md-outlined-text-field>
          <fieldset class="catalog__filter-group">
            <legend>${uiText(this.locale, "bands")}</legend>
            <div class="story-filter-grid">
              ${usedBands.map((id) => {
                const band = this.bands.find((item) => Number(item.bandId) === id);
                return html`
                  <button
                    class="chip chip--visual"
                    aria-pressed=${this.selectedBands.includes(id)}
                    @click=${() => this.toggleBand(id)}
                  >
                    ${
                      band?.icon
                        ? html`
                            <img src=${String(band.icon)} alt="" />
                          `
                        : nothing
                    }
                    <span class="chip__label chip__label--visual">${this.bandName(id)}</span>
                  </button>
                `;
              })}
            </div>
          </fieldset>
          <fieldset class="catalog__filter-group">
            <legend>${uiText(this.locale, "characters")}</legend>
            <div class="story-filter-grid">
              ${usedCharacters.map((id) => {
                const character = this.character(id);
                return html`
                  <button
                    class="chip chip--visual"
                    aria-pressed=${this.selectedCharacters.includes(id)}
                    @click=${() => this.toggleCharacter(id)}
                  >
                    ${
                      character?.faceImage
                        ? html`
                            <img src=${String(character.faceImage)} alt="" />
                          `
                        : nothing
                    }
                    <span class="chip__label chip__label--visual">${this.characterName(character || {})}</span>
                  </button>
                `;
              })}
            </div>
          </fieldset>
          ${
            this.mode === "link" || this.mode === "afterlive"
              ? html`
                  <fieldset class="catalog__filter-group">
                    <legend>${uiText(this.locale, "friendship")}</legend>
                    <div class="catalog__chips">
                      ${usedLevels.map(
                        (level) => html`
                          <button
                            class="chip"
                            aria-pressed=${this.selectedLevels.includes(level)}
                            @click=${() => this.toggleLevel(level)}
                          >
                            ${level ? `Lv.${level}` : "Default"}
                          </button>
                        `,
                      )}
                    </div>
                  </fieldset>
                `
              : nothing
          }
          <label class="catalog__filter-group">
            <span>${uiText(this.locale, "sort")}</span>
            <md-outlined-select
              label=${uiText(this.locale, "sort")}
              value=${this.sort}
              @change=${(event: Event) => {
                this.sort = String((event.target as HTMLElement & { value?: string }).value || "id");
                this.sync();
              }}
            >
              ${(
                [
                  ["release", uiText(this.locale, "release")],
                  ["id", uiText(this.locale, "order")],
                  ["title", uiText(this.locale, "title")],
                  ["duration", uiText(this.locale, "duration")],
                  ["level", uiText(this.locale, "friendship")],
                ] as const
              ).map(
                ([value, label]) => html`
                  <md-select-option value=${value} ?selected=${this.sort === value}>
                    <div slot="headline">${label}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
          </label>
        </div>
      </aside>
    `;
  }
}
customElements.define("story-workspace", StoryWorkspace);
