// L3 — GEB
// Input: 社区谱面目录／详情、语言与账户可见状态。
// Output: 三种集合视图、共用歌曲详情摘要／统计与推荐难度、歌曲播放、2D／3D 谱面页和 Sonolus 入口。
// Pos: [Map](L2-2.md)；社区谱面浏览工作区。
// Effects/Dependencies: 社区 HTTP、应用栏接管、音频与懒加载图片；离开释放请求和应用栏。
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { LitElement, html, nothing } from "lit";
import { parseCommunityChartDocument } from "../lib/community-chart-route";
import { readReleaseServer } from "../lib/release-server";
import { clientText, initializeI18nClient } from "../i18n/client";
import { chartRequest, CHART_API } from "../lib/chart-creation/community";
import {
  chartLevelName,
  communityChartPath,
  communityChartPlayerPath,
  type CommunityChartItem,
} from "../lib/chart-creation/community-types";
import { renderBrowse, clearBrowseBar } from "./ui/browse";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { tile } from "./ui/tile";
import { songTile } from "./shared/song-tile";
import { songChartSummary, songDetailSection } from "./ui/song-summary";
import { difficultyBadge } from "./ui/difficulty-picker";
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
import { accordion } from "./ui/accordion";
import { snackbar } from "../lib/snackbar";
import { songDetailActions, chartPageActions } from "./ui/song-actions";
import { navigateDetailPage, entityReturnHref } from "../lib/detail-navigation";
import { navigationDocumentUrl } from "../lib/document-url";
import type { ChartSimulator } from "./runtime/chart-simulator";
import "./ui/image-gallery";
import "./entity-comments";
import { formatDate } from "../lib/date-format";
interface ChartVersion {
  revision: number;
  title: string;
  createdAt: number;
  publishedAt: number | null;
}

export class CommunityCharts extends LitElement {
  static properties = {
    locale: {},
    server: {},
    items: { state: true },
    selected: { state: true },
    phase: { state: true },
    error: { state: true },
    view: { state: true },
    query: { state: true },
    mine: { state: true },
    filtersOpen: { state: true },
    difficulties: { state: true },
    sort: { state: true },
    busy: { state: true },
    confirming: { state: true },
    versions: { state: true },
    versionsExpanded: { state: true },
    chartMode: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare private items: CommunityChartItem[];
  declare private selected: CommunityChartItem | undefined;
  declare private phase: "loading" | "ready" | "error";
  declare private error: string;
  declare private view: CollectionView;
  declare private query: string;
  declare private mine: boolean;
  declare private filtersOpen: boolean;
  declare private difficulties: string[];
  declare private sort: string;
  declare private busy: boolean;
  declare private confirming: "delete" | "unpublish" | null;
  declare private versionsExpanded: boolean;
  declare private versions: ChartVersion[];
  private controller?: AbortController;
  private unlocale?: () => void;
  private images = new LazyImages();
  private chartId = "";
  private chartPage = false;
  private playerSource = "";
  declare private chartMode: "simple" | "watch";
  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.items = [];
    this.phase = "loading";
    this.error = "";
    this.view = "grid";
    this.query = "";
    this.mine = false;
    this.filtersOpen = false;
    this.difficulties = [];
    this.sort = "new";
    this.busy = false;
    this.confirming = null;
    this.versionsExpanded = false;
    this.versions = [];
    this.chartMode = "simple";
  }
  createRenderRoot() {
    return this;
  }
  private t(key: string) {
    return clientText(
      this.locale,
      `community.charts.${key}`,
      clientText(this.locale, "community.charts.errors.service_unavailable"),
    );
  }
  override connectedCallback() {
    super.connectedCallback();
    this.server = readReleaseServer();
    const url = navigationDocumentUrl();
    const chartDocument = parseCommunityChartDocument(url.pathname);
    this.chartId = chartDocument?.id ?? "";
    this.chartPage = chartDocument?.player ?? false;
    if (this.chartId) {
      const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (canonical)
        canonical.href = new URL(
          this.chartPage
            ? communityChartPlayerPath(this.server, this.locale, this.chartId)
            : communityChartPath(this.server, this.locale, this.chartId),
          canonical.href,
        ).href;
    }
    this.mine = url.searchParams.get("scope") === "mine";
    this.unlocale = initializeI18nClient().subscribe((catalog) => {
      this.locale = catalog.locale;
      this.requestUpdate();
    });
    if (!this.chartId)
      setAppBarSearch("community-charts", {
        value: this.query,
        label: this.t("search"),
        onInput: (value) => {
          this.query = value;
        },
      });
    void this.load();
  }
  override disconnectedCallback() {
    this.controller?.abort();
    this.unlocale?.();
    this.images.disconnect();
    clearBrowseBar();
    clearAppBarSearch("community-charts");
    super.disconnectedCallback();
  }
  protected override updated() {
    this.images.observe(this);
  }
  protected override willUpdate() {
    if (this.sort === "recommended" && !this.matchingCharts().some((row) => this.recommendation(row) !== undefined))
      this.sort = "new";
  }
  private async load() {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.phase = "loading";
    try {
      if (this.chartId) {
        const selection = new URLSearchParams({ draft: "1" });
        const revision = navigationDocumentUrl().searchParams.get("revision");
        if (this.chartPage && revision) selection.set("revision", revision);
        const { chart } = await chartRequest<{ chart: CommunityChartItem }>(
          `${CHART_API}/${this.chartId}?${selection}`,
          {
            signal: controller.signal,
          },
        );
        this.selected = chart;
        document.title = `${chart.title} · haneoka`;
        if (this.chartPage) {
          const [{ releaseId }] = await Promise.all([
            chartRequest<{ releaseId: string }>(`/api/v1/servers/${this.server}/release?projection=identity`, {
              signal: controller.signal,
            }),
            import("./runtime/chart-simulator"),
          ]);
          const query = new URLSearchParams({ revision: String(chart.revision), draft: "1", release: releaseId });
          this.playerSource = `${CHART_API}/${chart.id}/playback?${query}`;
        }
        if (chart.canEdit && !this.chartPage)
          this.versions = (
            await chartRequest<{ revisions: ChartVersion[] }>(`${CHART_API}/${this.chartId}/revisions?draft=1`, {
              signal: controller.signal,
            })
          ).revisions;
      } else {
        const { charts } = await chartRequest<{ charts: CommunityChartItem[] }>(
          `${CHART_API}${this.mine ? "?scope=mine" : ""}`,
          { signal: controller.signal },
        );
        this.items = charts;
      }
      controller.signal.throwIfAborted();
      this.phase = "ready";
    } catch (error) {
      if (!controller.signal.aborted) {
        this.phase = "error";
        this.error = this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`);
      }
    }
  }
  private async like() {
    const row = this.selected;
    if (!row || this.busy) return;
    this.busy = true;
    try {
      const { chart } = await chartRequest<{ chart: CommunityChartItem }>(`${CHART_API}/${row.id}/like`, {
        method: "PUT",
        body: JSON.stringify({ liked: !row.liked }),
      });
      this.selected = { ...row, likeCount: chart.likeCount, liked: chart.liked };
    } catch (error) {
      snackbar(this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`));
    } finally {
      this.busy = false;
    }
  }
  private async manage() {
    const row = this.selected,
      action = this.confirming;
    if (!row || !action || this.busy) return;
    this.busy = true;
    try {
      await chartRequest(`${CHART_API}/${row.id}${action === "unpublish" ? "/unpublish" : ""}`, {
        method: action === "delete" ? "DELETE" : "POST",
        body: JSON.stringify({ version: row.version }),
      });
      if (action === "delete") location.assign(communityChartPath(this.server, this.locale) + "?scope=mine");
      else {
        this.confirming = null;
        await this.load();
        snackbar(this.t("withdrawn"));
      }
    } catch (error) {
      snackbar(this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`));
    } finally {
      this.busy = false;
    }
  }
  private async playSong(row: CommunityChartItem) {
    try {
      const { AudioDock } = await import("./runtime/audio-dock");
      if (!this.isConnected) return;
      await AudioDock.ensure().enqueueTrack(
        {
          id: chartLevelName(row.id),
          songKey: `community:${row.id}:${row.revision}`,
          title: row.title,
          artist: row.artist,
          cover: row.coverUrl,
          url: row.audioUrl,
          detailPath: communityChartPath(this.server, this.locale, row.id),
        },
        true,
      );
    } catch {
      snackbar(this.t("errors.service_unavailable"));
    }
  }
  private openChart(row: CommunityChartItem) {
    const target = new URL(communityChartPlayerPath(this.server, this.locale, row.id), location.href);
    target.searchParams.set("revision", String(row.revision));
    target.searchParams.set("return", `${location.pathname}${location.search}`);
    return navigateDetailPage(target.href);
  }
  private downloadChart(row: CommunityChartItem) {
    return this.querySelector<ChartSimulator>("chart-simulator")?.downloadOverview({
      title: row.title,
      artist: row.artist,
      jacketUrl: row.coverUrl || undefined,
      difficultyName: row.difficulty,
      displayLevel: row.level,
      credits: [{ label: this.t("charter"), value: row.charter || row.ownerName }],
      stats: [
        { id: "notes", label: clientText(this.locale, "catalog.analysis.fields.n"), value: "—" },
        { id: "time", label: clientText(this.locale, "common.fields.time"), value: "—" },
        { id: "bpm", label: clientText(this.locale, "catalog.analysis.fields.bpm"), value: "—" },
        { id: "nps", label: clientText(this.locale, "catalog.analysis.fields.nps"), value: "—" },
      ],
    });
  }
  private renderChart(row: CommunityChartItem) {
    const title = `${row.title} — ${row.difficulty.toUpperCase()} ${row.level}`;
    const back = entityReturnHref() || communityChartPath(this.server, this.locale, row.id);
    return html`
      <section
        class="chart-page"
        aria-label=${title}
        ${appBarTakeover({
          title,
          backLabel: clientText(this.locale, "common.actions.back"),
          backHref: back,
          onBack: () => void navigateDetailPage(back),
          actions: chartPageActions({
            locale: this.locale,
            mode: this.chartMode,
            onMode: (mode) => {
              this.chartMode = mode;
            },
            onDownload: () => void this.downloadChart(row),
          }),
        })}
      >
        <chart-simulator
          source=${this.playerSource}
          chart-format="community"
          audio-url=${row.audioUrl}
          band-id="1"
          .introContent=${{
            title: row.title,
            artist: row.artist,
            jacketUrl: row.coverUrl,
            difficulty: row.difficulty,
            level: row.level,
            layoutMode: "lightweight",
          }}
          label=${title}
          locale=${this.locale}
          server=${this.server}
          .mode=${this.chartMode}
        ></chart-simulator>
      </section>
    `;
  }
  private recommendation(row: CommunityChartItem): number | undefined {
    const estimate = row.analysis?.difficultyEstimate;
    return estimate?.estimatedConstant != null &&
      estimate.estimatedConstant > 0 &&
      ["estimated", "low-confidence"].includes(estimate.quality.status)
      ? estimate.estimatedConstant
      : undefined;
  }
  private recommendedLevel(row: CommunityChartItem) {
    const recommendation = this.recommendation(row);
    return recommendation === undefined ? "—" : `≈${recommendation.toLocaleString(this.locale, { maximumFractionDigits: 0 })}`;
  }
  private chartBadge(row: CommunityChartItem, recommendation = false) {
    const label = `${this.t("recommendedLevel")} ${this.recommendedLevel(row)}`;
    return difficultyBadge(
      { difficultyName: row.difficulty, displayLevel: row.level },
      recommendation
        ? html`
            <small class="difficulty-constant" aria-label=${label} title=${label}>${this.recommendedLevel(row)}</small>
          `
        : nothing,
    );
  }
  private chartSummary(row: CommunityChartItem) {
    const a = row.analysis;
    const seconds = a ? Math.round(a.time) : 0;
    const bpm = a ? (a.minBpm === a.maxBpm ? String(a.firstBpm) : `${a.minBpm}–${a.maxBpm}`) : "—";
    return songChartSummary({
      title: clientText(this.locale, "navigation.chart"),
      difficulty: this.chartBadge(row),
      metrics: [
        { label: this.t("recommendedLevel"), value: this.recommendedLevel(row) },
        {
          label: clientText(this.locale, "catalog.analysis.fields.metaTime"),
          value: seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—",
        },
        { label: clientText(this.locale, "catalog.analysis.fields.metaBpm"), value: bpm },
        {
          label: clientText(this.locale, "catalog.analysis.fields.metaN"),
          value: a ? a.n.toLocaleString(this.locale) : "—",
        },
        {
          label: clientText(this.locale, "catalog.analysis.fields.metaNps"),
          value: a ? a.nps.toLocaleString(this.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—",
        },
      ],
    });
  }
  private detail(row: CommunityChartItem) {
    const back = communityChartPath(this.server, this.locale),
      c = (key: string) => clientText(this.locale, key);
    const actions = html`
      ${songDetailActions({
        locale: this.locale,
        onPlay: row.audioUrl ? () => void this.playSong(row) : undefined,
        onChart: () => void this.openChart(row),
        sonolus: row.publishedRevision
          ? `https://open.sonolus.com/haneoka.org/levels/${chartLevelName(row.id)}`
          : undefined,
      })}
      ${
        row.canEdit || row.remix
          ? html`
              <a
                class="icon-button"
                href=${`/${this.locale}/chart-editor/create/?community=${row.id}`}
                aria-label=${this.t(row.canEdit ? "edit" : "remixAction")}
              >
                ${row.canEdit ? icon("edit") : icon("content_copy")}
              </a>
            `
          : nothing
      }
    `;
    return html`
      <div
        ${appBarTakeover({
          title: row.title,
          backLabel: c("common.actions.back"),
          backHref: back,
          onBack: () => location.assign(back),
          actions,
        })}
      >
        ${renderPane({
          title: row.title,
          open: true,
          page: true,
          hideHeader: true,
          backLabel: c("common.actions.back"),
          onClose: () => location.assign(back),
          body: detailLayout(
            row.coverUrl
              ? html`
                  <image-gallery
                    .locale=${this.locale}
                    .title=${row.title}
                    .images=${[{ id: row.id, source: row.coverUrl, label: row.title }]}
                  ></image-gallery>
                `
              : nothing,
            html`
              ${songDetailSection(
                c("common.actions.details"),
                "details",
                specList(
                  [
                    { label: this.t("artist"), value: row.artist },
                    { label: this.t("charter"), value: row.charter || row.ownerName },
                    {
                      label: this.t("owner"),
                      value: html`
                        <a href=${`/${this.locale}/community/users/${row.ownerUid}/`}>${row.ownerName}</a>
                      `,
                    },
                    {
                      label: this.t("publishedAt"),
                      value: row.publishedAt
                        ? formatDate(this.locale, row.publishedAt)
                        : "—",
                    },
                  ],
                  { split: true },
                ),
              )}
              ${this.chartSummary(row)}
              ${songDetailSection(
                this.t("publication"),
                "works",
                specList(
                  [
                    { label: this.t("authorLevel"), value: row.level },
                    { label: this.t("version"), value: row.revision },
                    {
                      label: this.t("state"),
                      value: this.t(row.revision === row.publishedRevision ? "published" : "draft"),
                    },
                    { label: this.t("visibility"), value: this.t(row.visibility) },
                    { label: this.t("remix"), value: this.t(row.remix ? "remixAllowed" : "remixClosed") },
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
              ${
                row.upstreamId
                  ? paneSection(
                      this.t("original"),
                      icon("music_note"),
                      html`
                        <a class="detail-object" href=${communityChartPath(this.server, this.locale, row.upstreamId)}>
                          ${this.t("original")}
                        </a>
                      `,
                    )
                  : nothing
              }
              ${
                this.versions.length
                  ? paneSection(
                      this.t("versions"),
                      icon("history"),
                      accordion({
                        id: "community-chart-versions",
                        label: this.t("versions"),
                        expanded: this.versionsExpanded,
                        onExpandedChange: (expanded) => {
                          this.versionsExpanded = expanded;
                        },
                        content: html`
                          <ul class="list">
                            ${this.versions.map(
                              (version) => html`
                                <li>
                                  <a
                                    class="list-item list-item--two-line list-item--interactive"
                                    href=${`/${this.locale}/chart-editor/create/?community=${row.id}&revision=${version.revision}`}
                                  >
                                    <span class="list-item__body">
                                      <strong class="list-item__headline">
                                        ${version.revision} · ${version.title}
                                      </strong>
                                      <span class="list-item__supporting">
                                        ${formatDate(this.locale, version.createdAt, { time: true })} ·
                                        ${this.t(version.publishedAt ? "published" : "draft")}
                                      </span>
                                    </span>
                                    <span class="list-item__trailing">${this.t("restore")}</span>
                                  </a>
                                </li>
                              `,
                            )}
                          </ul>
                        `,
                      }),
                      this.versions.length,
                    )
                  : nothing
              }
              ${songDetailSection(
                this.t("community"),
                "comments",
                html`
                  <div class="cluster">
                    <button
                      class="button button--tonal"
                      ?disabled=${this.busy || !row.publishedRevision}
                      aria-label=${`${this.t("likes")} ${row.likeCount}`}
                      aria-pressed=${String(row.liked)}
                      @click=${() => void this.like()}
                    >
                      ${icon("favorite")}${row.likeCount}
                    </button>
                    <button
                      class="button button--text"
                      @click=${async () => {
                        try {
                          await navigator.clipboard.writeText(location.href);
                          snackbar(this.t("copied"));
                        } catch {
                          snackbar(this.t("errors.copy_failed"));
                        }
                      }}
                    >
                      ${this.t("share")}
                    </button>
                  </div>
                `,
              )}
              ${
                row.canEdit
                  ? paneSection(
                      this.t("manage"),
                      icon("tune"),
                      html`
                        <div class="cluster">
                          ${
                            row.publishedRevision
                              ? html`
                                  <button
                                    class="button button--text"
                                    @click=${() => {
                                      this.confirming = "unpublish";
                                    }}
                                  >
                                    ${this.t("unpublish")}
                                  </button>
                                `
                              : nothing
                          }
                          <button
                            class="button button--text"
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
              hasMedia: !!row.coverUrl,
              placement: "bottom",
              comments: row.publishedRevision
                ? html`
                    <entity-comments
                      entity-type="community-charts"
                      entity-id=${row.id}
                      locale=${this.locale}
                      server=${this.server}
                      target-title=${row.title}
                    ></entity-comments>
                  `
                : nothing,
            },
          ),
        })}
        ${
          this.confirming
            ? html`
                <dialog
                  class="dialog"
                  aria-label=${this.t(this.confirming)}
                  ${modal(() => {
                    if (!this.busy) this.confirming = null;
                  })}
                >
                  <header class="dialog__header"><h2>${this.t(this.confirming)}</h2></header>
                  <div class="dialog__body"><p>${row.title}</p></div>
                  <div class="dialog__actions">
                    <button
                      class="button"
                      ?disabled=${this.busy}
                      @click=${() => {
                        this.confirming = null;
                      }}
                    >
                      ${c("common.actions.cancel")}
                    </button>
                    <button class="button button--filled" ?disabled=${this.busy} @click=${() => void this.manage()}>
                      ${this.t(this.confirming)}
                    </button>
                  </div>
                </dialog>
              `
            : nothing
        }
      </div>
    `;
  }
  private matchingCharts() {
    const q = this.query.normalize("NFKC").trim().toLocaleLowerCase();
    return this.items.filter(
      (row) =>
        `${row.title} ${row.artist} ${row.charter} ${row.ownerName}`
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(q) &&
        (!this.difficulties.length || this.difficulties.includes(row.difficulty)),
    );
  }
  render() {
    const c = (key: string) => clientText(this.locale, key);
    if (this.chartId)
      return this.phase === "loading"
        ? loadingState(c("common.states.loading"))
        : this.phase === "error"
          ? errorState(this.error, c("common.actions.retry"), () => void this.load())
          : this.selected
            ? this.chartPage
              ? this.renderChart(this.selected)
              : this.detail(this.selected)
            : nothing;
    const rows = this.matchingCharts();
    const hasRecommendation = rows.some((row) => this.recommendation(row) !== undefined);
    rows.sort((a, b) =>
      this.sort === "recommended"
        ? (this.recommendation(a) ?? Infinity) - (this.recommendation(b) ?? Infinity) || b.updatedAt - a.updatedAt
        : this.sort === "popular"
          ? b.likeCount - a.likeCount || b.updatedAt - a.updatedAt
          : b.updatedAt - a.updatedAt,
    );
    const href = (r: CommunityChartItem) => communityChartPath(this.server, this.locale, r.id);
    const subtitle = (r: CommunityChartItem) => `${r.artist || r.ownerName} · ${r.charter || r.ownerName}`;
    const results =
      this.phase === "loading"
        ? loadingState(c("common.states.loading"))
        : this.phase === "error"
          ? errorState(this.error, c("common.actions.retry"), () => void this.load())
          : !rows.length
            ? emptyState({ title: this.t("empty"), icon: "music_note" })
            : this.view === "table"
              ? collectionTable(
                  this.t("title"),
                  [
                    this.t("chart"),
                    this.t("artist"),
                    this.t("charter"),
                    this.t("authorLevel"),
                    this.t("recommendedLevel"),
                    c("catalog.analysis.fields.metaN"),
                    this.t("likes"),
                  ],
                  rows.map((r) => [
                    html`
                      <a href=${href(r)}>${r.title}</a>
                    `,
                    r.artist,
                    r.charter || r.ownerName,
                    this.chartBadge(r),
                    this.recommendedLevel(r),
                    r.analysis?.n.toLocaleString(this.locale) ?? "—",
                    r.likeCount,
                  ]),
                )
              : this.view === "list"
                ? collectionList(
                    rows.map((r) => ({
                      id: r.id,
                      title: r.title,
                      subtitle: subtitle(r),
                      image: r.coverUrl,
                      trailing: this.chartBadge(r, true),
                      href: href(r),
                    })),
                  )
                : html`
                    <div class="collection">
                      ${rows.map((r) =>
                        tile({
                          ...songTile(
                            { ...r, jacketUrl: r.coverUrl },
                            {
                              locale: this.locale,
                              title: (item) => ({ text: String(item.title) }),
                              image: (item) => String(item.jacketUrl || ""),
                              artist: () => subtitle(r),
                              bandIcon: () => "",
                              imageForLocale: (source) => source,
                              attributeMark: () => "",
                              attributeLabel: () => "",
                            },
                            href(r),
                            [{ at: "bottom-start", text: `${this.t("recommendedLevel")} ${this.recommendedLevel(r)}` }],
                            { difficultyName: r.difficulty, displayLevel: r.level },
                          ),
                          aspectRatio: 1,
                        }),
                      )}
                    </div>
                  `;
    return renderBrowse({
      kind: "community-charts",
      count: { value: this.phase === "loading" ? null : rows.length, label: this.t("chartCount") },
      controls: html`
        ${viewSwitch(this.locale, this.view, (value) => {
          this.view = value;
        })}
        <a class="button button--tonal" href=${`/${this.locale}/chart-editor/create/`}>${this.t("create")}</a>
        <button
          class="button button--text"
          aria-pressed=${String(this.mine)}
          @click=${() => {
            this.mine = !this.mine;
            const url = new URL(location.href);
            if (this.mine) url.searchParams.set("scope", "mine");
            else url.searchParams.delete("scope");
            history.replaceState(history.state, "", url);
            void this.load();
          }}
        >
          ${this.t(this.mine ? "all" : "mine")}
        </button>
      `,
      applied: this.difficulties.map(
        (value) => html`
          <button
            class="chip"
            @click=${() => {
              this.difficulties = this.difficulties.filter((v) => v !== value);
            }}
          >
            ${value.toUpperCase()}${icon("close", 16)}
          </button>
        `,
      ),
      filters: {
        label: c("common.actions.filter"),
        open: this.filtersOpen,
        count: this.difficulties.length,
        closeLabel: c("common.actions.close"),
        resetLabel: c("common.actions.reset"),
        onOpen: () => {
          this.filtersOpen = true;
        },
        onClose: () => {
          this.filtersOpen = false;
        },
        onReset: () => {
          this.difficulties = [];
          this.sort = "new";
        },
        body: html`
          ${facet(
            this.t("difficulty"),
            this.locale,
            [...new Set(this.items.map((r) => r.difficulty))].map((value) => ({
              value,
              label: value.toUpperCase() || "—",
              count: this.items.filter((r) => r.difficulty === value).length,
            })),
            this.difficulties,
            (value) => {
              this.difficulties = this.difficulties.includes(value)
                ? this.difficulties.filter((v) => v !== value)
                : [...this.difficulties, value];
            },
          )}
          <md-outlined-select
            label=${this.t("sort")}
            .value=${this.sort}
            @change=${(e: Event) => {
              this.sort = (e.currentTarget as HTMLElement & { value: string }).value as typeof this.sort;
            }}
          >
            <md-select-option value="new" ?selected=${this.sort === "new"}><div slot="headline">${this.t("newest")}</div></md-select-option>
            <md-select-option value="popular" ?selected=${this.sort === "popular"}><div slot="headline">${this.t("popular")}</div></md-select-option>
            <md-select-option value="recommended" ?disabled=${!hasRecommendation} ?selected=${this.sort === "recommended"}>
              <div slot="headline">${this.t("recommendedLevel")}</div>
            </md-select-option>
          </md-outlined-select>
        `,
      },
      results,
    });
  }
}
if (!customElements.get("community-charts")) customElements.define("community-charts", CommunityCharts);
