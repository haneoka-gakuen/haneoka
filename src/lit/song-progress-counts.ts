// L3 — GEB
// Input: Synced progress, original save files and stored local snapshots.
// Output: Read-only cumulative statistics, source selection and editable per-difficulty clears.
// Pos: [Map](L2-2.md); song-progress counts reuse Box writes and the save decoder.
// Effects/Dependencies: Lazy local import Worker/IndexedDB; imported and edited counts use identical synced keys.
import { html, nothing } from "lit";
import type { LitElement } from "lit";
import { live } from "lit/directives/live.js";
import { modal } from "./ui/modal";
import { focusedValue } from "./ui/focused-value";
import { icon } from "./ui/icon";
import { specList } from "./ui/spec";
import { collectionList } from "./ui/collection-view";
import { emptyState } from "./ui/state";
import { actionMenu } from "./ui/action-menu";
import { uiText } from "./shared/catalog";
import { formatDate } from "../lib/date-format";
import { chartCountChanges, countImportChanges, playCount, playCountKey, songPlayCount, storedPlayCount, type CountChanges, type CountEntries } from "../lib/song-progress-counts";
import type { StoredSave } from "../lib/save-workspace/snapshot";
import type { BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { clientText } from "../i18n/client";
import { appCall, appSaveImportHref, appSupports, inApp } from "../lib/app-bridge";
import { chooseAppAccount } from "./ui/app-account-chooser";
import { snackbar } from "../lib/snackbar";
import { songProgressProfile, type SongProgressProfile } from "../lib/song-progress-profile";

interface Options {
  locale(): string;
  server(): "jp" | "intl";
  text(key: string, fallback: string): string;
  write(changes: CountChanges): void;
  marks(player: Record<string, unknown>): CountChanges;
  profile(account?: SongProgressProfile): void;
  difficulties(song: number): readonly number[];
}
export class ProgressCounts {
  private entries: CountEntries = {};
  private context = "";
  private controller = new AbortController();
  private busy = false;
  private error = "";
  private records: StoredSave[] | null = null;
  private invalidFields = new Set<string>();
  constructor(private host: LitElement, private options: Options) {}
  private t = (key: string, fallback: string) => this.options.text(`counts.${key}`, fallback);
  private changed() { this.host.requestUpdate(); }
  sync(snapshot: BoxSnapshot) {
    for (const key of this.invalidFields) if (this.entries[key]?.v !== snapshot.entries[key]?.v) this.invalidFields.delete(key);
    this.entries = snapshot.entries;
    const context = `${this.options.server()}:${snapshot.owner ?? "local"}`;
    if (context === this.context && !this.controller.signal.aborted) return;
    this.context = context;
    this.invalidFields.clear();
    this.controller.abort(); this.controller = new AbortController();
    this.busy = false; this.records = null; this.error = "";
  }
  dispose() { this.controller.abort(); }
  value(type: number, param1 = 0, param2 = 0) { return storedPlayCount(this.entries, type, param1, param2); }
  format(count: bigint | null) { return count === null ? "—" : new Intl.NumberFormat(this.options.locale()).format(count); }
  chart(song: number, difficulty: number) { return difficulty >= 0 && difficulty <= 4 ? this.value(108, song, difficulty + 1) : null; }
  song(song: number) { return songPlayCount(this.entries, song, this.options.difficulties(song)); }
  openFiles() { if (!this.busy) this.host.querySelector<HTMLInputElement>("#progress-counts-file")?.click(); }
  supportsApp() { return inApp() && appSupports("saveSnapshotV1"); }
  async readAppSave(options: { key?: string; fallback?: boolean } = {}): Promise<boolean> {
    if (this.busy) return false;
    const context = this.context, controller = this.controller;
    this.busy = true; this.error = ""; this.changed();
    try {
      const accounts = (await appCall("gameAccounts", {})).filter(account => !account.server || account.server === this.options.server());
      const key = options.key ?? await chooseAppAccount(this.options.locale(), accounts);
      if (!key || this.controller !== controller || controller.signal.aborted) return false;
      const account = accounts.find(account => account.key === key);
      if (!account) throw new Error("counts_server");
      const { text } = await appCall("saveSnapshot", { key });
      const { importSaves } = await import("../lib/save-workspace/import");
      const values = await importSaves([new File([text], "GameSave.json", { type: "application/json" })], this.options.server(), controller.signal);
      if (context !== this.context || this.controller !== controller || controller.signal.aborted) return false;
      const value = values.find(value => value.snapshot.server === this.options.server());
      if (!value) throw new Error("counts_server");
      const record: StoredSave = { ...value, id: crypto.randomUUID(), label: account.name || this.t("gameSave", "Game save"), importedAt: new Date().toISOString(),
        profile: songProgressProfile({ ...account, uid: account.profileId }) };
      const { saveRecords } = await import("../lib/save-workspace/snapshot");
      await saveRecords("put", record);
      if (context !== this.context || this.controller !== controller || controller.signal.aborted) return false;
      this.use(record);
      return true;
    } catch (error) {
      if (!options.fallback && context === this.context && this.controller === controller && !controller.signal.aborted) this.error = error instanceof Error && error.message === "counts_server"
        ? this.t("wrongServer", "Save region does not match") : this.t("readFailed", "Could not read the original save");
      return false;
    } finally { if (context === this.context && this.controller === controller) { this.busy = false; this.changed(); } }
  }
  private async pick() {
    if (this.busy) return;
    const context = this.context, controller = this.controller;
    this.busy = true; this.error = ""; this.changed();
    try {
      const { saveRecords } = await import("../lib/save-workspace/snapshot");
      const records = await saveRecords("list");
      if (context === this.context && this.controller === controller && !controller.signal.aborted) this.records = records.filter(record => record.snapshot.server === this.options.server()).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    } catch { if (context === this.context && this.controller === controller) this.error = this.t("readFailed", "Could not read save data"); }
    finally { if (context === this.context && this.controller === controller) { this.busy = false; this.changed(); } }
  }
  private use(record: StoredSave) {
    const changes = countImportChanges(record.snapshot.player._missionCounters, record.label, record.snapshot.savedAt ?? record.importedAt);
    const marks = this.options.marks(record.snapshot.player);
    this.invalidFields.clear();
    if (changes.length || marks.length) this.options.write([...marks, ...changes]);
    if (changes.length || marks.length || Array.isArray(record.snapshot.player._liveMusicResults))
      this.options.profile(record.profile);
    this.error = changes.length ? "" : this.t("missing", "This save has no count records");
    this.records = null; this.changed();
  }
  private field(label: string, ariaLabel: string, target: { song: number; difficulty: number }) {
    const key = playCountKey(108, target.song, target.difficulty + 1);
    const current = () => this.chart(target.song, target.difficulty);
    type Control = HTMLElement & { value: string; error: boolean };
    const commit = (event: Event) => {
      const control = event.currentTarget as Control, raw = control.value.trim();
      const value = raw === "" ? null : playCount(raw);
      control.error = raw !== "" && value === null;
      if (control.error) { this.invalidFields.add(key); snackbar(this.t("invalid", "Enter a nonnegative whole count in range")); return; }
      this.invalidFields.delete(key);
      control.value = value?.toString() ?? "";
      if (value === current()) return;
      try {
        this.options.write(chartCountChanges(this.entries, target.song, target.difficulty, value, this.options.difficulties(target.song)));
      } catch { this.invalidFields.add(key); control.error = true; snackbar(this.t("writeFailed", "Could not save counts")); }
    };
    return html`<md-outlined-text-field class="number-field" type="text" inputmode="numeric" pattern="[0-9]*"
      label=${label} aria-label=${ariaLabel} placeholder="—" .value=${focusedValue(current()?.toString() ?? "")} .error=${live(this.invalidFields.has(key))}
      @input=${(event: Event) => { this.invalidFields.delete(key); (event.currentTarget as Control).error = false; }} @change=${commit}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter") { event.preventDefault(); commit(event); }
        if (event.key === "Escape") {
          event.preventDefault(); const control = event.currentTarget as Control;
          this.invalidFields.delete(key); control.value = current()?.toString() ?? ""; control.error = false;
        }
      }}></md-outlined-text-field>`;
  }
  private file = async (event: Event) => {
    const input = event.target as HTMLInputElement, files = [...input.files ?? []]; input.value = "";
    if (!files.length || this.busy) return;
    const context = this.context, controller = this.controller;
    this.busy = true; this.error = ""; this.changed();
    try {
      const { importSaves } = await import("../lib/save-workspace/import");
      const values = await importSaves(files, this.options.server(), controller.signal);
      if (context !== this.context || this.controller !== controller || controller.signal.aborted) return;
      const matching = values.filter(value => value.snapshot.server === this.options.server());
      if (!matching.length) throw new Error("counts_server");
      const { saveRecords } = await import("../lib/save-workspace/snapshot");
      const records: StoredSave[] = [];
      for (const value of matching) {
        const record = { ...value, id: crypto.randomUUID(), importedAt: new Date().toISOString() };
        await saveRecords("put", record); records.push(record);
      }
      if (context !== this.context || this.controller !== controller || controller.signal.aborted) return;
      if (records.length === 1) this.use(records[0]!); else this.records = records;
    } catch (error) {
      if (context === this.context && this.controller === controller && !controller.signal.aborted) this.error = error instanceof Error && error.message === "counts_server"
        ? this.t("wrongServer", "Save region does not match") : this.t("readFailed", "Could not read the original save");
    } finally { if (context === this.context && this.controller === controller) { this.busy = false; this.changed(); } }
  };
  renderImportMenu() {
    return actionMenu({ id: "song-progress-import", label: html`${icon("folder_open", 24)}<span>${uiText(this.options.locale(), "common.actions.import")}</span>`,
      items: [
        ...(inApp() ? [{
          label: clientText(this.options.locale(), "account.page.openSaveImport", "Import a save in Account"),
          leading: icon("sports_esports", 20),
          run: () => location.assign(appSaveImportHref(this.options.locale())),
        }] : []),
        { label: this.t("import", "Read original save"), leading: icon("folder_open", 20), run: () => this.openFiles() },
        { label: this.t("pick", "Choose saved data"), leading: icon("description", 20), run: () => void this.pick() },
      ],
    });
  }
  summaryRows() {
    return [
        { label: this.t("total", "Total clears"), value: this.format(this.value(76)) },
        { label: this.t("fc", "FULL COMBO clears"), value: this.format(this.value(77)) },
        { label: this.t("ap", "ALL PERFECT clears"), value: this.format(this.value(78)) },
        { label: this.t("arena", "Gekiso Arena plays"), value: this.format(this.value(102)) },
        { label: this.t("battle", "Multi Live clears"), value: this.format(this.value(137)) },
    ];
  }
  renderImportState() {
    return html`
      <input id="progress-counts-file" type="file" multiple hidden accept=".json,.zip,.gz,.dat,.bin" @change=${this.file} />
      <small class="song-progress__rating-status" role="status">${this.busy ? uiText(this.options.locale(), "common.states.loading") : this.error}</small>
    `;
  }
  renderRow(song: number, difficulty: number, context: string) {
    return html`
      ${difficulty <= 4 ? this.field(this.t("chartShort", "Clears"), this.t("editChart", "Edit clears: {chart}").replace("{chart}", context), { song, difficulty })
        : specList([{ label: this.t("chartShort", "Clears"), value: this.format(this.chart(song, difficulty)) }], { numeric: true, split: true })}
      ${specList([{ label: this.t("songShort", "Total"), value: html`<span title=${`${this.t("song", "Song total clears")} / ${context}: ${this.format(this.song(song))}`}>${this.format(this.song(song))}</span>` }], { numeric: true, split: true, className: "song-progress__song-total" })}
    `;
  }
  renderDialogs() {
    const close = () => { this.records = null; this.changed(); };
    return html`${this.records ? html`<dialog class="dialog" aria-labelledby="progress-counts-source" ${modal(close)}>
      <header class="dialog__header"><h2 id="progress-counts-source">${this.t("selectTitle", "Import from saved data")}</h2></header>
      <div class="dialog__body stack">${this.records.length ? collectionList(this.records.map(record => ({ id: record.id, title: this.t("gameSave", "Game save"),
        subtitle: formatDate(this.options.locale(), record.snapshot.savedAt ?? record.importedAt, { year: "always", time: true }), media: icon("description", 24),
        onOpen: () => { try { this.use(record); } catch { this.error = this.t("writeFailed", "Could not save counts"); this.records = null; this.changed(); } },
      }))) : emptyState({ title: this.t("noSaves", "No saved data") })}</div>
      <footer class="dialog__actions"><button class="button button--text" type="button" @click=${close}>${uiText(this.options.locale(), "common.actions.close")}</button></footer>
    </dialog>` : nothing}`;
  }
}
