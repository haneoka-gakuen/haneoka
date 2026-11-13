// L3 — GEB
// Input: 当前编辑工程、音频、本地发布配置及素材选择。
// Output: 素材管理、云端草稿、私有／公开详情入口和发布／撤回对话框。
// Pos: [Map](L2-2.md)；谱面编辑器的社区发布入口。
// Effects/Dependencies: IndexedDB、社区上传／发布 HTTP、服务器素材选择；断开取消在途请求。
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { clientText } from "../i18n/client";
import { modal } from "./ui/modal";
import { icon } from "./ui/icon";
import { returnLink } from "../lib/document-url";
import { snackbar } from "../lib/snackbar";
import { communityChartPath, type ChartMediaRef, type CommunityChartItem } from "../lib/chart-creation/community-types";
import {
  CHART_API,
  ChartRequestError,
  chartRequest,
  readChartCloudDraft,
  saveChartCloudDraft,
  chartPublicationSeed,
  uploadChartAudio,
  uploadChartCover,
  type ChartCloudDraft,
} from "../lib/chart-creation/community";
import type { Project } from "../../packages/chart-editor/src/model";
import { sha256Blob, type CreationAudio } from "../lib/chart-creation/audio";
import type { ChartCreationLibrary, CreationLibraryProvider, CreationMediaSelection } from "./chart-creation-library";
import { readReleaseServer } from "../lib/release-server";

export class ChartPublication extends LitElement {
  static properties = {
    locale: {},
    projectId: {},
    project: { attribute: false },
    audio: { attribute: false },
    opened: { state: true },
    busy: { state: true },
    draft: { state: true },
    error: { state: true },
    progress: { state: true },
    published: { state: true },
    initialized: { state: true },
  };
  declare locale: string;
  declare projectId: string;
  declare project: Project;
  declare audio: CreationAudio | undefined;
  declare private opened: boolean;
  declare private busy: boolean;
  declare private draft: ChartCloudDraft;
  declare private error: string;
  declare private progress: number;
  declare private published: CommunityChartItem | undefined;
  declare private initialized: boolean;
  onSave?: () => Promise<void>;
  onAudio?: (file: File, signal: AbortSignal) => Promise<CreationAudio>;
  private controller?: AbortController;
  private coverUrl = "";
  private generation = 0;
  constructor() {
    super();
    this.locale = "en";
    this.projectId = "";
    this.opened = false;
    this.busy = false;
    this.draft = chartPublicationSeed({ extensions: {} } as Project);
    this.error = "";
    this.progress = 0;
    this.initialized = false;
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
  protected override updated(changed: PropertyValues) {
    if (changed.has("projectId")) {
      this.controller?.abort();
      this.busy = false;
      this.published = undefined;
      this.initialized = false;
      const id = this.projectId,
        generation = ++this.generation;
      if (id)
        void readChartCloudDraft(id)
          .then((draft) => {
            if (generation !== this.generation || !this.isConnected) return;
            this.draft = draft ?? chartPublicationSeed(this.project, this.audio);
            this.initialized = true;
            this.refreshCover();
          })
          .catch(() => {
            if (generation === this.generation) this.error = this.t("errors.storage_failed");
          });
    }
    if (changed.has("audio") && this.initialized && this.draft.audioSha && this.draft.audioSha !== this.audio?.sha256) {
      this.draft = { ...this.draft, audio: null, audioSha: this.audio?.sha256 };
      void this.persist();
    }
  }
  override disconnectedCallback() {
    this.controller?.abort();
    ++this.generation;
    if (this.coverUrl.startsWith("blob:")) URL.revokeObjectURL(this.coverUrl);
    super.disconnectedCallback();
  }
  private async persist() {
    await saveChartCloudDraft(this.projectId, structuredClone(this.draft));
  }
  async show() {
    this.error = "";
    this.opened = true;
    if (this.draft.id && this.draft.version) await this.refresh();
  }
  private refreshCover() {
    if (this.coverUrl.startsWith("blob:")) URL.revokeObjectURL(this.coverUrl);
    this.coverUrl = this.draft.coverFile ? URL.createObjectURL(this.draft.coverFile) : (this.published?.coverUrl ?? "");
    this.requestUpdate();
  }
  private async refresh() {
    const id = this.draft.id;
    try {
      const { chart } = await chartRequest<{ chart: CommunityChartItem }>(`${CHART_API}/${id}?draft=1`);
      if (!this.isConnected || this.draft.id !== id) return;
      if (!chart.canEdit) {
        this.error = this.t("errors.account_changed");
        return;
      }
      this.published = chart;
      this.refreshCover();
      if (chart.version !== this.draft.version) this.error = this.t("errors.save_conflict");
    } catch (error) {
      this.error = this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`);
    }
  }
  private async updateDraft(patch: Partial<ChartCloudDraft>) {
    this.draft = { ...this.draft, ...patch };
    try {
      await this.persist();
    } catch {
      this.error = this.t("errors.storage_failed");
    }
  }
  private pickMedia(provider: CreationLibraryProvider, kind: "audio" | "cover") {
    const library =
      this.closest("chart-creation-workspace")?.querySelector<ChartCreationLibrary>("chart-creation-library");
    if (!library) return;
    library.onChooseMedia = async (value: CreationMediaSelection, signal: AbortSignal) => {
      if (kind === "audio") {
        const response = await fetch(value.url, { signal });
        if (!response.ok) throw new Error("media_missing");
        const blob = await response.blob();
        const audio = await this.onAudio?.(new File([blob], `${value.title}.audio`, { type: blob.type }), signal);
        if (!audio) throw new Error("media_missing");
        await this.updateDraft({ audio: { ...value.ref, sha256: audio.sha256 }, audioSha: audio.sha256 });
      } else {
        const response = await fetch(value.url, { signal });
        if (!response.ok) throw new Error("media_missing");
        const sha256 = await sha256Blob(await response.blob());
        signal.throwIfAborted();
        await this.updateDraft({ cover: { ...value.ref, sha256 }, coverFile: undefined, coverIntent: undefined });
        if (this.coverUrl.startsWith("blob:")) URL.revokeObjectURL(this.coverUrl);
        this.coverUrl = value.url;
        this.requestUpdate();
      }
    };
    void library.show(provider, kind);
  }
  private async chooseCover(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      this.error = this.t("errors.cover_format");
      return;
    }
    await this.updateDraft({ coverFile: file, cover: null, coverIntent: undefined });
    this.refreshCover();
  }
  private async save(publish: boolean) {
    if (this.busy || !this.initialized || !this.audio) return;
    this.busy = true;
    this.error = "";
    this.progress = 0;
    const controller = (this.controller = new AbortController()),
      signal = controller.signal,
      id = this.projectId;
    try {
      await this.onSave?.();
      signal.throwIfAborted();
      const project = structuredClone(this.project),
        audio = this.audio;
      const session = await chartRequest<{ user?: { id: string; emailVerified: boolean } } | null>(
        "/api/auth/get-session",
        { signal },
      );
      if (!session?.user) throw new Error("authentication_required");
      if (!session.user.emailVerified) throw new Error("email_verification_required");
      if (this.draft.ownerId && this.draft.ownerId !== session.user.id) throw new Error("account_changed");
      this.draft = {
        ...this.draft,
        id: this.draft.id ?? crypto.randomUUID(),
        version: this.draft.version ?? 0,
        ownerId: session.user.id,
      };
      await this.persist();
      if (this.draft.pendingSave) {
        const recovered = await chartRequest<{ chart: CommunityChartItem }>(`${CHART_API}/${this.draft.id}`, {
          method: "PUT",
          signal,
          body: this.draft.pendingSave.body,
        });
        this.draft = {
          ...this.draft,
          version: recovered.chart.version,
          revision: recovered.chart.revision,
          pendingSave: undefined,
        };
        this.published = recovered.chart;
        await this.persist();
      }
      if (!this.draft.audio || this.draft.audioSha !== audio.sha256) {
        const assetId = await uploadChartAudio(audio.file, signal, (value) => {
          this.progress = value;
        });
        this.draft = { ...this.draft, audio: { kind: "upload", id: assetId }, audioSha: audio.sha256 };
        await this.persist();
      }
      if (this.draft.coverFile && !this.draft.cover) {
        try {
          const assetId = await uploadChartCover(
            this.draft,
            signal,
            () => this.persist(),
            (value) => {
              this.progress = value;
            },
          );
          this.draft = { ...this.draft, cover: { kind: "upload", id: assetId } };
          await this.persist();
        } catch (error) {
          if (publish || signal.aborted) throw error;
          this.error = this.t("errors.media_not_ready");
        }
      }
      if (publish && !this.draft.cover) throw new Error("media_missing");
      const saveBody = JSON.stringify({
        ...this.draft,
        pendingSave: undefined,
        coverFile: undefined,
        coverIntent: undefined,
        requestId: crypto.randomUUID(),
        project,
        publish,
      });
      this.draft = { ...this.draft, pendingSave: { body: saveBody } };
      await this.persist();
      const { chart } = await chartRequest<{ chart: CommunityChartItem }>(`${CHART_API}/${this.draft.id}`, {
        method: "PUT",
        signal,
        body: saveBody,
      });
      signal.throwIfAborted();
      if (id !== this.projectId) return;
      this.published = chart;
      this.draft = { ...this.draft, version: chart.version, revision: chart.revision, pendingSave: undefined };
      await this.persist();
      this.refreshCover();
      snackbar(this.t(publish ? "published" : "draftSaved"));
    } catch (error) {
      if (error instanceof ChartRequestError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        this.draft = { ...this.draft, pendingSave: undefined };
        await this.persist();
      }
      if (!signal.aborted)
        this.error = this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`);
    } finally {
      if (this.controller === controller) {
        this.busy = false;
        this.controller = undefined;
      }
    }
  }
  private async unpublish() {
    if (!this.draft.id || this.busy) return;
    this.busy = true;
    try {
      const result = await chartRequest<{ version: number }>(`${CHART_API}/${this.draft.id}/unpublish`, {
        method: "POST",
        body: JSON.stringify({ version: this.draft.version }),
      });
      this.draft = { ...this.draft, version: result.version };
      await this.persist();
      await this.refresh();
      snackbar(this.t("withdrawn"));
    } catch (error) {
      this.error = this.t(`errors.${error instanceof Error ? error.message : "service_unavailable"}`);
    } finally {
      this.busy = false;
    }
  }
  private sourceLabel(ref: ChartMediaRef | null, local = "") {
    return ref?.kind === "server"
      ? `${ref.provider === "our-notes" ? "Our Notes" : "Bestdori"} / ${ref.server} / ${ref.songId}`
      : local || this.t("localUpload");
  }
  render() {
    if (!this.opened) return nothing;
    const c = (key: string) => clientText(this.locale, key),
      draft = this.draft;
    return html`
      <dialog
        class="dialog chart-publication"
        aria-label=${this.t("publish")}
        ${modal(() => {
          if (!this.busy) this.opened = false;
        })}
      >
        <header class="dialog__header"><h2>${this.t("publish")}</h2></header>
        <div class="dialog__body">
          <div class="stack">
            <fieldset class="stack" ?disabled=${this.busy || !this.initialized}>
              <section class="surface stack">
                <h3 class="detail-section-title">${icon("library_music")}${this.t("audio")}</h3>
                <span>${this.sourceLabel(draft.audio, this.audio?.file.name)}</span>
                <div class="cluster">
                  <button
                    class="button button--tonal"
                    ?disabled=${!this.audio}
                    @click=${() => void this.updateDraft({ audio: null, audioSha: undefined })}
                  >
                    ${this.t("localUpload")}
                  </button>
                  <button class="button button--tonal" @click=${() => this.pickMedia("haneoka", "audio")}>
                    Our Notes
                  </button>
                  <button class="button button--tonal" @click=${() => this.pickMedia("bestdori", "audio")}>
                    Bestdori
                  </button>
                </div>
              </section>
              <section class="surface stack">
                <h3 class="detail-section-title">${icon("image")}${this.t("cover")}</h3>
                ${
                  this.coverUrl
                    ? html`
                        <img class="chart-publication__cover" src=${this.coverUrl} width="192" height="192" alt="" />
                      `
                    : nothing
                }
                <span>
                  ${draft.coverFile?.name || (draft.cover ? this.sourceLabel(draft.cover) : this.t("selectCover"))}
                </span>
                <div class="cluster">
                  <button
                    class="button button--tonal"
                    @click=${() => this.querySelector<HTMLInputElement>("[data-cover]")?.click()}
                  >
                    ${this.t("uploadCover")}
                  </button>
                  <button class="button button--tonal" @click=${() => this.pickMedia("haneoka", "cover")}>
                    Our Notes
                  </button>
                  <button class="button button--tonal" @click=${() => this.pickMedia("bestdori", "cover")}>
                    Bestdori
                  </button>
                </div>
                <input
                  hidden
                  data-cover
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  @change=${(e: Event) => void this.chooseCover(e)}
                />
              </section>
              <label class="stack">
                <span>${this.t("summary")}</span>
                <span class="field">
                  <textarea
                    rows="3"
                    maxlength="1000"
                    .value=${live(draft.summary)}
                    @change=${(e: Event) => void this.updateDraft({ summary: (e.target as HTMLTextAreaElement).value })}
                  ></textarea>
                </span>
              </label>
              <label class="stack">
                <span>${this.t("visibility")}</span>
                <span class="field">
                  <select
                    .value=${draft.visibility}
                    @change=${(e: Event) => void this.updateDraft({ visibility: (e.target as HTMLSelectElement).value as ChartCloudDraft["visibility"] })}
                  >
                    <option value="public">${this.t("public")}</option>
                    <option value="unlisted">${this.t("unlisted")}</option>
                  </select>
                </span>
              </label>
              <label class="stack">
                <span>${this.t("remix")}</span>
                <span class="field">
                  <select
                    .value=${draft.remix ? "yes" : "no"}
                    @change=${(e: Event) => void this.updateDraft({ remix: (e.target as HTMLSelectElement).value === "yes" })}
                  >
                    <option value="yes">${this.t("remixAllowed")}</option>
                    <option value="no">${this.t("remixClosed")}</option>
                  </select>
                </span>
              </label>
            </fieldset>
            ${
              this.error
                ? html`
                    <p role="alert">${this.error}</p>
                    ${
                      this.error === this.t("errors.authentication_required")
                        ? html`
                            <a
                              class="button"
                              href=${returnLink(`/${this.locale}/account/`, location.pathname + location.search)}
                            >
                              ${this.t("signIn")}
                            </a>
                          `
                        : nothing
                    }
                  `
                : nothing
            }
            ${
              this.busy
                ? html`
                    <progress max="1" .value=${this.progress} aria-label=${this.t("uploading")}></progress>
                  `
                : nothing
            }
            ${
              this.published
                ? html`
                    <div class="cluster">
                      <a
                        class="button button--tonal"
                        href=${communityChartPath(readReleaseServer(), this.locale, this.published.id)}
                      >
                        ${this.t("viewChart")}
                      </a>
                      ${
                        this.published.publishedRevision
                          ? html`
                              <button
                                class="button button--text"
                                ?disabled=${this.busy}
                                @click=${() => void this.unpublish()}
                              >
                                ${this.t("unpublish")}
                              </button>
                            `
                          : nothing
                      }
                    </div>
                  `
                : nothing
            }
          </div>
        </div>
        <div class="dialog__actions">
          <button
            class="button button--text"
            @click=${() => {
              if (this.busy) this.controller?.abort();
              else this.opened = false;
            }}
          >
            ${c("common.actions.cancel")}
          </button>
          <button
            class="button button--tonal"
            ?disabled=${this.busy || !this.initialized}
            @click=${() => void this.save(false)}
          >
            ${this.t("saveDraft")}
          </button>
          <button
            class="button button--filled"
            ?disabled=${this.busy || !this.initialized}
            @click=${() => void this.save(true)}
          >
            ${this.published?.publishedRevision ? this.t("update") : this.t("publish")}
          </button>
        </div>
      </dialog>
    `;
  }
}
if (!customElements.get("chart-publication")) customElements.define("chart-publication", ChartPublication);
