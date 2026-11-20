// L3 — GEB
// Input: Local save files, native save snapshots and release-pinned catalogue data.
// Output: Persistent save collection, readable progress and confirmed Box handoff.
// Pos: [Map](L2-2.md); shared browser and native-shell save workspace.
// Effects/Dependencies: Local decoding Worker, IndexedDB, public catalogue reads, tab-local handoff and the app's save sources (saveSourcesV1).
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { clientText } from "../i18n/client";
import { viewSwitch, collectionList, collectionTable, type CollectionView } from "./ui/collection-view";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { LazyImages, nextImageCandidate } from "./ui/lazy-images";
import { accordion } from "./ui/accordion";
import { iconButton } from "./ui/controls";
import "./ui/scrollable-tabs";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { saveAccountProgress } from "../lib/save-workspace/progress";
import { saveCharactersView, saveCharacterName, saveFriendshipsView, saveGrowthRow, savePairName, saveRankMeter } from "./views/save-growth";
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
  appSaveImportHref,
} from "../lib/app-bridge";
import { modal } from "./ui/modal";
import { gameHistoryHelp } from "./ui/game-history-help";
import { downloadBlob } from "../lib/canvas-capture";
import { formatDate } from "../lib/date-format";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { songProgressProfile } from "../lib/song-progress-profile";

const SAVE_SECTIONS = ["overview", "_characters", "_characterFriendships", "collection", "records", "saveData"] as const;
type SaveSection = (typeof SAVE_SECTIONS)[number];
const COLLECTION_FIELDS = [
  "_memberCards", "_supportCards", "_bandItems", "_items", "_unlockedCostumes", "_currentCostumes",
  "_backgrounds", "_stamps", "_stampFavorites", "_degrees", "_playerProfileCards", "_liveLaneSkins",
  "_liveNoteSkins", "_liveNoteEffectSkins", "_liveNoteSeGroups", "_memory",
] as const;
const RECORD_FIELDS = [
  "_liveMusicResults", "_challengeMusicResults", "_topHighScoreRatings", "_liveMusics", "_challengeMusics",
  "_events", "_challengeLives", "_arenaLeagues", "_decks", "_storyEpisodeRecords", "_gachaRecords",
  "_normalMissions", "_limitedMissions", "_characterMissions", "_missionCounters", "_characterFriendshipRankRewards",
  "_playerSeasonPass", "_monthlyPass", "_receivedLoginBonuses", "_liveBoost", "_liveSkip", "_offlineBonus",
  "_exchange", "_shop", "_spots", "_vip",
] as const;

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
    historyHelpOpen: { state: true },
    devices: { state: true },
    backups: { state: true },
    locked: { state: true },
    removing: { state: true },
    catalog: { state: true },
    server: { state: true },
    view: { state: true },
    section: { state: true },
    character: { state: true },
    band: { state: true },
    first: { state: true },
    second: { state: true },
    pairPicker: { state: true },
    rawLimits: { state: true },
  };
  declare historyHelpOpen: boolean;
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
  declare section: SaveSection;
  declare character: string;
  declare band: number | null;
  declare first: string;
  declare second: string;
  declare pairPicker: boolean;
  declare rawLimits: ReadonlyMap<string, number>;
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
    this.historyHelpOpen = false;
    this.devices = null;
    this.backups = null;
    this.locked = null;
    this.removing = null;
    this.section = "overview";
    this.character = "";
    this.band = null;
    this.first = "";
    this.second = "";
    this.pairPicker = false;
    this.rawLimits = new Map();
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
  private growth?: { player: Row; catalog?: SaveCatalog; locale: string; data: ReturnType<typeof saveAccountProgress> };
  createRenderRoot() {
    return this;
  }
  private t(key: string) {
    return clientText(this.locale, `saveWorkspace.${key}`, this.messages[key] ?? key);
  }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.messages = JSON.parse(this.dataset.messages ?? "{}");
    this.selected = location.hash.slice(1);
    window.addEventListener("hashchange", this.route);
    window.addEventListener("haneoka-app-accounts", this.nativeChanged);
    void this.run(() => this.reload());
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    super.disconnectedCallback();
    this.controller.abort();
    this.catalogController?.abort();
    this.catalogServer = "";
    window.removeEventListener("hashchange", this.route);
    window.removeEventListener("haneoka-app-accounts", this.nativeChanged);
    clearAppBarActions("save-workspace");
    this.lazyImages.disconnect();
    this.restoreShell();
  }
  private route = () => {
    const selected = location.hash.slice(1);
    if (this.selected !== selected) {
      this.section = "overview";
      this.character = this.first = this.second = "";
      this.band = null;
      this.pairPicker = false;
      this.expanded = new Set();
      this.rawLimits = new Map();
    }
    this.selected = selected;
    const record = this.record;
    if (record) this.server = record.snapshot.server;
    if (record && record.snapshot.server !== this.catalogServer) void this.loadCatalog(record.snapshot.server);
  };
  private get record() {
    return this.records.find(record => record.id === this.selected);
  }
  private async loadCatalog(server: "jp" | "intl") {
    this.catalogController?.abort();
    const controller = (this.catalogController = new AbortController());
    this.catalogServer = server;
    this.catalog = undefined;
    try {
      const result = await loadSaveCatalog(server, controller.signal, true);
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
  private async add(snapshot: SaveSnapshot, label: string, profile?: StoredSave["profile"]) {
    const record: StoredSave = { id: crypto.randomUUID(), label, importedAt: new Date().toISOString(), snapshot, profile };
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
        for (const value of values) await this.add(value.snapshot, value.label, value.profile);
      }, true);
  };
  private importNative(save: DeviceSave) {
    void this.run(async () => {
      const result = await appCall("saveSnapshot", { key: save.key, complete: true });
      await this.add(parseSnapshot(result.text), save.name ?? save.profileId, songProgressProfile({
        name: save.name, uid: save.profileId, rank: save.rank, region: save.region, server: save.server,
      }));
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
      const uid = typeof player._profileId === "string" || typeof player._profileId === "number" ? String(player._profileId) : record.profile?.uid;
      let accountId: string | undefined;
      if (uid) {
        const { captureGameToolSave, refreshGameToolAccounts } = await import("../lib/game-tool-account-store");
        await refreshGameToolAccounts();
        const account = await captureGameToolSave({
          key: `${snapshot.server}-${uid}`, profileId: uid, server: snapshot.server,
          name: record.profile?.name || record.label, region: record.profile?.region ?? null,
          rank: Number(record.profile?.rank) || null, savedAt: snapshot.savedAt ? Date.parse(snapshot.savedAt) : null,
          favoriteCardId: Number(player._favoriteMemberCardId) || null,
        }, "team");
        accountId = account?.id;
      }
      const box = Object.fromEntries(
        ["_memberCards", "_supportCards", "_characters", "_bandItems"].flatMap((key) =>
          player[key] === undefined ? [] : [[key, player[key]]],
        ),
      );
      sessionStorage.setItem(
        "haneoka:pending-save-box",
        JSON.stringify({ id: record.id, server: snapshot.server, accountId, text: JSON.stringify({ ...snapshot, player: box }) }),
      );
      location.assign(
        `/${this.locale}/team-builder/?server=${snapshot.server}&tab=box&saveImport=${encodeURIComponent(record.id)}${accountId ? `&appBox=1&gameAccount=${accountId}` : ""}`,
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
      this.closeRecord();
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
        const device = await appCall("deviceStatus", {});
        const { installed } = device;
        let { status } = device;
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
    if (resource === "songs") return songTitle(row, this.locale).text;
    const name = text(
      row.prefix ?? row.musicTitle ?? row.musicName ?? row.characterName ?? row.itemName ?? row.name ?? row.title,
      this.locale,
    );
    return name || `${this.t("id")} ${this.value(id)}`;
  }
  private image(resource: string, id: unknown) {
    const row = saveEntity(this.catalog, resource, id);
    const images = object(row.images);
    const url = images.thumbnail ?? images.jacket ?? row.jacket ?? row.image;
    return typeof url === "string" && url.startsWith("/assets/") ? url : undefined;
  }
  private details(record: StoredSave, fields: readonly string[]) {
    return fields.filter(field => Object.hasOwn(record.snapshot.player, field)).map(field => {
      const value = record.snapshot.player[field];
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
        const listPath = "song-results";
        const expanded = this.expanded.has(listPath);
        const shown = this.rawLimits.get(listPath) ?? 24;
        return html`
          <section class="surface stack">
            ${renderDetailSectionHeading(this.t(field), "songs", { level: 2, count: rows.length })}
            <div class="save-song-summary">
              ${difficulties.map(key => {
                const results = rows.map(row => Number(row[`_${key}ClearedStatus`]) || 0);
                return html`<section class="save-mission">
                  <strong>${key.toUpperCase()}</strong>
                  <dl class="save-song-marks">
                    ${[[10, "CLEAR"], [20, "FC"], [30, "AP"]].map(([threshold, label]) => html`
                        <div><dt>${label}</dt><dd>${results.filter(value => value >= Number(threshold)).length}</dd></div>`)}
                  </dl>
                </section>`;
              })}
            </div>
            ${accordion({
              id: "save-song-results", label: this.t("allRecords"), expanded,
              onExpandedChange: open => this.toggleField(listPath, open),
              content: expanded ? html`
                ${collectionList(rows.slice(0, shown).map(row => {
                  const id = row._mLiveMusicId ?? row._masterMusicId ?? row._masterId;
                  const image = this.image("songs", id);
                  return {
                    id: String(id), title: this.name("songs", id),
                    href: `/${record.snapshot.server}/${this.locale}/songs/${id}/`,
                    media: image ? html`<img src=${image} alt="" width="48" height="48" loading="lazy" />` : nothing,
                    subtitle: difficulties.map(key =>
                      `${key.toUpperCase()} ${marks[String(row[`_${key}ClearedStatus`])] ?? this.t("unknown")}`).join(" / "),
                  };
                }))}
                ${shown < rows.length ? this.moreRecords(listPath, shown, rows.length) : nothing}
              ` : nothing,
            })}
          </section>
        `;
      }
      const config: Record<string, { resource: string; id: string; columns: string[] }> = {
        _items: { resource: "items", id: "_masterItemId", columns: ["_amount"] },
        _bandItems: { resource: "band-items", id: "_masterId", columns: ["_level"] },
        _events: { resource: "events", id: "_masterId", columns: ["_eventPointCount"] },
      };
      const c = config[field];
      if (c)
        return html`
          <section class="surface stack">
            <h2 class="detail-section-title">
              ${this.t(field)}
              <span class="chip">${rows.length}</span>
            </h2>
            ${collectionList(rows.slice(0, this.rawLimits.get(field) ?? 24).map(row => {
              const id = row[c.id], image = this.image(c.resource, id);
              return {
                id: String(id), title: this.name(c.resource, id), href: `/${record.snapshot.server}/${this.locale}/${c.resource}/${id}/`,
                media: image ? html`<img src=${image} alt="" loading="lazy" width="48" height="48" />` : nothing,
                subtitle: c.columns.map(key => `${this.t(key === "_eventPointCount" ? "_point" : key)} ${this.value(row[key])}`).join(" / "),
              };
            }))}
            ${rows.length > (this.rawLimits.get(field) ?? 24) ? this.moreRecords(field, this.rawLimits.get(field) ?? 24, rows.length) : nothing}
          </section>
        `;
      return this.fieldFold(field, this.t(field), value, true);
    });
  }
  private toggleField(path: string, open: boolean) {
    const next = new Set(this.expanded);
    if (open) next.add(path);
    else next.delete(path);
    this.expanded = next;
  }
  private moreRecords(path: string, limit: number, count: number) {
    return html`<button class="button button--text" type="button"
      @click=${() => { this.rawLimits = new Map(this.rawLimits).set(path, limit + 24); }}>
      ${this.t("moreRecords")} (${limit} / ${count})
    </button>`;
  }
  private fieldFold(path: string, label: string, value: unknown, top = false) {
    const expanded = this.expanded.has(path);
    const size = Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : undefined;
    return accordion({
      id: `save-field-${encodeURIComponent(path)}`,
      label,
      metadata: size === undefined ? nothing : html`<span class="detail-section-title__count">${size}</span>`,
      headingLevel: top ? 2 : 3,
      className: top ? "surface save-field" : "save-field",
      expanded,
      onExpandedChange: open => this.toggleField(path, open),
      content: expanded ? this.facts(value, path) : nothing,
    });
  }
  private facts(value: unknown, path: string): unknown {
    if (!value || typeof value !== "object") return html`<code>${value === null ? "null" : this.value(value)}</code>`;
    const limit = this.rawLimits.get(path) ?? 24;
    const entries = Array.isArray(value)
      ? value.slice(0, limit).map((entry, index) => [String(index), entry] as const)
      : Object.entries(value);
    const count = Array.isArray(value) ? value.length : entries.length;
    if (!count) return html`<code>${Array.isArray(value) ? "[]" : "{}"}</code>`;
    return html`<div class="save-fields">
      ${entries.map(([key, entry]) => {
        const label = Array.isArray(value) ? `${this.t("entry")} ${Number(key) + 1}` : this.messages[key] ?? key;
        return entry && typeof entry === "object"
          ? this.fieldFold(`${path}/${encodeURIComponent(key)}`, label, entry)
          : html`<dl class="save-field-value"><dt>${label}</dt><dd>${this.facts(entry, path)}</dd></dl>`;
      })}
      ${Array.isArray(value) && count > limit ? this.moreRecords(path, limit, count) : nothing}
    </div>`;
  }

  private accountProgress(record: StoredSave) {
    const player = record.snapshot.player;
    if (this.growth?.player === player && this.growth.catalog === this.catalog && this.growth.locale === this.locale)
      return this.growth.data;
    const data = saveAccountProgress(player, this.catalog, this.locale);
    this.growth = { player, catalog: this.catalog, locale: this.locale, data };
    return data;
  }

  private renderOverview(record: StoredSave, progress: ReturnType<typeof saveAccountProgress>) {
    const t = (key: string) => this.t(key);
    const locale = this.locale;
    const player = record.snapshot.player;
    const cardId = player._favoriteMemberCardId ?? player._lastLiveDeckLeaderMemberCardId;
    const card = saveEntity(this.catalog, "cards", cardId);
    const art = object(card.images).full ?? this.image("cards", cardId);
    const name = record.profile?.name || record.label;
    const number = new Intl.NumberFormat(locale);
    const count = (field: string) => Array.isArray(player[field]) ? player[field].length : null;
    const characters = progress.characters.filter(row => row.experience !== null || row.level);
    const friendships = progress.friendships.filter(row => row.experience !== null || row.level);
    const ratings = Array.isArray(player._topHighScoreRatings) ? player._topHighScoreRatings : null;
    const highScore = ratings?.reduce((total: number, row) => total + (Number(object(row)._highScoreRating) || 0), 0);
    const stats = [
      { key: "_memberCards", glyph: icon("person", 20), value: count("_memberCards"), target: "collection" },
      { key: "_supportCards", glyph: icon("photo_library", 20), value: count("_supportCards"), target: "collection" },
      { key: "_characters", glyph: icon("group", 20), value: count("_characters") === null ? null : characters.length, target: "_characters" },
      { key: "_characterFriendships", glyph: icon("handshake", 20), value: count("_characterFriendships") === null ? null : friendships.length, target: "_characterFriendships" },
    ] as const;
    return html`
      <section class="surface save-identity">
        <div class="save-identity__body">
          <div class="cluster save-identity__tags">
            <span class="chip chip--tonal chip--static">${record.profile?.region || this.serverName(record.snapshot.server)}</span>
            ${record.profile?.uid ? html`<span class="save-identity__id">UID ${record.profile.uid}</span>` : nothing}
          </div>
          <h2>${name}</h2>
          ${saveRankMeter({ ...progress.playerRank, level: record.profile?.rank || progress.playerRank.level }, t, locale)}
          <dl class="spec-list spec-list--split save-identity__facts">
            <div><dt>${t("saved")}</dt><dd>${this.value(record.snapshot.savedAt ? formatDate(locale, record.snapshot.savedAt) : null)}</dd></div>
            ${highScore === undefined ? nothing : html`<div><dt>${t("highScoreRating")}</dt><dd>${number.format(highScore)}</dd></div>`}
          </dl>
        </div>
        ${typeof art === "string" && art ? html`<img class="save-identity__art" src=${art} alt="" width="176" height="176" decoding="async" />` :
          html`<div class="save-identity__art save-identity__placeholder" aria-hidden="true">${icon("sports_esports", 48)}</div>`}
      </section>
      <div class="cluster">
        <button class="button button--filled" type="button" ?disabled=${this.busy} @click=${() => this.team(record)}>
          ${icon("groups", 18)}${t("team")}
        </button>
        <button class="button button--tonal" type="button" @click=${() => this.export(record)}>
          ${icon("download", 18)}${t("export")}
        </button>
        <button class="button button--text" type="button" @click=${() => this.removeSave(record)}>${t("delete")}</button>
      </div>
      <div class="save-summary">
        ${stats.map(({ key, glyph, value, target }) => html`<button class="save-stat" type="button" @click=${() => this.changeSection(target)}>
          <span class="save-stat__label">${glyph}${t(key)}</span>
          <strong>${value === null ? "—" : number.format(value)}</strong>
        </button>`)}
      </div>
      <div class="save-overview-columns">
        <section class="surface stack">
          ${renderDetailSectionHeading(t("_characters"), "characters", { level: 2, count: progress.characters.length })}
          ${characters.length ? characters.slice(0, 4).map(character => saveGrowthRow(saveCharacterName(character, t), character, [character], t, locale))
            : html`<p class="save-empty">${t("noRecords")}</p>`}
          <button class="button button--text save-view-all" type="button" @click=${() => this.changeSection("_characters")}>
            ${t("allRecords")}${icon("chevron_right", 18)}
          </button>
        </section>
        <section class="surface stack">
          ${renderDetailSectionHeading(t("_characterFriendships"), "friendships", { level: 2, count: progress.friendships.length })}
          ${friendships.length ? friendships.slice(0, 4).map(pair => saveGrowthRow(savePairName(pair, t), pair, pair.characters, t, locale))
            : html`<p class="save-empty">${t("noRecords")}</p>`}
          <button class="button button--text save-view-all" type="button" @click=${() => this.changeSection("_characterFriendships")}>
            ${t("allRecords")}${icon("chevron_right", 18)}
          </button>
        </section>
      </div>
    `;
  }

  private changeSection(section: SaveSection) {
    this.section = section;
    void this.updateComplete.then(() => {
      this.querySelector(".save-sections")?.scrollIntoView({ block: "nearest" });
    });
  }

  private renderRecord(record: StoredSave) {
    const progress = this.accountProgress(record);
    const t = (key: string) => this.t(key);
    const snapshot = record.snapshot;
    const content = {
      overview: () => this.renderOverview(record, progress),
      _characters: () => saveCharactersView({
        progress, catalog: this.catalog, selected: this.character, band: this.band, t, locale: this.locale,
        onBand: band => { this.band = band; this.character = ""; },
        onSelect: character => { this.character = character; },
      }),
      _characterFriendships: () => saveFriendshipsView({
        progress, catalog: this.catalog, first: this.first, second: this.second,
        open: this.pairPicker, t, locale: this.locale, server: snapshot.server,
        onChange: (first, second) => { this.first = first; this.second = second; },
        onOpen: open => { this.pairPicker = open; },
      }),
      collection: () => this.details(record, COLLECTION_FIELDS),
      records: () => this.details(record, RECORD_FIELDS),
      saveData: () => this.saveDocuments(snapshot),
    }[this.section]();
    return html`
      <scrollable-tabs class="save-sections" .locale=${this.locale} .label=${this.t("accountDetails")}
        .items=${SAVE_SECTIONS.map(id => ({ id, label: this.t(id) }))}
        .value=${this.section} .onSelect=${(section: SaveSection) => this.changeSection(section)}></scrollable-tabs>
      <div class="save-section stack" role="tabpanel" aria-label=${t(this.section)}>
        ${Array.isArray(content) && !content.length ? html`<p class="surface save-empty">${t("noRecords")}</p>` : content}
      </div>
    `;
  }
  private saveDocuments(snapshot: SaveSnapshot) {
    return html`
      ${this.fieldFold("document/player", this.t("playerData"), snapshot.player, true)}
      ${[
        ["settings", "saveSettings"], ["persist", "latestLive"], ["permanent", "permanentData"],
      ].map(([key, label]) => {
        const value = snapshot[key as "settings" | "persist" | "permanent"];
        return value === undefined ? nothing : this.fieldFold(`document/${key}`, this.t(label), value, true);
      })}
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
    const record = this.record;
    const heading = document.querySelector<HTMLElement>("[data-top-app-bar] h1");
    if (heading) heading.textContent = record?.profile?.name || record?.label || this.t("title");
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
      back.addEventListener("click", (event) => {
        event.preventDefault();
        this.closeRecord();
      });
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
  private closeRecord() {
    const url = new URL(location.href);
    url.hash = "";
    history.replaceState(history.state, "", url);
    this.route();
  }
  protected updated() {
    this.lazyImages.observe(this);
    this.syncShell();
    const record = this.record;
    setAppBarActions(
      "save-workspace",
      html`
        <button class="icon-button" type="button" aria-label=${this.t("readHelp")} @click=${() => { this.historyHelpOpen = true; }}>${icon("help")}</button>
        ${
          record && this.section === "collection"
            ? viewSwitch(this.locale, this.view, (view) => {
                this.view = view;
              })
            : nothing
        }
        ${record && this.section !== "overview" ? html`
          ${iconButton({ icon: "groups", label: this.t("team"), disabled: this.busy, onClick: () => this.team(record) })}
          ${iconButton({ icon: "download", label: this.t("export"), disabled: this.busy, onClick: () => this.export(record) })}
          ${iconButton({ icon: "delete", label: this.t("delete"), onClick: () => this.removeSave(record) })}
        ` : html`<button
          class="button button--tonal"
          ?disabled=${this.busy}
          @click=${() => this.querySelector<HTMLInputElement>("input[type=file]")?.click()}
        >
          ${this.t("import")}
        </button>`}
      `,
    );
  }
  render() {
    const record = this.record;
    return html`
      ${this.historyHelpOpen ? gameHistoryHelp(key => this.t(key), () => { this.historyHelpOpen = false; }) : nothing}
      <input type="file" multiple hidden @change=${this.file} />
      <div class="save-workspace stack" aria-busy=${this.busy}>
        ${
          record ? this.renderRecord(record) : html`
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
                  inApp()
                    ? html`<a class="button button--tonal" href=${appSaveImportHref(this.locale)}>
                        ${clientText(this.locale, "account.page.openSaveImport", "Import a save in Account")}
                      </a>`
                    : this.sources.length
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
