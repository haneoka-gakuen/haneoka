// L3 — GEB
// Input: Local save files, native save snapshots and release-pinned catalogue data.
// Output: Persistent save collection, readable progress and confirmed Box handoff.
// Pos: [Map](L2-2.md); shared browser and native-shell save workspace.
// Effects/Dependencies: Local decoding Worker, IndexedDB, public catalogue reads and tab-local handoff.
import { viewSwitch, collectionList, collectionTable, type CollectionView } from "./ui/collection-view";
import { icon } from "./ui/icon";
import { importSaves } from "../lib/save-workspace/import";
import {
  loadSaveCatalog,
  saveEntity,
  saveLevel,
  object,
  text,
  type SaveCatalog,
  type Row,
} from "../lib/save-workspace/catalog";
import { LitElement, html, nothing, render } from "lit";
import { parseSnapshot, saveRecords, type StoredSave } from "../lib/save-workspace/snapshot";
import { appCall, appSupports, inApp, type DeviceSave } from "../lib/app-bridge";
import { downloadBlob } from "../lib/canvas-capture";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";

export class SaveWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    messages: { attribute: false },
    records: { state: true },
    selected: { state: true },
    busy: { state: true },
    error: { state: true },
    native: { state: true },
    catalog: { state: true },
    catalogError: { state: true },
    server: { state: true },
    view: { state: true },
  };
  declare locale: string;
  declare messages: Record<string, string>;
  declare records: StoredSave[];
  declare selected: string;
  declare busy: boolean;
  declare error: string;
  declare native: DeviceSave[];
  constructor() {
    super();
    this.view = "grid";
    this.server = "jp";
    this.locale = "zh-CN";
    this.messages = {};
    this.records = [];
    this.selected = "";
    this.busy = false;
    this.error = "";
    this.native = [];
  }
  declare view: CollectionView;
  declare catalog: SaveCatalog | undefined;
  declare catalogError: boolean;
  declare server: "jp" | "intl";
  private shellBack?: HTMLAnchorElement;
  private movedMenu?: { menu: HTMLElement; leading: HTMLElement; group: HTMLElement };
  private controller = new AbortController();
  private catalogController?: AbortController;
  private catalogServer = "";
  createRenderRoot() {
    return this;
  }
  private t(key: string) {
    return this.messages[key] ?? key;
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.messages = JSON.parse(this.dataset.messages ?? "{}");
    window.addEventListener("hashchange", this.route);
    window.addEventListener("haneoka-app-accounts", this.nativeChanged);
    void this.run(() => this.reload());
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.controller.abort();
    this.catalogController?.abort();
    window.removeEventListener("hashchange", this.route);
    window.removeEventListener("haneoka-app-accounts", this.nativeChanged);
    clearAppBarActions("save-workspace");
    this.restoreShell();
  }
  private route = () => {
    this.selected = location.hash.slice(1);
    const record = this.records.find((r) => r.id === this.selected);
    if (record) this.server = record.snapshot.server;
    if (record && record.snapshot.server !== this.catalogServer) void this.loadCatalog(record.snapshot.server);
  };
  private async loadCatalog(server: "jp" | "intl") {
    this.catalogController?.abort();
    const controller = (this.catalogController = new AbortController());
    this.catalogServer = server;
    this.catalog = undefined;
    this.catalogError = false;
    try {
      const result = await loadSaveCatalog(server, controller.signal);
      if (!controller.signal.aborted) this.catalog = result;
    } catch {
      if (!controller.signal.aborted) this.catalogError = true;
    }
  }

  private nativeChanged = () => {
    void this.run(() => this.reload());
  };
  private async reload() {
    this.records = (await saveRecords("list")).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    if (appSupports("saveSnapshotV1")) this.native = await appCall("gameAccounts", {});
    this.route();
  }
  private async run(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await action();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const name = error instanceof Error ? error.name : "Error";
      const key =
        code === "box_no_player" || code === "save_empty"
          ? "noSave"
          : code.includes("budget") || code === "save_too_large"
            ? "tooLarge"
            : code === "box_timeout"
              ? "timeout"
              : code === "save_worker_failed"
                ? "workerFailed"
                : code.startsWith("save_storage_")
                  ? "storageFailed"
                  : code === "save_file_unreadable" || name === "NotReadableError" || name === "NotFoundError"
                    ? "fileUnreadable"
                    : code === "save_invalid" || code.startsWith("box_invalid") || name === "SyntaxError"
                      ? "invalidFile"
                      : "failed";
      this.error = this.t(key);
      if (key === "failed")
        this.error += ` (${["SecurityError", "DataCloneError", "QuotaExceededError", "TypeError", "InvalidStateError"].includes(name) ? name : "Error"})`;
    } finally {
      this.busy = false;
    }
  }
  private async add(text: string, label: string) {
    const snapshot = parseSnapshot(text);
    const record: StoredSave = { id: crypto.randomUUID(), label, importedAt: new Date().toISOString(), snapshot };
    await saveRecords("put", record);
    await this.reload();
    location.hash = record.id;
  }
  private file = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length)
      void this.run(async () => {
        const values = await importSaves(files, this.server, this.controller.signal);
        for (const value of values) await this.add(JSON.stringify(value.snapshot), value.label);
      });
  };
  private importNative(save: DeviceSave) {
    void this.run(async () => {
      const result = await appCall("saveSnapshot", { key: save.key });
      await this.add(result.text, save.name ?? save.profileId);
    });
  }
  private export(record: StoredSave) {
    downloadBlob(
      new Blob([JSON.stringify(record.snapshot, null, 2)], { type: "application/json" }),
      `haneoka-save-${record.id}.json`,
    );
  }
  private team(record: StoredSave) {
    void this.run(async () => {
      sessionStorage.setItem(
        "haneoka:pending-save-box",
        JSON.stringify({ id: record.id, server: record.snapshot.server, text: JSON.stringify(record.snapshot) }),
      );
      location.assign(
        `/${this.locale}/team-builder/?server=${record.snapshot.server}&tab=box&saveImport=${encodeURIComponent(record.id)}`,
      );
    });
  }
  private removeSave(record: StoredSave) {
    const dialog = this.querySelector<HTMLDialogElement>("dialog");
    if (dialog) {
      dialog.dataset.id = record.id;
      dialog.showModal();
    }
  }
  private confirmRemove() {
    const dialog = this.querySelector<HTMLDialogElement>("dialog")!;
    const id = dialog.dataset.id!;
    dialog.close();
    void this.run(async () => {
      await saveRecords("delete", id);
      location.hash = "";
      await this.reload();
    });
  }

  private value(v: unknown) {
    return v === null || v === undefined
      ? this.t("unknown")
      : typeof v === "boolean"
        ? this.t(v ? "yes" : "no")
        : String(v);
  }
  private name(resource: string, id: unknown) {
    const row = saveEntity(this.catalog, resource, id);
    const name = text(
      row.prefix ?? row.musicTitle ?? row.musicName ?? row.characterName ?? row.itemName ?? row.name ?? row.title,
      this.locale,
    );
    return name || `${this.t("id")} ${this.value(id)}`;
  }
  private image(resource: string, id: unknown) {
    const row = saveEntity(this.catalog, resource, id);
    const images = object(row.images);
    const url = images.thumbnail ?? images.jacket ?? row.jacket;
    return typeof url === "string" && url.startsWith("/assets/")
      ? `${url}?release=${encodeURIComponent(this.catalog?.releaseId ?? "")}`
      : undefined;
  }
  private details(record: StoredSave) {
    return Object.entries(record.snapshot.player).map(([field, value]) => {
      const rows = Array.isArray(value) ? value.map(object) : [object(value)];
      if (field === "_memberCards" || field === "_supportCards") {
        const member = field === "_memberCards",
          resource = member ? "cards" : "support-cards";
        const columns = [
          "level",
          "experience",
          "rank",
          ...(member ? ["training", "liveSkill", "performanceSkill"] : []),
        ];
        const values = (row: Row) => [
          saveLevel(this.catalog, row, member),
          row._exp,
          row._rank,
          ...(member ? [row._awakeCount, row._liveSkillLevel, row._performanceSkillLevel] : []),
        ];
        const href = (row: Row) =>
          `/${record.snapshot.server}/${this.locale}/${member ? "member-cards" : resource}/${row._masterId}/`;
        return html`
          <section class="surface stack">
            <h2 class="detail-section-title">
              ${this.t(field)}
              <span class="chip">${rows.length}</span>
            </h2>
            ${
              this.view === "table"
                ? collectionTable(
                    this.t(field),
                    [this.t("name"), ...columns.map((k) => this.t(k))],
                    rows.map((row) => [
                      html`
                        <a href=${href(row)}>${this.name(resource, row._masterId)}</a>
                      `,
                      ...values(row).map((v) => this.value(v)),
                    ]),
                  )
                : this.view === "list"
                  ? collectionList(
                      rows.map((row) => ({
                        id: String(row._masterId),
                        title: this.name(resource, row._masterId),
                        href: href(row),
                        media: html`
                          <img
                            src=${this.image(resource, row._masterId) ?? nothing}
                            alt=""
                            loading="lazy"
                            width="64"
                            height="64"
                          />
                        `,
                        subtitle: columns.map((k, i) => `${this.t(k)} ${this.value(values(row)[i])}`).join(" · "),
                      })),
                    )
                  : html`
                      <div class="save-card-grid">
                        ${rows.map(
                          (row) => html`
                            <article class="save-card">
                              <a href=${href(row)}>
                                <span class="save-card-image">
                                  <img
                                    src=${this.image(resource, row._masterId) ?? nothing}
                                    loading="lazy"
                                    alt=""
                                    width="160"
                                    height="160"
                                  />
                                </span>
                                <strong>${this.name(resource, row._masterId)}</strong>
                              </a>
                              <dl class="spec-list">
                                ${columns.map(
                                  (key, i) => html`
                                    <div>
                                      <dt>${this.t(key)}</dt>
                                      <dd>${this.value(values(row)[i])}</dd>
                                    </div>
                                  `,
                                )}
                              </dl>
                            </article>
                          `,
                        )}
                      </div>
                    `
            }
          </section>
        `;
      }
      if (field === "_liveMusicResults") {
        const difficulties = ["easy", "normal", "hard", "expert"];
        const marks: Record<string, string> = {
          "0": this.t("notCleared"),
          "10": this.t("clear"),
          "20": this.t("fullCombo"),
          "30": this.t("allPerfect"),
        };
        return html`
          <section class="surface stack">
            <h2 class="detail-section-title">
              ${this.t(field)}
              <span class="chip">${rows.length}</span>
            </h2>
            ${collectionTable(
              this.t(field),
              [this.t("song"), ...difficulties.map((k) => k.toUpperCase())],
              rows.map((row) => {
                const id = row._mLiveMusicId ?? row._masterMusicId ?? row._masterId;
                return [
                  html`
                    <a href=${`/${record.snapshot.server}/${this.locale}/songs/${id}/`}>${this.name("songs", id)}</a>
                  `,
                  ...difficulties.map((k) => marks[String(row[`_${k}ClearedStatus`])] ?? this.t("unknown")),
                ];
              }),
            )}
          </section>
        `;
      }
      const config: Record<string, { resource: string; id: string; columns: string[] }> = {
        _items: { resource: "items", id: "_masterItemId", columns: ["_amount"] },
        _bandItems: { resource: "band-items", id: "_masterId", columns: ["_level"] },
        _characters: { resource: "characters", id: "_masterId", columns: ["_exp"] },
      };
      const c = config[field];
      if (c)
        return html`
          <section class="surface stack">
            <h2 class="detail-section-title">
              ${this.t(field)}
              <span class="chip">${rows.length}</span>
            </h2>
            ${collectionTable(
              this.t(field),
              [this.t("name"), ...c.columns.map((k) => this.t(k))],
              rows.map((row) => [
                html`
                  <a href=${`/${record.snapshot.server}/${this.locale}/${c.resource}/${row[c.id]}/`}>
                    ${this.name(c.resource, row[c.id])}
                  </a>
                `,
                ...c.columns.map((k) => this.value(row[k])),
              ]),
            )}
          </section>
        `;
      return html`
        <details class="surface">
          <summary>
            ${this.t(field)}
            <span class="chip">${Array.isArray(value) ? value.length : 1}</span>
          </summary>
          ${this.facts(value)}
        </details>
      `;
    });
  }
  private facts(value: unknown): unknown {
    if (Array.isArray(value))
      return html`
        <div class="stack">
          ${value.map(
            (v, i) => html`
              <section>
                <h3>${this.t("entry")} ${i + 1}</h3>
                ${this.facts(v)}
              </section>
            `,
          )}
        </div>
      `;
    if (value && typeof value === "object")
      return html`
        <dl class="spec-list">
          ${Object.entries(value).map(
            ([key, v]) => html`
              <div>
                <dt>${this.messages[key] ?? `${this.t("field")} ${key}`}</dt>
                <dd>${v && typeof v === "object" ? this.facts(v) : this.value(v)}</dd>
              </div>
            `,
          )}
        </dl>
      `;
    return html`
      <span>${this.value(value)}</span>
    `;
  }
  private restoreShell() {
    this.shellBack?.remove();
    this.shellBack = undefined;
    if (this.movedMenu) {
      this.movedMenu.leading.append(this.movedMenu.menu);
      this.movedMenu.group.remove();
      this.movedMenu = undefined;
    }
  }
  private syncShell() {
    const record = this.records.find((r) => r.id === this.selected);
    const heading = document.querySelector<HTMLElement>("[data-top-app-bar] h1");
    if (heading) heading.textContent = record?.label ?? this.t("title");
    if (!record) {
      this.restoreShell();
      return;
    }
    const leading = document.querySelector<HTMLElement>("[data-top-app-bar-leading]");
    if (leading && !this.shellBack) {
      const back = document.createElement("a");
      back.href = "#";
      back.className = "icon-button";
      back.dataset.entityBack = "";
      back.setAttribute("aria-label", this.t("back"));
      render(icon("arrow_back"), back);
      leading.prepend(back);
      this.shellBack = back;
      const menu = leading.querySelector<HTMLElement>("[data-nav-toggle]");
      const actions = document.querySelector<HTMLElement>("[data-top-app-bar-actions]");
      if (menu && actions) {
        const group = document.createElement("div");
        group.className = "top-app-bar__group";
        group.append(menu);
        actions.prepend(group);
        this.movedMenu = { menu, leading, group };
      }
    }
  }
  protected updated() {
    this.syncShell();
    setAppBarActions(
      "save-workspace",
      html`
        ${
          this.selected
            ? viewSwitch(this.locale, this.view, (view) => {
                this.view = view;
              })
            : nothing
        }
        <button
          class="button button--tonal"
          ?disabled=${this.busy}
          @click=${() => this.querySelector<HTMLInputElement>("input[type=file]")?.click()}
        >
          ${this.t("import")}
        </button>
      `,
    );
  }
  render() {
    const record = this.records.find((v) => v.id === this.selected);
    return html`
      <input type="file" multiple hidden @change=${this.file} />
      <div class="save-workspace stack" aria-busy=${this.busy}>
        <div class="save-status" role="status">${this.busy ? this.t("loading") : this.error || ""}</div>
        ${
          record
            ? html`
                <section class="surface stack">
                  <dl class="spec-list">
                    <div>
                      <dt>${this.t("server")}</dt>
                      <dd>${record.snapshot.server.toUpperCase()}</dd>
                    </div>
                    <div>
                      <dt>${this.t("saved")}</dt>
                      <dd>
                        ${record.snapshot.savedAt ? new Date(record.snapshot.savedAt).toLocaleString(this.locale) : this.t("unknown")}
                      </dd>
                    </div>
                  </dl>
                  <div class="cluster">
                    <button class="button button--filled" ?disabled=${this.busy} @click=${() => this.team(record)}>
                      ${this.t("team")}
                    </button>
                    <button class="button button--tonal" @click=${() => this.export(record)}>
                      ${this.t("export")}
                    </button>
                    <button class="button button--text" @click=${() => this.removeSave(record)}>
                      ${this.t("delete")}
                    </button>
                  </div>
                </section>
                ${
                  this.catalogError
                    ? html`
                        <button
                          class="button button--tonal"
                          @click=${() => void this.loadCatalog(record.snapshot.server)}
                        >
                          ${this.t("catalogRetry")}
                        </button>
                      `
                    : nothing
                }
                ${this.details(record)}
              `
            : html`
                <section class="surface stack">
                  <h2 class="detail-section-title">${this.t("local")}</h2>
                  <label>
                    ${this.t("server")}
                    <select
                      .value=${this.server}
                      @change=${(event: Event) => {
                        this.server = (event.target as HTMLSelectElement).value as "jp" | "intl";
                      }}
                    >
                      <option value="jp">JP</option>
                      <option value="intl">INTL</option>
                    </select>
                  </label>
                  ${
                    this.records.length
                      ? html`
                          <ul class="detail-object-list">
                            ${this.records.map(
                              (row) => html`
                                <li>
                                  <a class="detail-object" href=${`#${row.id}`}>
                                    <span>
                                      ${row.label}
                                      <small>
                                        ${row.snapshot.server.toUpperCase()} ·
                                        ${new Date(row.importedAt).toLocaleString(this.locale)}
                                      </small>
                                    </span>
                                  </a>
                                </li>
                              `,
                            )}
                          </ul>
                        `
                      : html`
                          <p>${this.t("empty")}</p>
                        `
                  }
                </section>
                ${
                  this.native.length
                    ? html`
                        <section class="surface stack">
                          <h2 class="detail-section-title">${this.t("native")}</h2>
                          ${this.native.map(
                            (save) => html`
                              <button
                                class="button button--tonal"
                                ?disabled=${this.busy}
                                @click=${() => this.importNative(save)}
                              >
                                ${save.name ?? save.profileId}
                              </button>
                            `,
                          )}
                        </section>
                      `
                    : nothing
                }
                ${
                  inApp()
                    ? html`
                        <button class="button button--tonal" @click=${() => void appCall("addGameAccount", {})}>
                          ${this.t("read")}
                        </button>
                      `
                    : nothing
                }
              `
        }
      </div>
      <dialog class="dialog">
        <h2 class="detail-section-title">${this.t("delete")}</h2>
        <div class="cluster">
          <button class="button" @click=${() => this.querySelector("dialog")?.close()}>${this.t("cancel")}</button>
          <button class="button button--filled" @click=${() => this.confirmRemove()}>${this.t("confirm")}</button>
        </div>
      </dialog>
    `;
  }
}
customElements.define("save-workspace", SaveWorkspace);
