// L3 — GEB
// Input: 社区故事集合、不可变版本、账户及语言。
// Output: 共用三视图集合、详情、Vega 阅读和作者版本管理。
// Pos: [Map](L2-2.md)；社区故事的规范集合与实体页面。
// Effects/Dependencies: 同源社区 API、共享详情／评论／播放器；离开释放请求和应用栏。
import { LitElement, html, nothing } from "lit";
import { clientText, initializeI18nClient } from "../i18n/client";
import { storyRequest, downloadStoryProject } from "../lib/story-creation/community";
import { communityStoryDocumentPath, communityStoryReaderPath, parseCommunityStoryDocument } from "../lib/community-story-route";
import { applyCommunityDocumentMetadata } from "../lib/community-document-meta";
import {
  STORY_API,
  communityStoryPath,
  storyCreationPath,
  type CommunityStoryItem,
  type StoryActionReceipt,
  type StoryCloudManifest,
} from "../lib/story-creation/types";
import type { VegaProject } from "@haneoka/vega-protocol";
import type { StoryReaderInput } from "./story-workspace";
import { renderBrowse, clearBrowseBar } from "./ui/browse";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { tile } from "./ui/tile";
import { facet } from "./ui/facet";
import { renderPane, paneSection } from "./ui/pane";
import { detailLayout } from "./ui/detail-layout";
import { specList } from "./ui/spec";
import { icon } from "./ui/icon";
import { loadingState, errorState, emptyState } from "./ui/state";
import { setAppBarSearch, clearAppBarSearch } from "../lib/app-bar";
import { appBarTakeover } from "../lib/app-bar-takeover";
import { LazyImages } from "./ui/lazy-images";
import { modal } from "./ui/modal";
import { snackbar } from "../lib/snackbar";
import "./ui/image-gallery";
import "./entity-comments";
interface Version {
  revision: number;
  title: string;
  createdAt: number;
  publishedAt: number | null;
}
export class CommunityStories extends LitElement {
  static properties = {
    locale: {},
    server: {},
    items: { state: true },
    selected: { state: true },
    phase: { state: true },
    issue: { state: true },
    query: { state: true },
    mine: { state: true },
    view: { state: true },
    filtersOpen: { state: true },
    languages: { state: true },
    busy: { state: true },
    confirming: { state: true },
    project: { state: true },
    playing: { state: true },
    versions: { state: true },
    revision: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare private items: CommunityStoryItem[];
  declare private selected: CommunityStoryItem | undefined;
  declare private phase: string;
  declare private issue: string;
  declare private query: string;
  declare private mine: boolean;
  declare private view: CollectionView;
  declare private filtersOpen: boolean;
  declare private languages: string[];
  declare private busy: boolean;
  declare private confirming: "delete" | "unpublish" | null;
  declare private project: VegaProject | undefined;
  declare private playing: boolean;
  declare private versions: Version[];
  declare private revision: number;
  private lifetime = new AbortController();
  private stopLocale?: () => void;
  private images = new LazyImages();
  private storyId = "";
  private reader: StoryReaderInput | undefined;
  private managementRequest: { action: string; version: number; requestId: string } | undefined;
  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.items = [];
    this.phase = "loading";
    this.issue = "";
    this.query = "";
    this.mine = false;
    this.view = "grid";
    this.filtersOpen = false;
    this.languages = [];
    this.busy = false;
    this.confirming = null;
    this.playing = false;
    this.versions = [];
    this.revision = 0;
  }
  createRenderRoot() {
    return this;
  }
  private t = (key: string) => clientText(this.locale, `community.stories.${key}`);
  private href = (id = "") => communityStoryPath(this.server, this.locale, id);
  override connectedCallback() {
    super.connectedCallback();
    const url = new URL(location.href),
      route = parseCommunityStoryDocument(url.pathname);
    this.storyId = route?.id || "";
    if (route) applyCommunityDocumentMetadata(document, route.locale, locale => communityStoryDocumentPath(route, locale), "https://haneoka.org");
    this.mine = url.searchParams.get("scope") === "mine";
    this.revision = Number(url.searchParams.get("revision") || 0);
    this.stopLocale = initializeI18nClient().subscribe((c) => {
      this.locale = c.locale;
      this.requestUpdate();
    });
    if (!this.storyId)
      setAppBarSearch("community-stories", {
        value: this.query,
        label: this.t("search"),
        onInput: (value) => {
          this.query = value;
        },
      });
    void this.load();
  }
  override disconnectedCallback() {
    this.lifetime.abort();
    this.stopLocale?.();
    this.images.disconnect();
    clearBrowseBar();
    clearAppBarSearch("community-stories");
    super.disconnectedCallback();
  }
  protected override updated() {
    this.images.observe(this);
    this.classList.toggle("page", !this.playing);
    this.classList.toggle("story-player-host", this.playing);
  }
  private errorText(error: unknown) {
    const key = `errors.${error instanceof Error ? error.message.split(":")[0] : "service_unavailable"}`,
      label = this.t(key);
    return label === `community.stories.${key}` ? this.t("errors.service_unavailable") : label;
  }
  private languageLabel(code: string): string {
    if (code === "und") return this.t("language-unspecified");
    return new Intl.DisplayNames([this.locale], { type: "language" }).of(code) ?? code;
  }
  private notify(error: unknown) {
    snackbar(this.errorText(error));
  }
  private async load() {
    this.phase = "loading";
    try {
      if (this.storyId) {
        const query = new URLSearchParams(location.search);
        if (this.revision) query.set("revision", String(this.revision));
        const { story } = await storyRequest<{ story: CommunityStoryItem }>(`${STORY_API}/${this.storyId}?${query}`, {
          signal: this.lifetime.signal,
        });
        this.selected = story;
        const { versions } = await storyRequest<{ versions: Version[] }>(
          `${STORY_API}/${this.storyId}/versions?${query}`,
          { signal: this.lifetime.signal },
        );
        this.versions = versions;
      } else {
        const { stories } = await storyRequest<{ stories: CommunityStoryItem[] }>(
          STORY_API + (this.mine ? "?scope=mine" : ""),
          { signal: this.lifetime.signal },
        );
        this.items = stories;
      }
      if (this.selected && parseCommunityStoryDocument(location.pathname)?.reader && !this.selected.compilationError)
        await this.play();
      this.phase = "ready";
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        this.phase = "error";
        this.issue = this.errorText(error);
      }
    }
  }
  private async play() {
    if (this.busy || !this.selected) return;
    this.busy = true;
    try {
      const [, { vegaProjectToAdvStory }] = await Promise.all([
        import("./story-workspace"),
        import("@haneoka/vega/web"),
      ]);
      const query = new URLSearchParams({ revision: String(this.selected.revision) });
      if (new URL(location.href).searchParams.get("draft") === "1") query.set("draft", "1");
      const data = await storyRequest<{ project: VegaProject }>(`${STORY_API}/${this.storyId}/runtime?${query}`, {
        signal: this.lifetime.signal,
      });
      this.project = data.project;
      const row = this.selected;
      this.reader = {
        project: data.project,
        story: {
          ...vegaProjectToAdvStory(data.project),
          storyId: `community:${row.id}:${row.revision}`,
          title: row.title,
        },
        server: this.server,
        backHref: this.href(row.id) + location.search,
        ...(row.canEdit || row.remix
          ? {
              editorHref:
                storyCreationPath(this.locale, row.id) + `&revision=${row.revision}${row.canEdit ? "" : "&remix=1"}`,
            }
          : {}),
        comments: { id: row.id, type: "community-stories" },
      };
      this.playing = true;
    } finally {
      this.busy = false;
    }
  }
  private async like() {
    if (this.busy || !this.selected) return;
    this.busy = true;
    try {
      const { story } = await storyRequest<{ story: CommunityStoryItem }>(`${STORY_API}/${this.storyId}/like`, {
        method: "PUT",
        body: JSON.stringify({ liked: !this.selected.liked }),
        signal: this.lifetime.signal,
      });
      this.selected = { ...this.selected, likeCount: story.likeCount, liked: story.liked };
    } catch (error) {
      this.notify(error);
    } finally {
      this.busy = false;
    }
  }
  private async download() {
    if (this.busy || !this.selected) return;
    this.busy = true;
    try {
      const row = this.selected,
        { manifest, story } = await storyRequest<{ manifest: StoryCloudManifest; story: CommunityStoryItem }>(
          `${STORY_API}/${row.id}/project?draft=1&revision=${row.revision}`,
          { signal: this.lifetime.signal },
        );
      const source = await downloadStoryProject(
        story,
        manifest,
        this.lifetime.signal,
        story.canEdit,
        story.canEdit ? undefined : story,
      );
      const { createWorkspaceZip } = await import("@haneoka/altair-plugin-workspace-browser/archive");
      const blob = await createWorkspaceZip(
        source.files,
        source.directories,
        this.lifetime.signal,
        new Set(source.files.filter((f) => /\.(?:ya?ml|json|txt)$/iu.test(f.path)).map((f) => f.path)),
      );
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${story.title.replace(/[\\/:*?"<>|]/gu, "_")}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      this.notify(error);
    } finally {
      this.busy = false;
    }
  }
  private async manage() {
    if (this.busy || !this.selected || !this.confirming) return;
    this.busy = true;
    try {
      const action = this.confirming;
      const intent =
        this.managementRequest?.action === action && this.managementRequest.version === this.selected.version
          ? this.managementRequest
          : { action, version: this.selected.version, requestId: crypto.randomUUID() };
      this.managementRequest = intent;
      const receipt = await storyRequest<StoryActionReceipt>(
        `${STORY_API}/${this.storyId}${action === "unpublish" ? "/unpublish" : ""}?draft=1`,
        {
          method: action === "delete" ? "DELETE" : "POST",
          signal: this.lifetime.signal,
          headers: { "X-Haneoka-Actor": this.selected.ownerId },
          body: JSON.stringify({ version: intent.version, requestId: intent.requestId }),
        },
      );
      this.managementRequest = undefined;
      this.confirming = null;
      if (action === "delete") location.assign(this.href() + "?scope=mine");
      else {
        history.replaceState(null, "", this.href(this.storyId) + "?draft=1");
        await this.load();
        snackbar(
          this.t(
            receipt.story?.publishedRevision || receipt.story?.publishingRevision
              ? "errors.version_conflict"
              : "withdrawn",
          ),
        );
      }
    } catch (error) {
      this.notify(error);
    } finally {
      this.busy = false;
    }
  }
  private renderDetail(row: CommunityStoryItem) {
    const back = () => location.assign(this.href() + (this.mine ? "?scope=mine" : ""));
    const actions = html`
      <a
        class="icon-button"
        href=${row.compilationError ? nothing : communityStoryReaderPath(this.server, this.locale, row.id) + location.search}
        aria-disabled=${String(!!row.compilationError)}
        title=${this.t("read")}
        aria-label=${this.t("read")}
      >
        ${icon("play_arrow")}
      </a>
      <button
        class="icon-button"
        ?disabled=${this.busy}
        title=${this.t("like")}
        aria-label=${this.t("like")}
        aria-pressed=${String(row.liked)}
        @click=${() => void this.like()}
      >
        ${icon("favorite")}
      </button>
      ${
        row.canEdit || row.remix
          ? html`
              <button
                class="icon-button"
                title=${this.t("export-project")}
                aria-label=${this.t("export-project")}
                ?disabled=${this.busy}
                @click=${() => void this.download()}
              >
                ${icon("download")}
              </button>
            `
          : nothing
      }${
        row.canEdit
          ? html`
              <a
                class="icon-button"
                title=${this.t("edit")}
                aria-label=${this.t("edit")}
                href=${storyCreationPath(this.locale, row.id) + (this.revision ? `&revision=${row.revision}` : "")}
              >
                ${icon("edit")}
              </a>
            `
          : row.remix
            ? html`
                <a
                  class="icon-button"
                  title=${this.t("remix")}
                  aria-label=${this.t("remix")}
                  href=${storyCreationPath(this.locale, row.id) + `&remix=1&revision=${row.revision}`}
                >
                  ${icon("edit_note")}
                </a>
              `
            : nothing
      }
    `;
    if (this.playing && this.reader)
      return html`
        <story-workspace
          .reader=${this.reader}
          .locale=${this.locale}
          @story-reader-close=${() => {
              location.assign(this.href(row.id) + location.search);
            }}
        ></story-workspace>
      `;
    return html`
      <section
        ${appBarTakeover({ title: row.title, backLabel: this.t("back"), backHref: this.href(), onBack: back, actions })}
      >
        ${renderPane({
          title: row.title,
          page: true,
          hideHeader: true,
          open: true,
          backLabel: this.t("back"),
          onClose: back,
          body: detailLayout(
            row.coverUrl
              ? html`
                  <image-gallery
                    locale=${this.locale}
                    title=${row.title}
                    .images=${[{ id: "cover", source: row.coverUrl, label: row.title }]}
                  ></image-gallery>
                `
              : nothing,
            html`
              ${paneSection(
                this.t("information"),
                icon("info"),
                specList(
                  [
                    {
                      label: this.t("author"),
                      value: html`
                        <a href=${`/${this.locale}/community/users/${row.ownerUid}/`}>${row.ownerName}</a>
                      `,
                    },
                    {
                      label: this.t("languages"),
                      value: row.locales.map((code) => this.languageLabel(code)).join(" · "),
                    },
                    { label: this.t("scenes"), value: row.sceneCount },
                    { label: this.t("commands"), value: row.commandCount },
                    { label: this.t("version"), value: row.revision },
                    { label: this.t("likes"), value: row.likeCount },
                    {
                      label: this.t("updatedAt"),
                      value: new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(row.updatedAt),
                    },
                  ],
                  { split: true },
                ),
              )}
              ${
                row.summary
                  ? paneSection(
                      this.t("summary"),
                      icon("description"),
                      html`
                        <p>${row.summary}</p>
                      `,
                    )
                  : nothing
              }
              ${paneSection(this.t("versions"), icon("history"), collectionList(this.versions.map((v) => ({ id: String(v.revision), title: v.title, subtitle: new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "short" }).format(v.createdAt), media: icon("history"), trailing: v.revision, href: this.href(row.id) + `?revision=${v.revision}${row.canEdit ? "&draft=1" : ""}` }))))}
              ${
                row.upstreamId
                  ? paneSection(
                      this.t("upstream"),
                      icon("link"),
                      html`
                        <div class="detail-object">
                          ${
                            row.upstream?.available
                              ? html`
                                  <a href=${this.href(row.upstreamId) + `?revision=${row.upstream.revision}`}>
                                    ${row.upstream.title}
                                  </a>
                                `
                              : html`
                                  <span>${row.upstream?.title || this.t("original")}</span>
                                `
                          }${
                            row.upstream
                              ? html`
                                  <a href=${`/${this.locale}/community/users/${row.upstream.ownerUid}/`}>
                                    ${row.upstream.ownerName}
                                  </a>
                                `
                              : nothing
                          }
                          ${
                            row.upstream
                              ? html`
                                  <span class="chip">${this.t("version")} ${row.upstream.revision}</span>
                                `
                              : nothing
                          }
                        </div>
                      `,
                    )
                  : nothing
              }
              ${
                row.canEdit
                  ? paneSection(
                      this.t("publication"),
                      icon("publish"),
                      html`
                        <div class="cluster">
                          <span class="chip">
                            ${this.t(row.publishingRevision ? "processing" : row.publishedRevision ? "published" : "draft")}
                          </span>
                          <button
                            class="button button--tonal"
                            ?disabled=${this.busy || (!row.publishedRevision && !row.publishingRevision)}
                            @click=${() => {
                              this.confirming = "unpublish";
                            }}
                          >
                            ${this.t("unpublish")}
                          </button>
                          <button
                            class="button button--text"
                            ?disabled=${this.busy}
                            @click=${() => {
                              this.confirming = "delete";
                            }}
                          >
                            ${this.t("delete")}
                          </button>
                        </div>
                      `,
                    )
                  : nothing
              }
            `,
            {
              comments: html`
                <entity-comments
                  entity-type="community-stories"
                  entity-id=${row.id}
                  target-title=${row.title}
                  locale=${this.locale}
                  server=${this.server}
                ></entity-comments>
              `,
              placement: "bottom",
              hasMedia: !!row.coverUrl,
            },
          ),
        })}
      </section>
    `;
  }
  render() {
    if (this.phase === "loading") return loadingState(this.t("loading"));
    if (this.phase === "error") return errorState(this.issue, this.t("retry"), () => void this.load());
    const rows = this.items.filter(
      (row) =>
        (!this.query ||
          `${row.title} ${row.summary} ${row.ownerName}`
            .normalize("NFKC")
            .toLocaleLowerCase(this.locale)
            .includes(this.query.normalize("NFKC").toLocaleLowerCase(this.locale))) &&
        (!this.languages.length || this.languages.some((l) => row.locales.includes(l))),
    );
    return html`
      ${
        this.selected
          ? this.renderDetail(this.selected)
          : renderBrowse({
              kind: "community-stories",
              count: { value: rows.length, label: this.t("title") },
              modes: viewSwitch(this.locale, this.view, (view) => {
                this.view = view;
              }),
              controls: html`
                <a class="button button--tonal" href=${storyCreationPath(this.locale)}>
                  ${icon("add")}${this.t("create")}
                </a>
                <a
                  class="icon-button"
                  title=${this.t(this.mine ? "browse" : "mine")}
                  aria-label=${this.t(this.mine ? "browse" : "mine")}
                  href=${this.href() + (this.mine ? "" : "?scope=mine")}
                >
                  ${icon("person")}
                </a>
              `,
              filters: {
                label: this.t("filters"),
                open: this.filtersOpen,
                count: this.languages.length,
                closeLabel: this.t("close"),
                resetLabel: this.t("reset"),
                onOpen: () => {
                  this.filtersOpen = true;
                },
                onClose: () => {
                  this.filtersOpen = false;
                },
                onReset: () => {
                  this.languages = [];
                },
                body: facet(
                  this.t("languages"),
                  this.locale,
                  [...new Set(this.items.flatMap((r) => r.locales))].map((value) => ({
                    value,
                    label: this.languageLabel(value),
                    count: this.items.filter((r) => r.locales.includes(value)).length,
                  })),
                  this.languages,
                  (value) => {
                    this.languages = this.languages.includes(value)
                      ? this.languages.filter((l) => l !== value)
                      : [...this.languages, value];
                  },
                ),
              },
              applied: html`
                ${this.languages.map(
                  (value) => html`
                    <button
                      class="chip"
                      @click=${() => {
                        this.languages = this.languages.filter((l) => l !== value);
                      }}
                    >
                      ${value}${icon("close", 18)}
                    </button>
                  `,
                )}
              `,
              results: !rows.length
                ? emptyState({ title: this.t("empty"), icon: "auto_stories" })
                : this.view === "list"
                  ? collectionList(
                      rows.map((row) => ({
                        id: row.id,
                        title: row.title,
                        subtitle: row.ownerName,
                        image: row.coverUrl,
                        href: this.href(row.id) + (this.mine ? "?draft=1" : ""),
                      })),
                    )
                  : this.view === "table"
                    ? collectionTable(
                        this.t("title"),
                        [this.t("titleField"), this.t("author"), this.t("scenes"), this.t("languages")],
                        rows.map((row) => [
                          html`
                            <a href=${this.href(row.id) + (this.mine ? "?draft=1" : "")}>${row.title}</a>
                          `,
                          row.ownerName,
                          row.sceneCount,
                          row.locales.map((code) => this.languageLabel(code)).join(" · "),
                        ]),
                      )
                    : html`
                        <div class="collection">
                          ${rows.map((row) => tile({ label: row.title, title: row.title, subtitle: row.ownerName, image: row.coverUrl, href: this.href(row.id) + (this.mine ? "?draft=1" : "") }))}
                        </div>
                      `,
            })
      }
      ${
        this.confirming
          ? html`
              <dialog
                class="dialog"
                ${modal(() => {
                  this.confirming = null;
                })}
              >
                <div class="dialog__body">
                  <h2>${this.t(this.confirming === "delete" ? "deleteConfirm" : "unpublishConfirm")}</h2>
                </div>
                <div class="dialog__actions">
                  <button
                    class="button button--text"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.confirming = null;
                    }}
                  >
                    ${this.t("cancel")}
                  </button>
                  <button class="button button--filled" ?disabled=${this.busy} @click=${() => void this.manage()}>
                    ${this.t(this.confirming)}
                  </button>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
}
customElements.define("community-stories", CommunityStories);
