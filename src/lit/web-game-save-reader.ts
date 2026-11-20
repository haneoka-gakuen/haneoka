// L3 — GEB
// Input: Browser file and USB reads, device saves and private cloud metadata.
// Output: The account page's reusable save list and import controls.
// Pos: [Map](L2-2.md); web counterpart of the App's save list.
// Effects/Dependencies: IndexedDB, optional WebUSB and private save snapshots.
import { LitElement, html, nothing } from "lit";
import "@material/web/switch/switch.js";
import { ANDROID_CHANNELS, readAndroidFiles } from "@haneoka/game-data-exporter";
import { clientText } from "../i18n/client";
import type { DeviceSave } from "../lib/app-bridge";
import { preferredLocale } from "./shared/catalog";
import { readReleaseServer } from "../lib/release-server";
import { snackbar } from "../lib/snackbar";
import { icon } from "./ui/icon";
import { iconButton } from "./ui/controls";
import { modal } from "./ui/modal";
import { renderLocalSaveSourcePicker } from "./shared/local-save-source-picker";
import { GAME_TOOL_ACCOUNTS_CHANGED, gameToolOwner, refreshGameToolAccounts } from "../lib/game-tool-account-store";
import { saveRecords, type StoredSave } from "../lib/save-workspace/snapshot";
import { listCloudGameSaves, openCloudGameSave, storeImportedGameSave, uploadCloudGameSave, type CloudGameSave } from "../lib/save-workspace/cloud";

export class WebGameSaveReader extends LitElement {
  static properties = { native: { type: Boolean }, deviceSaves: { attribute: false } };
  declare native: boolean;
  declare deviceSaves: DeviceSave[];
  private local: StoredSave[] = [];
  private cloud: CloudGameSave[] = [];
  private source = false;
  private usbChoice = false;
  private usb?: typeof import("@haneoka/game-data-exporter/webusb");
  private busy = false;
  private abort = new AbortController();
  private generation = 0;
  private options() {
    const key = `haneoka:web-game-save-options:${encodeURIComponent(gameToolOwner() ?? "")}`;
    try { return { team: true, songs: true, save: true, ...JSON.parse(localStorage.getItem(key) ?? "{}") }; }
    catch { return { team: true, songs: true, save: true }; }
  }
  private setOption(key: "team" | "songs" | "save", enabled: boolean) {
    localStorage.setItem(`haneoka:web-game-save-options:${encodeURIComponent(gameToolOwner() ?? "")}`, JSON.stringify({ ...this.options(), [key]: enabled }));
    this.requestUpdate();
  }
  private changed = () => { void this.reload(); };
  constructor() {
    super();
    this.native = false;
    this.deviceSaves = [];
  }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    this.abort = new AbortController();
    window.addEventListener(GAME_TOOL_ACCOUNTS_CHANGED, this.changed);
    window.addEventListener("haneoka-save-import-complete", this.changed);
    void refreshGameToolAccounts().then(this.changed);
    if (!this.native && "usb" in navigator)
      void import("@haneoka/game-data-exporter/webusb").then(module => { this.usb = module; this.requestUpdate(); }).catch(() => {});
  }
  disconnectedCallback() {
    this.abort.abort();
    window.removeEventListener(GAME_TOOL_ACCOUNTS_CHANGED, this.changed);
    window.removeEventListener("haneoka-save-import-complete", this.changed);
    super.disconnectedCallback();
  }
  private t(key: string, fallback: string) { return clientText(preferredLocale(), `account.page.toolAccounts.${key}`, fallback); }
  private async reload() {
    if (!this.isConnected) return;
    const iteration = ++this.generation, owner = gameToolOwner();
    const [local, cloud] = await Promise.all([
      saveRecords("list").catch(() => []),
      owner ? listCloudGameSaves(owner).catch(() => []) : Promise.resolve([]),
    ]);
    if (!this.isConnected || iteration !== this.generation || owner !== gameToolOwner()) return;
    this.local = local;
    this.cloud = cloud;
    this.requestUpdate();
  }
  private async accept(files: File[], server: "jp" | "intl") {
    const owner = gameToolOwner();
    const options = this.options();
    const { importSaves } = await import("../lib/save-workspace/import");
    const records = await importSaves(files, server, this.abort.signal);
    let failed = false;
    for (const record of records) {
      this.abort.signal.throwIfAborted();
      const saved = await storeImportedGameSave(record);
      if (owner !== gameToolOwner()) continue;
      const tasks: Promise<boolean>[] = [];
      if (owner && options.save) tasks.push(uploadCloudGameSave(saved, owner));
      if (options.team || options.songs)
        tasks.push(import("../lib/app-save-import").then(({ importBrowserSaveToGameTools }) =>
          importBrowserSaveToGameTools(saved, owner, options)));
      if ((await Promise.allSettled(tasks)).some(task => task.status !== "fulfilled" || !task.value)) failed = true;
    }
    await this.reload();
    if (failed) snackbar(clientText(preferredLocale(), "account.page.autoImportFailed", "Some save data could not be imported"), { error: true });
  }
  private async run(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.requestUpdate();
    try { await action(); }
    catch {
      if (!this.abort.signal.aborted) snackbar(this.t("saveReadFailed", "Could not read game save"), { error: true });
    } finally {
      this.busy = false; this.requestUpdate();
    }
  }
  private files = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...input.files ?? []];
    input.value = "";
    if (files.length) void this.run(() => this.accept(files, readReleaseServer() === "jp" ? "jp" : "intl"));
  };
  private select(source: "files" | "folder" | "adb") {
    this.source = false;
    if (source === "adb") this.usbChoice = true;
    else this.querySelector<HTMLInputElement>(`[data-source="${source}"]`)?.click();
    this.requestUpdate();
  }
  private readUsb(channel: typeof ANDROID_CHANNELS[number]) {
    const reader = this.usb?.createUsbReader();
    if (!reader) return;
    this.usbChoice = false;
    void this.run(async () => {
      const files = await readAndroidFiles(reader, channel.packageId, this.abort.signal);
      if (files?.length) await this.accept(files, channel.server);
    });
  }
  private open(id: string, local?: StoredSave, cloud?: CloudGameSave) {
    const owner = gameToolOwner();
    const open = (record: StoredSave) => location.assign(`/${preferredLocale()}/saves/#${encodeURIComponent(record.id)}`);
    if (cloud && owner && (!local || Date.parse(cloud.savedAt ?? "1970-01-01") > Date.parse(local.snapshot.savedAt ?? "1970-01-01"))) {
      void this.run(async () => {
        const record = await openCloudGameSave(id, owner);
        if (this.isConnected && owner === gameToolOwner()) open(record);
      });
    } else if (local) open(local);
  }
  render() {
    const locale = preferredLocale();
    const title = this.t(this.native ? "cloudSaves" : "browserSaves", this.native ? "Cloud game saves" : "Game saves");
    const read = this.t("readSave", "Read game save");
    const options = this.options() as Record<"team" | "songs" | "save", boolean>;
    const shownCloud = this.native ? this.cloud.filter(row => !this.deviceSaves.some(save =>
      !!row.profile?.uid && save.profileId === row.profile.uid && save.server === row.server)) : this.cloud;
    const ids = new Set([...this.native ? [] : this.local.map(row => row.id), ...shownCloud.map(row => row.id)]);
    if (this.native && !ids.size) return nothing;
    return html`<section id="browser-game-saves" class="surface stack account-block" aria-busy=${String(this.busy)}>
      <div class="row row--between">
        <h2 class="detail-section-title">${icon(this.native ? "cloud_done" : "save", 22)}${title}</h2>
        ${!this.native ? html`<button class="button button--tonal" type="button" ?disabled=${this.busy}
          @click=${() => { this.source = true; this.requestUpdate(); }}>${icon("download", 18)}${read}</button>` : nothing}
      </div>
      ${ids.size ? html`<ul class="detail-object-list" role="list">${[...ids].map(id => {
        const local = this.local.find(row => row.id === id);
        const cloud = shownCloud.find(row => row.id === id);
        const server = cloud?.server ?? local?.snapshot.server;
        const profile = cloud?.profile ?? local?.profile;
        return html`<li class="row">
          <button class="detail-object" type="button" ?disabled=${this.busy} @click=${() => this.open(id, local, cloud)}>
            <span class="account-avatar">${icon(cloud ? "cloud_done" : "save", 20)}</span>
            <span>${profile?.name || cloud?.label || local?.label || title}<small class="md-body-small">
              ${[profile?.region || (server === "jp" ? "JP" : "Global"), profile?.rank ? `RANK ${profile.rank}` : "",
                profile?.uid ? `UID ${profile.uid}` : ""].filter(Boolean).join(" / ")}</small></span>
          </button>
          ${!this.native && !cloud && local && gameToolOwner() ? iconButton({ icon: "cloud_upload", label: this.t("syncSave", "Sync game save"),
            disabled: this.busy, onClick: () => void this.run(async () => {
              const owner = gameToolOwner(); if (!owner || !await uploadCloudGameSave(local, owner)) throw new Error("save_sync_failed");
              await this.reload();
            }) }) : nothing}
        </li>`;
      })}</ul>` : nothing}
      ${!this.native ? html`<ul class="detail-object-list" role="list">
        ${([
          ["save", this.t("syncSave", "Sync game save"), "cloud_upload"],
          ["team", clientText(locale, "account.page.autoTeam", "Automatically import cards"), "groups"],
          ["songs", clientText(locale, "account.page.autoSongs", "Automatically import song progress"), "checklist"],
        ] as const).map(([key, label, glyph]) => html`<li><label class="detail-object row row--between">
          ${icon(glyph, 20)} <span>${label}</span>
          <md-switch .selected=${options[key]} icons aria-label=${label} ?disabled=${this.busy}
            @change=${(event: Event) => this.setOption(key, (event.currentTarget as HTMLElement & { selected: boolean }).selected)}></md-switch>
        </label></li>`)}
      </ul>` : nothing}
      <input hidden type="file" data-source="files" multiple @change=${this.files} />
      <input hidden type="file" data-source="folder" webkitdirectory multiple @change=${this.files} />
      ${this.source ? renderLocalSaveSourcePicker({
        locale, title: read, sources: this.usb?.usbAvailable() ? ["files", "folder", "adb"] as const : ["files", "folder"] as const,
        onSelect: source => this.select(source), onClose: () => { this.source = false; this.requestUpdate(); },
      }) : nothing}
      ${this.usbChoice ? html`<dialog class="dialog" aria-label=${read} ${modal(() => { this.usbChoice = false; this.requestUpdate(); })}>
        <header class="dialog__header"><h2>${icon("usb", 22)}${read}</h2></header>
        <div class="dialog__body stack">${ANDROID_CHANNELS.map((channel, index) => html`
          <button class="button button--tonal" type="button" @click=${() => this.readUsb(channel)}>
            ${icon("sports_esports", 20)}${["Global", "Global (Google Play)", "JP"][index]}
          </button>`)}</div>
      </dialog>` : nothing}
    </section>`;
  }
}
if (!customElements.get("web-game-save-reader")) customElements.define("web-game-save-reader", WebGameSaveReader);
