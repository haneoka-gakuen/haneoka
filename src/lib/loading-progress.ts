/**
 * Small, framework-neutral loading reporter.
 *
 * The reporter deliberately knows nothing about Lit, Astro, fetch, or a
 * renderer. The browser coordinator below is the shell adapter: it aggregates
 * live reporters and paints the document-local host rendered by AppShell.
 */
import { clientText } from "../i18n/client";

export type LoadingScope = "route" | "owner";
export type LoadingByteBasis = "decoded" | "identity";

export interface LoadingMetrics {
  stageLabel?: string;
  completedFiles?: number;
  totalFiles?: number;
  loadedBytes?: number;
  totalBytes?: number;
  byteBasis?: LoadingByteBasis;
  /** Processed preparation tasks include failed work; they are not successful files. */
  processedTasks?: number;
  totalTasks?: number;
  countLabel?: string;
}

export interface LoadingReporter {
  update(metrics: LoadingMetrics): void;
  finish(): void;
  fail(error?: unknown): void;
  cancel(): void;
}

export interface BeginLoadingOptions {
  signal?: AbortSignal;
  scope?: LoadingScope;
}

interface Task {
  id: string;
  label: string;
  scope: LoadingScope;
  routeEpoch?: number;
  signal?: AbortSignal;
  metrics: LoadingMetrics;
  state: "active" | "failed";
  abortListener?: () => void;
  failureTimer?: number;
}

interface RouteRecord {
  epoch: number;
  signal?: AbortSignal;
  to: string;
  swapped: boolean;
  abortListener?: () => void;
}

interface ProgressState {
  active: Task[];
  failed: Task[];
  indeterminate: boolean;
  determinateValue?: number;
  label: string;
  stageLabel?: string;
  loadedBytes?: number;
  totalBytes?: number;
  byteBasis?: LoadingByteBasis;
  completedFiles?: number;
  totalFiles?: number;
  processedTasks?: number;
  totalTasks?: number;
  countLabel?: string;
}

type ProgressDocumentEvent = Event & {
  signal?: AbortSignal;
  to?: URL | string;
  newDocument?: Document;
};

type LoadingWindow = Window & {
  __haneokaLoadingProgressCoordinator?: LoadingCoordinator;
};

const COORDINATOR_KEY = "__haneokaLoadingProgressCoordinator";
const FAILURE_DISPLAY_MS = 1400;
const STATUS_THROTTLE_MS = 450;
let nextTaskId = 0;

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cleanMetrics(metrics: LoadingMetrics): LoadingMetrics {
  const clean: LoadingMetrics = {};
  if (typeof metrics.stageLabel === "string" && metrics.stageLabel.trim()) clean.stageLabel = metrics.stageLabel;
  if (finite(metrics.completedFiles)) clean.completedFiles = metrics.completedFiles;
  if (finite(metrics.totalFiles)) clean.totalFiles = metrics.totalFiles;
  if (finite(metrics.loadedBytes)) clean.loadedBytes = metrics.loadedBytes;
  if (finite(metrics.totalBytes)) clean.totalBytes = metrics.totalBytes;
  if (metrics.byteBasis === "decoded" || metrics.byteBasis === "identity") clean.byteBasis = metrics.byteBasis;
  if (finite(metrics.processedTasks)) clean.processedTasks = metrics.processedTasks;
  if (finite(metrics.totalTasks)) clean.totalTasks = metrics.totalTasks;
  if (typeof metrics.countLabel === "string" && metrics.countLabel.trim()) clean.countLabel = metrics.countLabel;
  return clean;
}

function identity(value: URL | string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(String(value), location.href);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return String(value).split("#", 1)[0];
  }
}

function localeFor(document: Document = globalThis.document): string {
  return document?.documentElement?.dataset.locale || document?.documentElement?.lang?.split("-")[0] || "en";
}

function formatBytes(value: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  const scaled = value / 1024 ** index;
  try {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 1 : 0 }).format(scaled)} ${units[index]}`;
  } catch {
    return `${Math.round(scaled)} ${units[index]}`;
  }
}

function formatFileCount(completed: number, total: number | undefined, locale: string): string {
  const word = clientText(
    locale,
    completed === 1 ? "common.loading.file" : "common.loading.files",
    completed === 1 ? "file" : "files",
  );
  const count = total === undefined ? `${completed} ${word}` : `${completed} / ${total} ${word}`;
  return count;
}

function noopReporter(): LoadingReporter {
  return { update() {}, finish() {}, fail() {}, cancel() {} };
}

class LoadingCoordinator {
  private readonly tasks = new Map<string, Task>();
  private installed = false;
  private routeEpoch = 0;
  private route?: RouteRecord;
  private statusTimer?: number;
  private announcedStatus = "";
  private pendingStatus = "";
  private upgradePromise?: Promise<void>;
  private readonly onBeforePreparation = (event: Event) => this.beforePreparation(event as ProgressDocumentEvent);
  private readonly onBeforeSwap = (event: Event) => this.beforeSwap(event as ProgressDocumentEvent);
  private readonly onAfterSwap = () => this.render();
  private readonly onPageLoad = () => this.pageLoad();

  install(): void {
    if (this.installed || typeof document === "undefined") return;
    this.installed = true;
    document.addEventListener("astro:before-preparation", this.onBeforePreparation);
    document.addEventListener("astro:before-swap", this.onBeforeSwap);
    document.addEventListener("astro:after-swap", this.onAfterSwap);
    document.addEventListener("astro:page-load", this.onPageLoad);
    this.ensureUpgrade(document);
    this.render();
  }

  /** Explicit teardown keeps repeated Astro script execution from duplicating listeners. */
  dispose(): void {
    if (!this.installed || typeof document === "undefined") return;
    document.removeEventListener("astro:before-preparation", this.onBeforePreparation);
    document.removeEventListener("astro:before-swap", this.onBeforeSwap);
    document.removeEventListener("astro:after-swap", this.onAfterSwap);
    document.removeEventListener("astro:page-load", this.onPageLoad);
    this.installed = false;
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    for (const task of [...this.tasks.values()]) this.remove(task);
    this.announcedStatus = "";
    this.pendingStatus = "";
    if (this.route?.signal && this.route.abortListener)
      this.route.signal.removeEventListener("abort", this.route.abortListener);
    this.route = undefined;
  }

  begin(label: string, options: BeginLoadingOptions = {}): LoadingReporter {
    if (typeof document === "undefined") return noopReporter();
    this.install();
    const scope = options.scope || "owner";
    const signal = options.signal || (scope === "route" ? this.route?.signal : undefined);
    const task: Task = {
      id: `loading-${++nextTaskId}`,
      label: label.trim() || "Loading",
      scope,
      routeEpoch: scope === "route" ? this.route?.epoch : undefined,
      signal,
      metrics: {},
      state: "active",
    };
    this.tasks.set(task.id, task);
    if (signal?.aborted) {
      this.remove(task);
      return this.reporterFor(task);
    }
    if (signal) {
      task.abortListener = () => this.cancelTask(task);
      signal.addEventListener("abort", task.abortListener, { once: true });
    }
    this.render();
    return this.reporterFor(task);
  }

  private reporterFor(task: Task): LoadingReporter {
    let live = true;
    const present = () => live && this.tasks.get(task.id) === task;
    const current = () => live && this.tasks.get(task.id) === task && task.state === "active";
    return {
      update: (metrics) => {
        if (!current()) return;
        task.metrics = { ...task.metrics, ...cleanMetrics(metrics) };
        this.render();
      },
      finish: () => {
        if (!current()) return;
        live = false;
        this.remove(task);
        this.render();
      },
      fail: () => {
        if (!current()) return;
        task.state = "failed";
        task.failureTimer = window.setTimeout(() => {
          if (this.tasks.get(task.id) === task) {
            this.remove(task);
            this.render();
          }
        }, FAILURE_DISPLAY_MS);
        this.render();
      },
      cancel: () => {
        if (!present()) return;
        live = false;
        this.cancelTask(task);
      },
    };
  }

  private remove(task: Task): void {
    if (task.failureTimer) window.clearTimeout(task.failureTimer);
    if (task.signal && task.abortListener) task.signal.removeEventListener("abort", task.abortListener);
    if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
  }

  private cancelTask(task: Task): void {
    this.remove(task);
    this.render();
  }

  private cancelRoute(record: RouteRecord): void {
    if (this.route !== record) return;
    if (record.signal && record.abortListener) record.signal.removeEventListener("abort", record.abortListener);
    for (const task of [...this.tasks.values()]) {
      if (task.scope === "route" && task.routeEpoch === record.epoch) this.remove(task);
    }
    this.route = undefined;
    this.render();
  }

  private beforePreparation(event: ProgressDocumentEvent): void {
    if (this.route) this.cancelRoute(this.route);
    const record: RouteRecord = {
      epoch: ++this.routeEpoch,
      signal: event.signal,
      to: identity(event.to),
      swapped: false,
    };
    this.route = record;
    if (event.signal?.aborted) {
      this.cancelRoute(record);
      return;
    }
    record.abortListener = () => this.cancelRoute(record);
    event.signal?.addEventListener("abort", record.abortListener, { once: true });
    this.begin(this.loadingLabel(), { signal: event.signal, scope: "route" });
    this.render();
  }

  private beforeSwap(event: ProgressDocumentEvent): void {
    const next = event.newDocument;
    if (!next || !this.route || this.route.signal?.aborted) return;
    // The fetched document may have redirected to a localized/canonical URL.
    // Completion belongs to the address actually being committed.
    this.route.to = identity(event.to) || this.route.to;
    this.route.swapped = true;
    this.renderInto(next, this.snapshot());
  }

  private pageLoad(): void {
    const record = this.route;
    if (!record || record.signal?.aborted || !record.swapped) return;
    if (record.to && record.to !== identity(location.href)) return;
    for (const task of [...this.tasks.values()]) {
      if (task.scope === "route" && task.routeEpoch === record.epoch) this.remove(task);
    }
    if (record.signal && record.abortListener) record.signal.removeEventListener("abort", record.abortListener);
    this.route = undefined;
    this.render();
  }

  private loadingLabel(): string {
    const locale = localeFor();
    return clientText(locale, "common.states.loading", "Loading");
  }

  private snapshot(): ProgressState {
    const active = [...this.tasks.values()].filter((task) => task.state === "active");
    const failed = [...this.tasks.values()].filter((task) => task.state === "failed");
    const first = active[0] || failed[0];
    if (!first) {
      return { active, failed, indeterminate: false, label: "" };
    }

    const byteBases = new Set(
      active
        .filter((task) => finite(task.metrics.loadedBytes) && task.metrics.byteBasis)
        .map((task) => task.metrics.byteBasis),
    );
    const bytesComplete =
      active.length > 0 &&
      byteBases.size === 1 &&
      active.every(
        (task) =>
          finite(task.metrics.loadedBytes) &&
          finite(task.metrics.totalBytes) &&
          task.metrics.byteBasis === [...byteBases][0],
      );
    const filesComplete =
      active.length > 0 &&
      active.every((task) => finite(task.metrics.completedFiles) && finite(task.metrics.totalFiles));
    const taskLabels = new Set(
      active.filter((task) => finite(task.metrics.processedTasks)).map((task) => task.metrics.countLabel),
    );
    const tasksComplete =
      active.length > 0 &&
      taskLabels.size === 1 &&
      active.every((task) =>
        finite(task.metrics.processedTasks) && finite(task.metrics.totalTasks) &&
        task.metrics.totalTasks > 0 && task.metrics.processedTasks <= task.metrics.totalTasks);
    const processedTasks = taskLabels.size === 1
      ? active.reduce((sum, task) => sum + (task.metrics.processedTasks || 0), 0)
      : undefined;
    const totalTasks = tasksComplete ? active.reduce((sum, task) => sum + task.metrics.totalTasks!, 0) : undefined;
    const countLabel = taskLabels.size === 1 ? [...taskLabels][0] : undefined;
    const canDetermine = bytesComplete || filesComplete || tasksComplete;
    const loadedBytes =
      byteBases.size === 1
        ? active.reduce(
            (sum, task) => sum + (task.metrics.byteBasis === [...byteBases][0] ? task.metrics.loadedBytes || 0 : 0),
            0,
          )
        : undefined;
    const totalBytes = bytesComplete
      ? active.reduce((sum, task) => sum + (task.metrics.totalBytes || 0), 0)
      : undefined;
    const completedFiles = active.some((task) => finite(task.metrics.completedFiles))
      ? active.reduce((sum, task) => sum + (task.metrics.completedFiles || 0), 0)
      : undefined;
    const totalFiles = filesComplete
      ? active.reduce((sum, task) => sum + (task.metrics.totalFiles || 0), 0)
      : undefined;
    const determinateValue = canDetermine
      ? tasksComplete
        ? processedTasks! / totalTasks!
        : bytesComplete
          ? totalBytes
            ? Math.min(1, loadedBytes! / totalBytes)
            : 0
          : totalFiles
            ? Math.min(1, completedFiles! / totalFiles)
            : 0
      : undefined;
    const stageLabel = active.find((task) => task.metrics.stageLabel)?.metrics.stageLabel;
    return {
      active,
      failed,
      indeterminate: active.length > 0 && !canDetermine,
      determinateValue,
      label: first.label,
      stageLabel,
      loadedBytes,
      totalBytes,
      byteBasis: byteBases.size === 1 ? [...byteBases][0] : undefined,
      completedFiles,
      totalFiles,
      processedTasks,
      totalTasks,
      countLabel,
    };
  }

  private statusText(state: ProgressState, document: Document): string {
    const locale = localeFor(document);
    if (state.failed.length && !state.active.length)
      return `${state.label} · ${clientText(locale, "common.loading.failed", "Loading failed")}`;
    const label = state.stageLabel || state.label;
    if (state.processedTasks !== undefined) {
      const count = state.totalTasks === undefined
        ? String(state.processedTasks) : `${state.processedTasks} / ${state.totalTasks}`;
      return `${label} · ${count} ${state.countLabel || clientText(locale, "story.playback.preparationTasks", "preparation tasks")}`;
    }
    if (state.loadedBytes !== undefined) {
      const bytes =
        state.totalBytes === undefined
          ? formatBytes(state.loadedBytes, locale)
          : `${formatBytes(state.loadedBytes, locale)} / ${formatBytes(state.totalBytes, locale)}`;
      return `${label} · ${bytes}`;
    }
    if (state.completedFiles !== undefined) {
      return `${label} · ${formatFileCount(state.completedFiles, state.totalFiles, locale)}`;
    }
    return label;
  }

  private snapshotVisible(state: ProgressState): boolean {
    return state.active.length > 0 || state.failed.length > 0;
  }

  private render(): void {
    if (typeof document === "undefined") return;
    this.ensureUpgrade(document);
    this.renderInto(document, this.snapshot(), true);
  }

  private renderInto(document: Document, state: ProgressState, announce = false): void {
    const host = document.querySelector<HTMLElement>("[data-page-progress]");
    if (!host) return;
    const visible = this.snapshotVisible(state);
    host.dataset.pageProgressActive = String(visible);
    host.dataset.pageProgressIndeterminate = String(state.indeterminate || !state.active.length);
    host.setAttribute("aria-hidden", String(!visible));
    const progress = host.querySelector<HTMLElement>("[data-page-progress-control]") as
      (HTMLElement & { indeterminate?: boolean; value?: number }) | null;
    const fallback = host.querySelector<HTMLElement>("[data-page-progress-fallback]");
    if (progress) {
      progress.toggleAttribute("indeterminate", state.indeterminate || !state.active.length);
      if (state.determinateValue === undefined) progress.removeAttribute("value");
      else progress.setAttribute("value", String(state.determinateValue));
      if ("indeterminate" in progress) progress.indeterminate = state.indeterminate || !state.active.length;
      if (state.determinateValue !== undefined && "value" in progress) progress.value = state.determinateValue;
    }
    if (fallback) fallback.style.setProperty("--page-progress-scale", String(state.determinateValue ?? 0.38));
    const status = host.querySelector<HTMLElement>("[data-page-progress-status]");
    if (status) {
      const text = visible ? this.statusText(state, document) : "";
      if (announce) this.announceStatus(status, text);
      else status.textContent = text;
    }
  }

  private announceStatus(status: HTMLElement, text: string): void {
    if (!text) {
      if (this.statusTimer) window.clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
      this.announcedStatus = "";
      this.pendingStatus = "";
      status.textContent = "";
      return;
    }
    if (text === this.announcedStatus) {
      status.textContent = text;
      return;
    }
    this.pendingStatus = text;
    if (!this.announcedStatus || !this.statusTimer) {
      status.textContent = text;
      this.announcedStatus = text;
      this.pendingStatus = "";
      if (this.statusTimer) window.clearTimeout(this.statusTimer);
      this.statusTimer = window.setTimeout(() => {
        this.statusTimer = undefined;
        if (this.pendingStatus) {
          const current = document.querySelector<HTMLElement>("[data-page-progress-status]");
          if (current) current.textContent = this.pendingStatus;
          this.announcedStatus = this.pendingStatus;
          this.pendingStatus = "";
        }
      }, STATUS_THROTTLE_MS);
    }
  }

  private ensureUpgrade(document: Document): void {
    if (typeof customElements === "undefined") return;
    const mark = (target: Document) => {
      if (!customElements.get("md-linear-progress")) return;
      target.querySelectorAll<HTMLElement>("[data-page-progress]").forEach((host) => {
        host.dataset.pageProgressMd3 = "true";
        prepareMaterialProgress(host.querySelector<HTMLElement>("[data-page-progress-control]") ?? undefined);
      });
    };
    if (customElements.get("md-linear-progress")) {
      mark(document);
      return;
    }
    if (!this.upgradePromise) {
      this.upgradePromise = import("@material/web/progress/linear-progress.js")
        .then(() => customElements.whenDefined("md-linear-progress"))
        .then(() => undefined)
        .catch(() => undefined);
    }
    void this.upgradePromise.then(() => mark(document));
  }
}

function coordinator(): LoadingCoordinator | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return undefined;
  const host = window as LoadingWindow;
  if (!host[COORDINATOR_KEY]) host[COORDINATOR_KEY] = new LoadingCoordinator();
  return host[COORDINATOR_KEY];
}

const motionPrepared = new WeakSet<HTMLElement>();

/** Keep the native Material indicator and its indeterminate semantics when motion is reduced. */
export function prepareMaterialProgress(element: Element | undefined): void {
  const control = element as HTMLElement | undefined;
  if (!control || !["md-linear-progress", "md-circular-progress"].includes(control.localName) || typeof customElements === "undefined" || motionPrepared.has(control)) return;
  motionPrepared.add(control);
  void customElements.whenDefined(control.localName).then(async () => {
    await (control as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
    const root = control.shadowRoot;
    if (!root) { motionPrepared.delete(control); return; }
    const style = document.createElement("style");
    style.textContent = `@media (prefers-reduced-motion: reduce) {
      .progress, .spinner, .circle, .bar, .bar-inner, .dots, .active-track, .inactive-track {
        animation: none !important;
        transition: none !important;
      }
      .indeterminate .primary-bar { inset-inline-start: 0 !important; width: 38% !important; transform: none !important; }
      .indeterminate .secondary-bar { display: none !important; }
      .indeterminate .bar-inner { transform: none !important; }
    }`;
    root.append(style);
  });
}

export function installLoadingProgress(): void {
  coordinator()?.install();
}

export function beginLoading(label: string, options: BeginLoadingOptions = {}): LoadingReporter {
  return coordinator()?.begin(label, options) || noopReporter();
}
