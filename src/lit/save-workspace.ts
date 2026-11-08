// L3 — GEB
// Input: Local save files, native save snapshots and release-pinned catalogue data.
// Output: Persistent save collection, readable progress and confirmed Box handoff.
// Pos: [Map](L2-2.md); shared browser and native-shell save workspace.
// Effects/Dependencies: Local decoding Worker, IndexedDB, public catalogue reads, tab-local handoff and the app's save sources (saveSourcesV1).
import { viewSwitch, collectionList, collectionTable, type CollectionView } from "./ui/collection-view";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { LazyImages, nextImageCandidate } from "./ui/lazy-images";
import { accordion } from "./ui/accordion";
import { snackbar, dismissSnackbar } from "../lib/snackbar";
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
import { parseSnapshot, saveRecords, type SaveSnapshot, type StoredSave } from "../lib/save-workspace/snapshot";
import {
  appCall,
  appSupports,
  inApp,
  type AdbDevice,
  type DeviceSave,
  type IosBackup,
  type SaveRead,
  type SaveSource,
} from "../lib/app-bridge";
import { modal } from "./ui/modal";
import { downloadBlob } from "../lib/canvas-capture";
import { formatDate } from "../lib/date-format";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";

export class SaveWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    messages: { attribute: false },
    records: { state: true },
    selected: { state: true },
    busy: { state: true },
    expanded: { state: true },
    native: { state: true },
    sources: { state: true },
    sheet: { state: true },
    devices: { state: true },
    backups: { state: true },
    locked: { state: true },
    removing: { state: true },
    catalog: { state: true },
    server: { state: true },
    view: { state: true },
  };
  declare locale: string;
  declare messages: Record<string, string>;
  declare records: StoredSave[];
  declare selected: string;
  declare busy: boolean;
  declare expanded: ReadonlySet<string>;
  declare native: DeviceSave[];
  /** Where the app can read game saves (`saveSourcesV1`). */
  declare sources: SaveSource[];
  declare releases: string[];
  declare sheet: "adb" | "iosBackup" | "gameFolder" | null;
  declare devices: AdbDevice[] | null;
  declare backups: IosBackup[] | null;
  /** An encrypted backup waiting for its password. */
  declare locked: IosBackup | null;
  declare removing: string | null;
  constructor() {
    super();
    this.view = "grid";
    this.server = "jp";
    this.locale = "zh-CN";
    this.messages = {};
    this.records = [];
    this.selected = "";
    this.busy = false;
    this.expanded = new Set();
    this.native = [];
    this.sources = [];
    this.releases = [];
    this.sheet = null;
    this.devices = null;
    this.backups = null;
    this.locked = null;
    this.removing = null;
  }
  declare view: CollectionView;
  declare catalog: SaveCatalog | undefined;
  declare server: "jp" | "intl";
  private shellBack?: HTMLAnchorElement;
  private movedMenu?: { menu: HTMLElement; leading: HTMLElement; group: HTMLElement };
  private controller = new AbortController();
  private lazyImages = new LazyImages();
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
    this.lazyImages.disconnect();
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
    try {
      const result = await loadSaveCatalog(server, controller.signal);
      if (!controller.signal.aborted) this.catalog = result;
    } catch {
      if (!controller.signal.aborted)
        snackbar(this.t("catalogFailed"), {
          error: true,
          durationMs: 0,
          action: { label: this.t("catalogRetry"), run: () => void this.loadCatalog(server) },
        });
    }
  }

  private nativeChanged = () => {
    void this.run(() => this.reload());
  };
  private async reload() {
    this.records = (await saveRecords("list")).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    if (appSupports("saveSnapshotV1")) this.native = await appCall("gameAccounts", {});
    if (appSupports("saveSourcesV1") && !this.sources.length) {
      const available = await appCall("saveSources", {});
      this.sources = available.sources;
      this.releases = available.releases;
    }
    this.route();
  }
  private async run(action: () => Promise<void>, progress = false) {
    if (this.busy) return;
    this.busy = true;
    const pending = progress ? snackbar(this.t("loading"), { durationMs: 0 }) : 0;
    try {
      await action();
    } catch (error) {
      const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
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
                      : code === "adb_missing"
                        ? "adbMissing"
                        : code === "adb_access_denied"
                          ? "accessDenied"
                          : code === "backup_password"
                            ? "wrongPassword"
                            : "failed";
      snackbar(this.t(key), { error: true });
      return;
    } finally {
      this.busy = false;
    }
    if (pending) dismissSnackbar(pending);
  }
  private async add(snapshot: SaveSnapshot, label: string) {
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
        for (const value of values) await this.add(value.snapshot, value.label);
      }, true);
  };
  private importNative(save: DeviceSave) {
    void this.run(async () => {
      const result = await appCall("saveSnapshot", { key: save.key });
      await this.add(parseSnapshot(result.text), save.name ?? save.profileId);
    }, true);
  }
  private export(record: StoredSave) {
    downloadBlob(
      new Blob([JSON.stringify(record.snapshot, null, 2)], { type: "application/json" }),
      `haneoka-save-${record.id}.json`,
    );
  }
  private team(record: StoredSave) {
    void this.run(async () => {
      const { player, ...snapshot } = record.snapshot;
      const box = Object.fromEntries(
        ["_memberCards", "_supportCards", "_characters", "_bandItems"].flatMap((key) =>
          player[key] === undefined ? [] : [[key, player[key]]],
        ),
      );
      sessionStorage.setItem(
        "haneoka:pending-save-box",
        JSON.stringify({ id: record.id, server: snapshot.server, text: JSON.stringify({ ...snapshot, player: box }) }),
      );
      location.assign(
        `/${this.locale}/team-builder/?server=${snapshot.server}&tab=box&saveImport=${encodeURIComponent(record.id)}`,
      );
    });
  }
  private removeSave(record: StoredSave) {
    this.removing = record.id;
  }
  private confirmRemove() {
    const id = this.removing;
    this.removing = null;
    if (!id) return;
    void this.run(async () => {
      await saveRecords("delete", id);
      location.hash = "";
      await this.reload();
    });
  }

  /** Saves the app read; the list follows `haneoka-app-accounts`. */
  private read(request: () => Promise<SaveRead | null>) {
    void this.run(async () => {
      const result = await request();
      if (!result) return;
      this.sheet = null;
      this.locked = null;
      snackbar(
        result.keys.length ? this.t("readCount").replace("{count}", String(result.keys.length)) : this.t("noSave"),
      );
      this.native = await appCall("gameAccounts", {});
    }, true);
  }
  private source(source: SaveSource) {
    if (source === "files") this.read(() => appCall("readFiles", {}));
    else if (source === "folder") this.read(() => appCall("readFiles", { folder: true }));
    else if (source === "shizuku")
      this.read(async () => {
        let { status, installed } = await appCall("deviceStatus", {});
        if (status === "needsPermission") status = (await appCall("shizukuRequest", {})).granted ? "ready" : status;
        if (status === "ready") return appCall("shizukuRead", {});
        if (status === "notRunning" && installed) await appCall("openShizuku", {});
        else snackbar(this.t("shizukuMissing"), { error: true });
        return null;
      });
    else if (source === "gameFolder")
      this.read(async () => {
        const granted = await appCall("gameFolder", {});
        if (granted?.keys.length) return granted;
        this.sheet = "gameFolder";
        return null;
      });
    else if (source === "adb") {
      this.sheet = "adb";
      this.devices = null;
      void this.run(async () => {
        this.devices = await appCall("adbDevices", {});
      });
    } else if (source === "iosBackup") this.loadBackups(false);
  }
  private loadBackups(pick: boolean) {
    this.sheet = "iosBackup";
    if (!pick) this.backups = null;
    void this.run(async () => {
      const found = await appCall("iosBackups", { pick });
      if (found)
        this.backups = pick
          ? [...found, ...(this.backups ?? []).filter((b) => !found.some((f) => f.path === b.path))]
          : found;
    });
  }
  private releaseName(release: string) {
    return this.t(`release_${release.replaceAll(".", "_")}`);
  }
  private sourceIcon(source: SaveSource) {
    return {
      files: icon("description", 24),
      folder: icon("folder_open", 24),
      adb: icon("usb", 24),
      iosBackup: icon("phone_iphone", 24),
      shizuku: icon("smartphone", 24),
      gameFolder: icon("folder_open", 24),
    }[source];
  }
  private renderSheet() {
    const close = () => {
      this.sheet = null;
      this.locked = null;
    };
    const form = (event: Event) => {
      event.preventDefault();
      return new FormData(event.target as HTMLFormElement);
    };
    let title = "";
    let body: unknown = nothing;
    if (this.sheet === "gameFolder") {
      title = this.t("source_gameFolder");
      body = html`
        <ul class="detail-object-list" role="list">
          ${this.releases.map(
            (release) => html`
              <li>
                <button
                  class="detail-object"
                  type="button"
                  ?disabled=${this.busy}
                  @click=${() => this.read(() => appCall("gameFolder", { release }))}
                >
                  <span>${this.releaseName(release)}</span>
                </button>
              </li>
            `,
          )}
        </ul>
      `;
    } else if (this.sheet === "adb") {
      title = this.t("source_adb");
      body = html`
        <div class="stack">
          ${
            this.devices === null
              ? html`
                  <p>${this.t("loading")}</p>
                `
              : this.devices.length
                ? html`
                    <ul class="detail-object-list" role="list">
                      ${this.devices.map(
                        (device) => html`
                          <li>
                            <button
                              class="detail-object"
                              type="button"
                              ?disabled=${this.busy || device.state !== "device"}
                              @click=${() => this.read(() => appCall("adbRead", { serial: device.serial }))}
                            >
                              <span>
                                ${device.model?.replaceAll("_", " ") || device.serial}
                                <small class="md-body-small">
                                  ${
                                    device.state === "device"
                                      ? device.releases.map((r) => this.releaseName(r)).join(" / ") || this.t("noSave")
                                      : this.t("unauthorized")
                                  }
                                </small>
                              </span>
                            </button>
                          </li>
                        `,
                      )}
                    </ul>
                  `
                : html`
                    <p>${this.t("noDevices")}</p>
                  `
          }
          <form
            class="stack"
            @submit=${(event: Event) => {
              const data = form(event);
              const address = String(data.get("address") ?? "").trim();
              const code = String(data.get("code") ?? "").trim();
              void this.run(async () => {
                if (code) await appCall("adbPair", { address, code });
                else await appCall("adbConnect", { address });
                this.devices = await appCall("adbDevices", {});
              });
            }}
          >
            <label>
              <span>${this.t("address")}</span>
              <span class="field">
                <input name="address" required inputmode="url" autocomplete="off" placeholder="192.168.1.2:37000" />
              </span>
            </label>
            <label>
              <span>${this.t("pairingCode")}</span>
              <span class="field"><input name="code" inputmode="numeric" autocomplete="one-time-code" /></span>
            </label>
            <button class="button button--tonal" type="submit" ?disabled=${this.busy}>${this.t("connect")}</button>
          </form>
        </div>
      `;
    } else if (this.sheet === "iosBackup") {
      title = this.t("source_iosBackup");
      const locked = this.locked;
      body = locked
        ? html`
            <form
              class="stack"
              id="backup-password"
              @submit=${(event: Event) => {
                const password = String(form(event).get("password") ?? "");
                this.read(() => appCall("iosBackupRead", { path: locked.path, password }));
              }}
            >
              <p>${locked.deviceName ?? locked.path}</p>
              <label>
                <span>${this.t("password")}</span>
                <span class="field"><input name="password" type="password" required autocomplete="off" /></span>
              </label>
            </form>
          `
        : html`
            <div class="stack">
              ${
                this.backups === null
                  ? html`
                      <p>${this.t("loading")}</p>
                    `
                  : this.backups.length
                    ? html`
                        <ul class="detail-object-list" role="list">
                          ${this.backups.map(
                            (backup) => html`
                              <li>
                                <button
                                  class="detail-object"
                                  type="button"
                                  ?disabled=${this.busy}
                                  @click=${() =>
                                    backup.encrypted
                                      ? (this.locked = backup)
                                      : this.read(() => appCall("iosBackupRead", { path: backup.path }))}
                                >
                                  <span>
                                    ${backup.deviceName ?? backup.productType ?? backup.path}
                                    <small class="md-body-small">
                                      ${[
                                        backup.productType ?? "",
                                        backup.date === null ? "" : formatDate(this.locale, backup.date),
                                      ]
                                        .filter(Boolean)
                                        .join(" / ")}
                                    </small>
                                  </span>
                                </button>
                              </li>
                            `,
                          )}
                        </ul>
                      `
                    : html`
                        <p>${this.t("noBackups")}</p>
                      `
              }
              <button
                class="button button--tonal"
                type="button"
                ?disabled=${this.busy}
                @click=${() => this.loadBackups(true)}
              >
                ${this.t("chooseFolder")}
              </button>
            </div>
          `;
    }
    return html`
      <dialog class="dialog" ${modal(close)}>
        <div class="dialog__surface">
          <header class="dialog__header"><h2>${title}</h2></header>
          <div class="dialog__body">${body}</div>
          <footer class="dialog__actions">
            <button class="button button--text" type="button" @click=${close}>${this.t("close")}</button>
            ${
              this.locked
                ? html`
                    <button class="button button--filled" type="submit" form="backup-password" ?disabled=${this.busy}>
                      ${this.t("readBackup")}
                    </button>
                  `
                : nothing
            }
          </footer>
        </div>
      </dialog>
    `;
  }
  private serverName(server: string) {
    return this.t(`servers.${server}`);
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
                        subtitle: columns.map((k, i) => `${this.t(k)} ${this.value(values(row)[i])}`).join(" / "),
                      })),
                    )
                  : html`
                      <div class="collection">
                        ${rows.map((row) => {
                          const level = values(row)[0];
                          return tile({
                            kind: member ? "member" : "support",
                            title: this.name(resource, row._masterId),
                            subtitle: columns
                              .slice(1)
                              .map((k, i) => `${this.t(k)} ${this.value(values(row)[i + 1])}`)
                              .join(" / "),
                            label: this.name(resource, row._masterId),
                            image: this.image(resource, row._masterId) ?? "",
                            aspectRatio: 1,
                            fit: "contain",
                            href: href(row),
                            onImageError: nextImageCandidate,
                            placeholder: icon(member ? "person" : "image", 32),
                            marks: [level == null ? null : { at: "bottom-end", text: `${this.t("level")} ${level}` }],
                          });
                        })}
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
      const expanded = this.expanded.has(field);
      return accordion({
        id: `save-field-${field.slice(1)}`,
        label: this.t(field),
        metadata: html`
          <span class="chip">${Array.isArray(value) ? value.length : 1}</span>
        `,
        headingLevel: 2,
        className: "surface",
        expanded,
        onExpandedChange: (open) => {
          const next = new Set(this.expanded);
          if (open) next.add(field);
          else next.delete(field);
          this.expanded = next;
        },
        content: expanded ? this.facts(value) : nothing,
      });
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
    this.lazyImages.observe(this);
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
        ${
          record
            ? html`
                <section class="surface stack">
                  <dl class="spec-list">
                    <div>
                      <dt>${this.t("server")}</dt>
                      <dd>${this.serverName(record.snapshot.server)}</dd>
                    </div>
                    <div>
                      <dt>${this.t("saved")}</dt>
                      <dd>
                        ${record.snapshot.savedAt ? formatDate(this.locale, record.snapshot.savedAt) : this.t("unknown")}
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
                ${this.details(record)}
              `
            : html`
                <section class="surface stack">
                  <h2 class="detail-section-title">${this.t("local")}</h2>
                  <label>
                    <span>${this.t("server")}</span>
                    <span class="field">
                      <select
                        .value=${this.server}
                        @change=${(event: Event) => {
                          this.server = (event.target as HTMLSelectElement).value as "jp" | "intl";
                        }}
                      >
                        <option value="jp">${this.serverName("jp")}</option>
                        <option value="intl">${this.serverName("intl")}</option>
                      </select>
                    </span>
                  </label>
                  ${
                    this.records.length
                      ? html`
                          <ul class="detail-object-list" role="list">
                            ${this.records.map(
                              (row) => html`
                                <li>
                                  <a class="detail-object" href=${`#${row.id}`}>
                                    <span>
                                      ${row.label}
                                      <small class="md-body-small">
                                        ${this.serverName(row.snapshot.server)} /
                                        ${formatDate(this.locale, row.importedAt)}
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
                          <ul class="detail-object-list" role="list">
                            ${this.native.map(
                              (save) => html`
                                <li>
                                  <button
                                    class="detail-object"
                                    type="button"
                                    ?disabled=${this.busy}
                                    @click=${() => this.importNative(save)}
                                  >
                                    <span>
                                      ${save.name || save.profileId}
                                      <small class="md-body-small">
                                        ${[save.region ?? "", save.profileId].filter(Boolean).join(" / ")}
                                      </small>
                                    </span>
                                  </button>
                                </li>
                              `,
                            )}
                          </ul>
                        </section>
                      `
                    : nothing
                }
                ${
                  this.sources.length
                    ? html`
                        <section class="surface stack">
                          <h2 class="detail-section-title">${this.t("sources")}</h2>
                          <ul class="detail-object-list" role="list">
                            ${this.sources.map(
                              (source) => html`
                                <li>
                                  <button
                                    class="detail-object"
                                    type="button"
                                    ?disabled=${this.busy}
                                    @click=${() => this.source(source)}
                                  >
                                    ${this.sourceIcon(source)}
                                    <span>${this.t(`source_${source}`)}</span>
                                  </button>
                                </li>
                              `,
                            )}
                          </ul>
                        </section>
                      `
                    : inApp()
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
      ${this.sheet ? this.renderSheet() : nothing}
      ${
        this.removing
          ? html`
              <dialog class="dialog" ${modal(() => (this.removing = null))}>
                <div class="dialog__surface">
                  <header class="dialog__header"><h2>${this.t("delete")}</h2></header>
                  <footer class="dialog__actions">
                    <button class="button button--text" type="button" @click=${() => (this.removing = null)}>
                      ${this.t("cancel")}
                    </button>
                    <button class="button button--danger" type="button" @click=${() => this.confirmRemove()}>
                      ${this.t("confirm")}
                    </button>
                  </footer>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
}
customElements.define("save-workspace", SaveWorkspace);
