// L3 — GEB
// Input: 本地历史、云同步状态、目录载荷与 UI 事件。
// Output: 抽卡工作区属性、导入导出和显式云操作。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 管理浏览器生命周期及目录 HTTP；不直接读取游戏凭据。
import type { GachaHistory } from "./gacha-history";
import "./gacha-history";
import { clientText } from "../i18n/client";
import { readPageData } from "../lib/page-data";
import { historyStore, type StoredHistory } from "../lib/gacha-history-store";
import { HistoryCloudSync } from "../lib/gacha-history-cloud-sync";
import {
  HISTORY_BYTES,
  historyBatchViews,
  historyObject,
  historyPoolViews,
  historyBaseTopUpId,
  historyDefaultGemConversion,
  historyOffsetMinutes,
  type HistoryCatalogData,
} from "../lib/gacha-history-data";
import type { GachaHistoryPageData } from "../server/gacha-history-page-data";
import type { GachaHistoryEvents, GachaHistoryImportSource, GachaHistoryConversion } from "../lib/gacha-history-view";
import { fetchJson } from "./shared/catalog";
import { readCompanionHistory } from "../lib/gacha-history-device";
import { downloadBlob } from "../lib/canvas-capture";
import { withUiMarksProjection } from "../lib/ui-marks";
import { formatDate } from "../lib/date-format";
import { appCall, inApp } from "../lib/app-bridge";

class GachaHistoryWorkspace extends HTMLElement {
  private records: StoredHistory[] = [];
  private cloud = new HistoryCloudSync();
  private selected = "";
  private selectedKind = "";
  private catalog?: GachaHistoryPageData;
  private busy = false;
  private error = "";
  private catalogRequests = new Set<string>();
  private catalogErrors = new Map<string, string>();
  private conversion?: GachaHistoryConversion;
  private conversions = new Map<string, GachaHistoryConversion>();
  private controller = new AbortController();
  private usb?: typeof import("@haneoka/game-data-exporter/webusb");
  private get view() {
    return this.querySelector<GachaHistory>("gacha-history")!;
  }
  private t(key: string) {
    return clientText(this.view.locale, `catalog.gachaHistory.${key}`, "");
  }
  private changed = () => {
    void this.reload();
  };
  private cloudChanged = () => {
    this.records = this.cloud.visibleRecords();
    if (!this.records.some((row) => row.key === this.selected)) this.selected = this.records[0]?.key ?? "";
    if (this.isConnected) this.update();
  };
  connectedCallback() {
    this.controller = new AbortController();
    this.catalog = readPageData<GachaHistoryPageData>(this);
    if (import.meta.env.DEV && new URL(location.href).searchParams.get("preview") === "1" && this.catalog) {
      void import("./gacha-history-preview").then(({ mountGachaHistoryPreview }) =>
        mountGachaHistoryPreview(this.view, this.catalog!),
      );
      return;
    }
    this.on("gacha-account-change", ({ accountKey }) => {
      this.selected = accountKey;
      this.selectedKind = "";
      this.error = "";
      this.update();
    });
    this.on("gacha-history-kind-change", ({ historyKind }) => {
      this.selectedKind = historyKind;
      this.update();
    });
    this.on("gacha-cloud-link", ({ accountKey, linked }) => {
      void this.cloud.setLinked(accountKey, linked);
    });
    this.on("gacha-cloud-sync", () => {
      void this.cloud.sync();
    });
    this.on("gacha-cloud-refresh", ({ accountKey }) => {
      void this.cloud.requestRefresh(accountKey);
    });
    this.on("gacha-import-source", ({ source }) => this.source(source));
    this.on("gacha-refresh", ({ accountKey }) => void this.game(accountKey));
    this.on("gacha-catalog-retry", () => {
      void this.loadCatalog();
    });
    this.on("gacha-open-app", () => {
      location.href = "haneoka://gacha-history";
    });
    this.on("gacha-conversion-change", (value) => {
      const previous = this.conversion ?? this.view.currencyConversion;
      const current = this.records.find((row) => row.key === this.selected);
      const server = current?.snapshot.source.server === "jp" ? "jp" : "intl";
      this.conversion =
        previous?.currencyCode !== value.currencyCode
          ? (this.conversions.get(value.currencyCode) ??
            historyDefaultGemConversion(this.catalog?.variants[server], value.currencyCode))
          : value;
      this.conversions.set(this.conversion.currencyCode, this.conversion);
      this.view.currencyConversion = this.conversion;
      try {
        localStorage.setItem(
          "haneoka:gacha-history:conversion",
          JSON.stringify({ ...this.conversion, byCurrency: Object.fromEntries(this.conversions) }),
        );
      } catch {
        /* The current view keeps this choice. */
      }
    });
    this.on("gacha-export", ({ accountKey, batches, historyKind }) => {
      const current = this.records.find((row) => row.key === accountKey);
      const snapshot = current?.histories?.find((row) => row.historyKind === historyKind) ?? current?.snapshot;
      if (!snapshot) return;
      const indexes = new Set(batches.map((row) => Number(row.id.split(":").at(-1))));
      const selection = {
        ...snapshot,
        source: { ...snapshot.source, accountKey: snapshot.source.accountKey ?? accountKey },
        coverage: { ...snapshot.coverage, scope: "selected-records" },
        batches: snapshot.batches.filter((_, index) => indexes.has(index)),
      };
      downloadBlob(
        new Blob([JSON.stringify(selection)], { type: "application/json" }),
        `haneoka-gacha-${snapshot.source.server}.json`,
      );
    });
    historyStore.addEventListener("change", this.changed);
    this.cloud.addEventListener("change", this.cloudChanged);
    void import("@haneoka/game-data-exporter/webusb")
      .then((usb) => {
        this.usb = usb;
        this.update();
      })
      .catch(() => {});
    try {
      const stored = historyObject(JSON.parse(localStorage.getItem("haneoka:gacha-history:conversion") ?? "null"));
      const price = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      if (["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].includes(String(stored.currencyCode)))
        this.conversion = {
          currencyCode: String(stored.currencyCode),
          freeUnitGemPrice: price(stored.freeUnitGemPrice) ?? 0,
          paidUnitGemPrice: price(stored.paidUnitGemPrice ?? stored.unitGemPrice),
        };
      if (this.conversion) this.conversions.set(this.conversion.currencyCode, this.conversion);
      for (const [currencyCode, value] of Object.entries(historyObject(stored.byCurrency))) {
        if (!["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].includes(currencyCode)) continue;
        const row = historyObject(value);
        this.conversions.set(currencyCode, {
          currencyCode,
          freeUnitGemPrice: price(row.freeUnitGemPrice) ?? 0,
          paidUnitGemPrice: price(row.paidUnitGemPrice),
        });
      }
      if (this.conversion) this.conversion = this.conversions.get(this.conversion.currencyCode);
    } catch {
      /* Start with an empty conversion amount. */
    }
    void this.reload().then(async () => {
      if (!this.isConnected) return;
      this.cloud.start();
      // History the app's save page read from the game server.
      if (!inApp()) return;
      const pending = await appCall("pendingGachaHistory", {}).catch(() => null);
      if (pending?.files.length)
        await this.importFiles(
          pending.files.map((file) => new File([file.text], file.name, { type: "application/json" })),
          true,
        );
    });
  }
  disconnectedCallback() {
    this.controller.abort();
    historyStore.removeEventListener("change", this.changed);
    this.cloud.stop();
    this.cloud.removeEventListener("change", this.cloudChanged);
  }
  private on<K extends keyof GachaHistoryEvents>(type: K, callback: (detail: GachaHistoryEvents[K]["detail"]) => void) {
    this.addEventListener(type, ((event: GachaHistoryEvents[K]) => callback(event.detail)) as EventListener, {
      signal: this.controller.signal,
    });
  }
  private async reload() {
    try {
      this.cloud.setLocal(await historyStore.list());
      this.records = this.cloud.visibleRecords();
      if (!this.records.some((row) => row.key === this.selected)) this.selected = this.records[0]?.key ?? "";
    } catch {
      this.error = this.t("errorImportInvalid");
    }
    if (this.isConnected) this.update();
  }
  private source(source: GachaHistoryImportSource) {
    if (source === "saved") {
      const select = this.view.querySelector<HTMLElement & { showPicker(): void }>("md-outlined-select");
      select?.focus();
      select?.showPicker();
      return;
    }
    if (source === "adb") {
      void this.adb();
      return;
    }
    if (source === "game") {
      void this.game();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.addEventListener(
      "change",
      () => {
        if (input.files?.length) void this.importFiles([...input.files]);
      },
      { once: true },
    );
    input.click();
  }
  private async importFiles(files: readonly File[], companion = false) {
    this.busy = true;
    this.error = "";
    this.update();
    try {
      if (files.length > 128 || files.reduce((sum, file) => sum + file.size, 0) > HISTORY_BYTES * 4)
        throw new Error("history_import_invalid");
      for (const file of files) {
        if (!file.size || file.size > HISTORY_BYTES * 2) throw new Error("history_import_invalid");
        const record = await historyStore.import(
          JSON.parse(await file.text()),
          companion ? file.name.replace(/\.json$/u, "") : undefined,
        );
        this.selected = record.key;
      }
      await this.reload();
      void this.cloud.sync();
    } catch {
      this.error = this.t("errorImportInvalid");
    } finally {
      this.busy = false;
      if (this.isConnected) this.update();
    }
  }
  private async game(key?: string) {
    if (this.busy) return;
    try {
      const result = await appCall("gachaHistory", key ? { key } : {});
      if (result?.files.length)
        await this.importFiles(
          result.files.map((file) => new File([file.text], file.name, { type: "application/json" })),
          true,
        );
    } catch {
      this.error = this.t("errorImportInvalid");
      if (this.isConnected) this.update();
    }
  }
  private async adb() {
    if (!this.usb || this.busy) return;
    this.busy = true;
    this.error = "";
    this.update();
    try {
      const files = await readCompanionHistory(this.usb.createUsbReader(), this.controller.signal);
      if (files) await this.importFiles(files, true);
    } catch {
      if (!this.controller.signal.aborted) this.error = this.t("errorImportInvalid");
    } finally {
      this.busy = false;
      if (this.isConnected) this.update();
    }
  }
  private async loadCatalog() {
    const current = this.records.find((row) => row.key === this.selected);
    const server = current?.snapshot.source.server === "jp" ? "jp" : "intl";
    if (this.catalogRequests.has(server)) return;
    this.catalogRequests.add(server);
    this.catalogErrors.delete(server);
    this.update();
    try {
      const pin = historyObject(
        await fetchJson<unknown>(`/api/v1/servers/${server}/release?projection=identity`, {
          signal: this.controller.signal,
        }),
      );
      if (pin.server !== server || typeof pin.releaseId !== "string" || !/^r-[a-f0-9]{20}$/u.test(pin.releaseId))
        throw new Error("history_catalog");
      const [gachaValue, cards, supports, items, marks, baseTopUp] = await Promise.all(
        ["gacha", "cards", "support-cards", "items", "ui-marks", `shop/${historyBaseTopUpId(server)}`].map((name) => {
          const value = fetchJson<unknown>(
            withUiMarksProjection(`/api/v1/servers/${server}/${name}?release=${pin.releaseId}`),
            {
              signal: this.controller.signal,
            },
          );
          return name.startsWith("shop/") ? value.catch(() => undefined) : value;
        }),
      );
      const gacha = historyObject(gachaValue),
        metadata = historyObject(gacha.history);
      if (metadata.schema !== "haneoka-gacha-history-data-v1") throw new Error("history_catalog");
      this.catalog = {
        schema: "haneoka-gacha-history-page-v1",
        variants: {
          ...this.catalog?.variants,
          [server]: {
            server,
            exchanges: historyObject(metadata.exchanges),
            metadata,
            pools: historyObject(gacha.entries),
            cards: historyObject(cards),
            supports: historyObject(supports),
            items: historyObject(historyObject(items).items),
            marks: historyObject(marks),
            baseTopUp: historyObject(baseTopUp),
          },
        },
      };
    } catch {
      this.catalogErrors.set(server, this.t("errorCatalogUnavailable"));
    } finally {
      this.catalogRequests.delete(server);
      if (this.isConnected) this.update();
    }
  }
  private update() {
    const view = this.view;
    if (!view) return;
    const current = this.records.find((row) => row.key === this.selected),
      snapshot = current?.histories?.find((row) => row.historyKind === this.selectedKind) ?? current?.snapshot;
    const server = snapshot?.source.server === "jp" ? "jp" : "intl";
    const source = this.catalog?.variants[server];
    const catalog: HistoryCatalogData | undefined =
      source?.metadata.schema === "haneoka-gacha-history-data-v1" ? source : undefined;
    view.accounts = this.records.map((row) => ({
      key: row.key,
      server: row.snapshot.source.server,
      offsetMinutes: historyOffsetMinutes(row.snapshot.source.server),
      serverLabel: this.t(
        { jp: "regionJp", "global-hmt": "regionHmt", "global-en": "regionEn", "global-kr": "regionKo" }[
          row.snapshot.source.server
        ],
      ),
      label: formatDate(view.locale, row.snapshot.queriedAt, { time: true }),
    }));
    view.selectedAccountKey = this.selected;
    view.historyKinds = (current?.histories ?? (snapshot ? [snapshot] : [])).map((row) => row.historyKind);
    view.selectedHistoryKind = snapshot?.historyKind ?? "";
    const currencyCode =
      snapshot?.source.server === "jp"
        ? "JPY"
        : snapshot?.source.server === "global-en"
          ? "USD"
          : snapshot?.source.server === "global-kr"
            ? "KRW"
            : "TWD";
    view.currencyConversion = this.conversion ?? historyDefaultGemConversion(catalog, currencyCode);
    view.pools = catalog
      ? historyPoolViews(
          catalog,
          view.locale,
          (key) => clientText(view.locale, `catalog.recruitments.types.${key}`, key),
          snapshot,
        )
      : [];
    view.batches = snapshot ? historyBatchViews(snapshot, this.selected, catalog, view.locale, this.t("unknown")) : [];
    view.historyLoaded = !!snapshot;
    view.busy = this.busy;
    view.error = this.error;
    view.canImport = true;
    view.canExport = !!snapshot;
    view.canRefresh = inApp() && !!snapshot;
    view.importSources = [
      ...(inApp() ? ["game" as const] : []),
      ...(this.records.length ? ["saved" as const] : []),
      "files",
      ...(this.usb?.usbAvailable() ? ["adb" as const] : []),
    ];
    view.showAppLink = !inApp();
    view.catalogLoading = this.catalogRequests.has(server);
    view.catalogError =
      this.catalogErrors.get(server) || (snapshot?.batches.length && !catalog ? this.t("errorCatalogUnavailable") : "");
    view.canRetryCatalog = true;
    Object.assign(view, {
      cloudSignedIn: !!this.cloud.ownerId,
      cloudBusy: this.cloud.busy,
      cloudLinked: this.cloud.isLinked(this.selected),
      cloudRefreshPending: this.cloud.refreshPending(this.selected),
      cloudErrorCode: this.cloud.errorCode,
    });
  }
}
if (!customElements.get("gacha-history-workspace"))
  customElements.define("gacha-history-workspace", GachaHistoryWorkspace);
