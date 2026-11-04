// L3 — GEB
// Input: Our Notes／GBP／SEKAI 故事目录、角色与乐队及编辑器选择或导入回调。
// Output: 复用故事页卡片、演出／主页对话媒体和筛选的故事选择器。
// Pos: [Map](L2-2.md)；故事编辑器新建与服务器故事目录之间的选择入口。
// Effects/Dependencies: 公开 GET 与图片惰性加载；断开时取消请求并释放观察器。
import { LitElement, html, nothing } from "lit";
import type { StudioAssetSource } from "@haneoka/altair/studio-host";
import { haneokaResourceRequestUrl } from "@haneoka/altair-plugin-haneoka/public-resource-url";
import { clientText } from "../i18n/client";
import { episodeArtwork, episodeIdentityArtwork, spotArtwork } from "../lib/story-artwork";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { providerRegionForLocale } from "../lib/provider-page-data";
import { readReleaseServer } from "../lib/release-server";
import { storyTile } from "./shared/story-tile";
import { localizedText, uiText } from "./shared/catalog";
import { storyCastMedia, storyEpisodeGroup, storyCardMedia, storyThumbnailMedia } from "./ui/story-media";
import { selectionPane } from "./ui/selection-pane";
import { chooserGroup } from "./ui/chooser-filters";
import { filterChip } from "./ui/controls";
import { facet } from "./ui/facet";
import { LazyImages, localeTaggedCandidates } from "./ui/lazy-images";
import { loadingState } from "./ui/state";

type Row = Record<string, unknown>;
type Axis = "category" | "chapter" | "band" | "character" | "episode";
const axes: Axis[] = ["category", "chapter", "band", "character", "episode"];
const categories: Record<string, string> = {
  band: "story.navigation.band",
  event: "story.navigation.event",
  birthday: "story.labels.birthdayStory",
  afterlive: "story.navigation.afterlive",
  home: "story.navigation.home",
  linkstory: "story.navigation.link",
  tutorial: "story.navigation.tutorial",
};
const axisLabels: Record<Axis, string> = {
  category: "catalog.fields.type",
  chapter: "story.labels.chapter",
  band: "catalog.fields.band",
  character: "catalog.fields.character",
  episode: "story.labels.episode",
};
export class StoryImportPicker extends LitElement {
  static properties = {
    locale: {},
    origin: {},
    provider: {},
    selectOnly: { attribute: false },
    importing: { state: true },
    loading: { state: true },
    error: { state: true },
    query: { state: true },
    server: { state: true },
    filtersOpen: { state: true },
    selected: { state: true },
    filters: { state: true },
    rows: { state: true },
    cardEpisodes: { state: true },
    cardEpisode: { state: true },
    cardLoading: { state: true },
    cardError: { state: true },
    importStory: { attribute: false },
  };
  declare locale: string;
  declare origin: string;
  declare provider: StudioAssetSource["provider"];
  declare selectOnly: boolean;
  declare importing: boolean;
  declare loading: boolean;
  declare error: string;
  declare query: string;
  declare server: string;
  declare filtersOpen: boolean;
  declare selected: string;
  declare filters: Record<Axis, string>;
  declare rows: Row[];
  declare private cardEpisodes: Row[];
  declare private cardEpisode: string;
  declare private cardLoading: boolean;
  declare private cardError: string;
  private cardRequest?: AbortController;
  declare importStory: (source: StudioAssetSource, storyId: string, title: string) => Promise<void>;
  constructor() {
    super();
    this.locale = "en";
    this.origin = "https://haneoka.org";
    this.provider = "haneoka";
    this.selectOnly = false;
    this.importing = false;
    this.loading = true;
    this.error = "";
    this.query = "";
    this.server = readReleaseServer();
    this.filtersOpen = false;
    this.selected = "";
    this.filters = { category: "", chapter: "", band: "", character: "", episode: "" };
    this.rows = [];
    this.cardEpisodes = [];
    this.cardEpisode = "";
    this.cardLoading = false;
    this.cardError = "";
  }
  private source?: StudioAssetSource;
  private chapters: Record<string, Row> = {};
  private characters: Record<string, Row> = {};
  private bands: Record<string, Row> = {};
  private spots = new Map<string, Row>();
  private request?: AbortController;
  private images?: LazyImages;
  createRenderRoot() {
    return this;
  }
  private t = (key: string) => clientText(this.locale, `community.stories.${key}`);
  private text = (value: unknown) => localizedText(value, this.locale);
  override disconnectedCallback() {
    this.request?.abort();
    this.cardRequest?.abort();
    this.images?.disconnect();
    super.disconnectedCallback();
  }
  protected override firstUpdated() {
    this.querySelector<HTMLDialogElement>("dialog")?.showModal();
    if (this.provider !== "haneoka") this.server = providerRegionForLocale(this.locale);
    void this.load();
  }
  protected override updated() {
    if (!this.isConnected) return;
    this.images ??= new LazyImages({ root: this.querySelector(".selection-pane__body") });
    this.images.observe(this);
  }
  private async load() {
    this.request?.abort();
    this.cardRequest?.abort();
    this.cardEpisodes = [];
    this.cardEpisode = "";
    this.cardLoading = false;
    this.cardError = "";
    const controller = (this.request = new AbortController());
    this.loading = true;
    this.error = "";
    this.rows = [];
    this.selected = "";
    this.filters = { category: "", chapter: "", band: "", character: "", episode: "" };
    try {
      if (this.provider !== "haneoka") {
        await this.loadProvider(controller.signal);
        return;
      }
      const read = async (resource: string) => {
        const response = await fetch(new URL(`/api/v1/servers/${this.server}/${resource}`, this.origin), {
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("story_catalog_unavailable");
        return response.json();
      };
      const identity = await read("release?projection=identity");
      const source: StudioAssetSource = {
        provider: "haneoka",
        origin: this.origin,
        server: this.server,
        releaseId: identity.releaseId,
        sourceId: identity.sourceId,
      };
      const [stories, characters, bands] = await Promise.all([
        read(`stories?release=${source.releaseId}`),
        read(`characters?release=${source.releaseId}`),
        read(`bands?release=${source.releaseId}`),
      ]);
      controller.signal.throwIfAborted();
      this.source = source;
      this.chapters = stories.chapters;
      this.characters = characters;
      this.bands = bands;
      this.spots = new Map(
        Object.values(stories.homeSpots as Record<string, Row>).flatMap((spot) =>
          ((spot.talks as Row[]) ?? []).map((talk) => [String(talk.storyKey), spot]),
        ),
      );
      this.rows = (Object.values(stories.episodes) as Row[]).sort(
        (a, b) =>
          Number(this.chapters[String(a.chapterId)]?.chapterSort ?? a.chapterId) -
            Number(this.chapters[String(b.chapterId)]?.chapterSort ?? b.chapterId) ||
          Number(a.storySort || 0) - Number(b.storySort || 0),
      );
    } catch {
      if (!controller.signal.aborted) this.error = this.t("assetLoadFailed");
    } finally {
      if (!controller.signal.aborted) this.loading = false;
    }
  }
  private async loadProvider(signal: AbortSignal) {
    const base = `/api/v1/${this.provider === "sekai" ? "sekai" : "garupa/bestdori"}/${this.server}/`;
    const read = async (resource: string): Promise<Record<string, Row>> => {
      const url = new URL(base + resource, this.origin);
      url.searchParams.set("lang", this.locale);
      url.searchParams.set("projection", BESTDORI_CATALOG_VERSION);
      const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("story_catalog_unavailable");
      return response.json();
    };
    const sections =
      this.provider === "sekai"
        ? ["event", "unit", "character", "card", "area", "special", "mysekai", "live"]
        : ["event", "band", "main", "afterlive"];
    const [collections, characters, bands, cards] = await Promise.all([
      Promise.all(
        sections.map(async (section) =>
          Object.values(await read(`stories/${section}`)).map((row) => ({ ...row, templateCategory: section })),
        ),
      ),
      this.provider === "bestdori" ? read("characters") : {},
      this.provider === "bestdori" ? read("bands") : {},
      this.provider === "bestdori" ? read("cards") : {},
    ]);
    signal.throwIfAborted();
    this.source = { provider: this.provider, origin: this.origin, server: this.server };
    this.characters = characters;
    this.bands = bands;
    this.spots = new Map();
    this.filters = { ...this.filters, category: this.provider === "sekai" ? "unit" : "band" };
    this.rows = [
      ...collections.flat(),
      ...Object.values(cards as Record<string, Row>)
        .filter((card) => card.hasStory)
        .map((card) => ({
          ...card,
          storyId: `card:${card.cardId}`,
          title: card.prefix,
          chapterId: `card:${card.cardId}`,
          chapterKey: `bestdori:card:${card.cardId}`,
          chapterName: card.prefix,
          characterIds: card.characterId ? [card.characterId] : [],
          templateCategory: "card",
          isCardTemplate: true,
        })),
    ];
    this.chapters = Object.fromEntries(
      this.rows.map((row) => [
        String(row.chapterKey || row.chapterId),
        {
          chapterName: row.chapterName,
          bandId: row.bandId,
          banner: row.image || row.thumbnail,
        },
      ]),
    );
  }
  private category(row: Row) {
    if (this.provider !== "haneoka") return String(row.templateCategory);
    const key = String(row.chapterKey);
    return key.startsWith("asset_")
      ? key.slice(6)
      : row.storyCategory === "birthday"
        ? "birthday"
        : this.chapters[String(row.chapterId)]?.eventId
          ? "event"
          : "band";
  }
  private values(row: Row, axis: Axis): string[] {
    if (axis === "category") return [this.category(row)];
    if (axis === "chapter") return [String(row.chapterKey || row.chapterId)];
    if (axis === "character") return ((row.characterIds as number[]) ?? []).map(String);
    if (axis === "band")
      return row.bandId
        ? [String(row.bandId)]
        : [
            ...new Set(
              ((row.characterIds as number[]) ?? []).flatMap((id) =>
                this.characters[id]?.bandId ? [String(this.characters[id]!.bandId)] : [],
              ),
            ),
          ];
    return [row.isAnotherEpisode ? "perspective" : row.isExtraEpisode ? "extra" : "main"];
  }
  private label(axis: Axis, value: string): string {
    if (axis === "category") {
      if (this.provider === "bestdori")
        return uiText(this.locale, `story.navigation.bestdori${value[0]!.toUpperCase()}${value.slice(1)}`);
      if (this.provider === "sekai") return clientText(this.locale, `community.page.sekai.stories.${value}`);
      return uiText(this.locale, categories[value]!);
    }
    if (axis === "band") return this.text(this.bands[value]?.bandName);
    if (axis === "character") return this.text(this.characters[value]?.characterName);
    if (axis === "episode")
      return uiText(
        this.locale,
        `story.labels.${value === "perspective" ? "perspectiveStory" : value === "extra" ? "extraStory" : "bandStory"}`,
      );
    const row = this.rows.find((item) => String(item.chapterKey || item.chapterId) === value);
    return row && String(row.chapterKey).startsWith("asset_")
      ? this.label("category", this.category(row))
      : this.text(row?.chapterName) || this.text(this.chapters[value]?.chapterName);
  }
  private acceptsStory(row: Row, except?: Axis) {
    const search = `${this.text(row.title)} ${this.text(row.chapterName)} ${row.storyId} ${row.scriptAsset}`
      .normalize("NFKC")
      .toLocaleLowerCase();
    return (
      search.includes(this.query.normalize("NFKC").trim().toLocaleLowerCase()) &&
      axes.every(
        (axis) => axis === except || !this.filters[axis] || this.values(row, axis).includes(this.filters[axis]),
      )
    );
  }
  private counts(axis: Axis) {
    const counts = new Map<string, number>();
    for (const row of this.rows)
      if (this.acceptsStory(row, axis))
        for (const value of this.values(row, axis)) counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }
  private url = (source: unknown) =>
    source && this.source
      ? this.provider !== "haneoka"
        ? new URL(String(source), this.origin).href
        : haneokaResourceRequestUrl(new URL(String(source), this.origin).href, {
            ...this.source,
            releaseId: this.source.releaseId!,
          })
      : "";
  private close = () => {
    if (!this.importing) this.dispatchEvent(new CustomEvent("story-picker-close", { bubbles: true }));
  };
  private choose(axis: Axis, value: string) {
    this.filters = {
      ...this.filters,
      [axis]: this.filters[axis] === value && (axis !== "category" || this.provider === "haneoka") ? "" : value,
    };
    this.selected = "";
  }
  private async selectStory(id: string) {
    if (this.importing) return;
    this.cardRequest?.abort();
    this.selected = id;
    this.cardEpisodes = [];
    this.cardEpisode = "";
    this.cardLoading = false;
    this.cardError = "";
    const row = this.rows.find((row) => String(row.storyId) === id);
    if (!row?.isCardTemplate) return;
    const controller = (this.cardRequest = new AbortController());
    this.cardLoading = true;
    try {
      const url = new URL(`/api/v1/garupa/bestdori/${this.server}/cards/${row.cardId}`, this.origin);
      url.searchParams.set("lang", this.locale);
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("story_catalog_unavailable");
      const card: Row = await response.json();
      controller.signal.throwIfAborted();
      this.cardEpisodes = ((card.episodes as Row[]) || []).map((episode) => ({
        ...episode,
        storyId: `card.${episode.resourceSetName}.${episode.scenarioId}`,
      }));
      this.cardEpisode = String(this.cardEpisodes[0]?.storyId || "");
      if (!this.cardEpisodes.length) this.cardError = this.t("empty");
    } catch {
      if (!controller.signal.aborted) this.cardError = this.t("assetLoadFailed");
    } finally {
      if (!controller.signal.aborted) this.cardLoading = false;
    }
  }
  private async submit() {
    if (!this.source || !this.selected || this.importing || this.cardLoading) return;
    if (this.rows.find((row) => String(row.storyId) === this.selected)?.isCardTemplate && !this.cardEpisode) return;
    this.importing = true;
    this.error = "";
    try {
      const row = this.rows.find((row) => String(row.storyId) === this.selected)!;
      await this.importStory(
        this.source,
        row.isCardTemplate ? this.cardEpisode : this.selected,
        (row.isCardTemplate
          ? this.text(this.cardEpisodes.find((episode) => episode.storyId === this.cardEpisode)?.title)
          : "") ||
          this.text(row.title) ||
          this.text(row.chapterName) ||
          this.selected,
      );
      this.importing = false;
      this.close();
    } catch {
      if (this.isConnected) {
        this.importing = false;
        this.error = this.t("assetLoadFailed");
      }
    }
  }
  override render() {
    const rows = this.rows.filter((row) => this.acceptsStory(row));
    return selectionPane({
      id: "story-import",
      title: this.selectOnly ? this.t("selectStory") : this.t("importStory"),
      closeLabel: this.t("close"),
      close: this.close,
      searchLabel: uiText(this.locale, "story.labels.searchStories"),
      query: this.query,
      search: (value) => {
        if (!this.importing) this.query = value;
      },
      filterLabel: this.t("filters"),
      filtersOpen: this.filtersOpen,
      toggleFilters: () => {
        this.filtersOpen = !this.filtersOpen;
      },
      filterLayout: "facets",
      quickFilters: chooserGroup(
        uiText(this.locale, "catalog.fields.type"),
        html`
          ${[...(this.provider === "haneoka" ? [""] : []), ...this.counts("category").keys()].map((value) =>
            filterChip({
              label: value
                ? `${this.label("category", value)} (${this.counts("category").get(value)})`
                : uiText(this.locale, "common.states.all"),
              selected: this.filters.category === value,
              onToggle: () => {
                if (!this.importing) this.choose("category", value);
              },
            }),
          )}
        `,
      ),
      filters: html`
        ${chooserGroup(
          this.t("assetServer"),
          html`
            ${(this.provider === "haneoka" ? ["jp", "intl"] : ["jp", "en", "tw", "cn", "kr"]).map((server) =>
              filterChip({
                label: this.t(`assetRegions.${server}`),
                selected: this.server === server,
                onToggle: () => {
                  if (!this.importing) {
                    this.server = server as typeof this.server;
                    void this.load();
                  }
                },
              }),
            )}
          `,
        )}${axes
          .filter((axis) => axis !== "category" && (this.provider === "haneoka" || axis !== "episode"))
          .map((axis) =>
            facet(
              uiText(this.locale, axisLabels[axis]),
              this.locale,
              [...this.counts(axis)].map(([value, count]) => ({ value, label: this.label(axis, value), count })),
              this.filters[axis] ? [this.filters[axis]] : [],
              (value) => {
                if (!this.importing) this.choose(axis, value);
              },
            ),
          )}
      `,
      groups:
        this.provider === "haneoka" && ["band", "event"].includes(this.filters.category)
          ? ["main", "extra", "perspective"]
              .map((kind) => ({
                title: uiText(
                  this.locale,
                  `story.labels.${kind === "main" ? (this.filters.category === "event" ? "eventStory" : "bandStory") : kind === "extra" ? "extraStory" : "perspectiveStory"}`,
                ),
                values: new Set(
                  rows.filter((row) => this.values(row, "episode").includes(kind)).map((row) => String(row.storyId)),
                ),
              }))
              .filter((group) => group.values.size)
          : undefined,
      renderGroup: storyEpisodeGroup,
      kind: "story",
      disabled: this.importing,
      items: rows.map((row) => {
        const category = this.category(row),
          chapter =
            this.chapters[String(this.provider === "haneoka" ? row.chapterId : row.chapterKey || row.chapterId)],
          spot = this.spots.get(String(row.storyId));
        const people = ((row.characterIds as number[]) ?? []).map((id) => this.characters[id] ?? {});
        const band = this.bands[String(row.bandId || chapter?.bandId || 0)];
        const rawImage =
          category === "afterlive" ? "" : category === "home" ? spotArtwork(spot) : episodeArtwork(row, chapter);
        const identityImage = episodeIdentityArtwork(row, Object.values(this.characters), band?.icon);
        const friendship = row.unlockCharacterFriendshipLevel ?? row.friendshipLevel;
        return {
          value: String(row.storyId),
          ...storyTile(row, {
            title: this.text(row.title) || String(row.storyId),
            subtitle: ["afterlive", "linkstory"].includes(category)
              ? `${uiText(this.locale, "catalog.characters.fields.friendship")} Lv.${Number(friendship || 0)}`
              : this.text(row.description) ||
                this.text(row.chapterName) ||
                people.map((person) => this.text(person.characterName)).join(" / "),
            image: this.url(rawImage),
            imageCandidates: localeTaggedCandidates(rawImage, this.locale).map(this.url),
            identityImage: this.url(identityImage),
            referrerPolicy: "no-referrer",
            natural: this.provider === "haneoka" && !["home", "afterlive"].includes(category),
            fit: this.provider === "haneoka" ? "cover" : "fill",
            media: row.isCardTemplate
              ? storyCardMedia(row)
              : this.provider !== "haneoka" && category !== "afterlive"
                ? storyThumbnailMedia(this.url(rawImage))
                : ["home", "afterlive"].includes(category)
                  ? storyCastMedia(
                      people.map((person) => ({
                        name: this.text(person.characterName),
                        image: this.url(person.faceImage || person.thumbnailImage),
                      })),
                      category === "home" ? this.url(spotArtwork(spot)) : "",
                      "no-referrer",
                    )
                  : undefined,
          }),
        };
      }),
      selected: this.selected,
      select: (id) => void this.selectStory(id),
      countLabel:
        this.loading || this.importing
          ? this.t("loading")
          : this.t("storyCount").replace("{count}", String(rows.length)),
      emptyLabel: this.t("empty"),
      preview: html`
        ${this.cardLoading ? loadingState(this.t("loading"), { local: true }) : nothing}
        ${
          this.cardEpisodes.length
            ? html`
                <label class="field">
                  <span>${uiText(this.locale, "story.labels.episode")}</span>
                  <select
                    .value=${this.cardEpisode}
                    ?disabled=${this.importing}
                    @change=${(event: Event) => {
                      this.cardEpisode = (event.target as HTMLSelectElement).value;
                    }}
                  >
                    ${this.cardEpisodes.map(
                      (episode) => html`
                        <option value=${String(episode.storyId)}>
                          ${this.text(episode.title) || String(episode.scenarioId)}
                        </option>
                      `,
                    )}
                  </select>
                </label>
              `
            : nothing
        }
        ${
          this.cardError
            ? html`
                <span role="alert">${this.cardError}</span>
                <button class="button button--text" @click=${() => void this.selectStory(this.selected)}>
                  ${this.t("retry")}
                </button>
              `
            : nothing
        }
        ${this.loading || this.importing ? loadingState(this.t("loading"), { local: true }) : nothing}${
          this.error
            ? html`
                <span role="alert">${this.error}</span>
                <button class="button button--text" @click=${() => void this.load()}>${this.t("retry")}</button>
              `
            : nothing
        }
        <button
          class="button button--text"
          ?disabled=${this.importing}
          @click=${() => {
            this.query = "";
            this.filters = {
              category: this.provider === "haneoka" ? "" : this.provider === "sekai" ? "unit" : "band",
              chapter: "",
              band: "",
              character: "",
              episode: "",
            };
          }}
        >
          ${uiText(this.locale, "common.actions.clear")}
        </button>
        <button
          class="button button--filled"
          ?disabled=${this.loading || this.importing || this.cardLoading || !rows.some((row) => String(row.storyId) === this.selected && (!row.isCardTemplate || !!this.cardEpisode))}
          @click=${() => void this.submit()}
        >
          ${this.selectOnly ? this.t("selectStory") : this.t("importStory")}
        </button>
      `,
    });
  }
}
if (!customElements.get("story-import-picker")) customElements.define("story-import-picker", StoryImportPicker);
