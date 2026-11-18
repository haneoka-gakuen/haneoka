// L3 — GEB
// Input: A selected result, current goal and a local save or manually entered materials.
// Output: Training plan dialog with an ordered material ledger and score deltas.
// Pos: [Map](../L2-2.md); companion to the team growth comparison.
// Effects/Dependencies: IndexedDB reads, pinned public catalog fetch and cancellable engine scoring.
import { html, nothing } from "lit";
import type { CatalogCost } from "../../lib/catalog-cost-summary";
import { formatDate } from "../../lib/date-format";
import { loadGrowthCatalog, stageDisplay, type GrowthPageData } from "../../lib/growth-catalog";
import { parseSnapshot, saveRecords, type SaveSnapshot } from "../../lib/save-workspace/snapshot";
import { appCall, appSupports, inApp } from "../../lib/app-bridge";
import type { EngineHit, EngineRequest } from "../../lib/team-builder/engine/api";
import { completeResponse } from "../../lib/team-builder/engine/execution";
import {
  planTraining,
  prepareTraining,
  trainingMaterials,
  trainingStock,
  type TrainingPlan,
} from "../../lib/team-builder/training-plan";
import type { TeamBuilder } from "../team-builder";
import { accordion } from "../ui/accordion";
import { iconButton } from "../ui/controls";
import { modal } from "../ui/modal";
import { tileMedia } from "../ui/tile";
import { resultMetric } from "./result-metric";
import type { BuildSettings } from "./types";

interface Source {
  identity: string;
  input: EngineRequest;
  hit: EngineHit;
  settings: BuildSettings;
}

interface TrainingSave {
  id: string;
  label: string;
  savedAt: string | number | null;
  read(): Promise<SaveSnapshot>;
}

const actionLabels = {
  level: "level",
  training: "training",
  awakening: "awakening",
  live: "liveSkill",
  gekisou: "gekisoSkill",
  break: "limitBreak",
} as const;

export class TeamTrainingPlan {
  private source: Source | null = null;
  private catalog: GrowthPageData | null = null;
  private materials: CatalogCost[] = [];
  private records: TrainingSave[] = [];
  private selection = "";
  private manual = new Map<string, number>();
  private materialsOpen = false;
  private remainingOpen = false;
  private loading = false;
  private loadError = false;
  private saveError = false;
  private task: symbol | null = null;
  private stopped = false;
  private error = "";
  private plan: TrainingPlan | null = null;
  private abortLoad: AbortController | null = null;

  constructor(private readonly host: TeamBuilder) {}

  open(source: Source) {
    this.source = source;
    this.selection = "";
    this.manual.clear();
    this.records = [];
    this.catalog = null;
    this.materials = [];
    this.plan = null;
    this.error = "";
    this.stopped = false;
    this.materialsOpen = false;
    this.remainingOpen = false;
    void this.load(source);
  }

  private async load(source: Source) {
    const host = this.host;
    const identity = host.data!.crossServer?.identities[host.server] ?? host.data!.identity;
    this.abortLoad?.abort();
    const abort = (this.abortLoad = new AbortController());
    this.loadError = this.saveError = false;
    this.loading = true;
    host.requestUpdate();
    const [catalog, saves] = await Promise.allSettled([
      loadGrowthCatalog(identity, host.locale, abort.signal),
      this.readSaves(identity.server),
    ]);
    if (this.source !== source || abort.signal.aborted) return;
    if (catalog.status === "fulfilled") {
      this.catalog = catalog.value;
      this.materials = trainingMaterials(source.input, catalog.value);
    } else this.loadError = true;
    if (saves.status === "fulfilled") {
      this.records = saves.value;
    } else this.saveError = true;
    this.selection = this.records.length === 1 ? this.records[0]!.id : this.records.length ? "" : "manual";
    this.materialsOpen = this.selection === "manual";
    this.loading = false;
    host.requestUpdate();
  }

  private async readSaves(server: string): Promise<TrainingSave[]> {
    if (appSupports("saveSnapshotV1")) {
      return (await appCall("gameAccounts", {}))
        .filter((save) => save.server === server)
        .map((save) => ({
          id: save.key, label: save.name || save.profileId, savedAt: save.savedAt,
          read: async () => parseSnapshot((await appCall("saveSnapshot", { key: save.key })).text),
        }));
    }
    return (await saveRecords("list"))
      .filter((record) => record.snapshot.server === server)
      .sort((a, b) => (b.snapshot.savedAt ?? b.importedAt).localeCompare(a.snapshot.savedAt ?? a.importedAt))
      .map((record) => ({ id: record.id, label: record.label, savedAt: record.snapshot.savedAt, read: async () => record.snapshot }));
  }

  sync(identity: string) {
    if (this.source && this.source.identity !== identity) this.close();
  }

  close() {
    this.abortLoad?.abort();
    this.stop();
    this.source = null;
    this.host.requestUpdate();
  }

  stop() {
    if (this.task && this.host.ownsTask(this.task)) {
      this.stopped = true;
      this.host.engine?.cancel();
      this.host.requestUpdate();
    }
  }

  private select(value: string) {
    this.selection = value;
    this.plan = null;
    this.error = "";
    this.stopped = false;
    this.materialsOpen = value === "manual";
    this.host.requestUpdate();
  }

  private setManualAmount(identity: string, field: HTMLInputElement) {
    if (field.value && field.validity.valid) this.manual.set(identity, field.valueAsNumber);
    else this.manual.delete(identity);
    this.plan = null;
    this.error = "";
    this.stopped = false;
    this.host.requestUpdate();
  }

  private async run() {
    const host = this.host;
    const { source, catalog } = this;
    const { engine, master } = host;
    if (!source || !catalog || !engine || !master || !this.selection) return;
    const task = host.acquireTask("team-growth");
    if (!task) return;
    this.task = task;
    this.plan = null;
    this.error = "";
    this.stopped = false;
    host.requestUpdate();
    const active = () => this.source === source && host.ownsTask(task) && !this.stopped;
    const record = this.records.find((r) => r.id === this.selection);
    try {
      const snapshot = await record?.read();
      if (!active()) return;
      if (snapshot && !Array.isArray(snapshot.player._items)) throw new Error("training-save-items");
      const stock = snapshot ? trainingStock(snapshot) : new Map(this.manual);
      const prepared = prepareTraining(source.input, catalog, snapshot);
      const evaluate = async (requests: readonly EngineRequest[]) => {
        if (!active()) throw new DOMException("Cancelled", "AbortError");
        const results = await engine.runBatch(requests);
        if (!active()) throw new DOMException("Cancelled", "AbortError");
        return results.map((result) => {
          if (result.error || !completeResponse(result)) throw new Error(result.error ?? "training-incomplete");
          return result.overall[0] ?? null;
        });
      };
      const plan = await planTraining(
        master,
        prepared,
        catalog,
        stock,
        evaluate,
        (hit) => resultMetric(host, hit, source.settings).value,
        (progress) => {
          if (active()) this.plan = progress;
          host.requestUpdate();
        },
      );
      if (active()) {
        this.plan = plan;
        this.materialsOpen = false;
      }
    } catch (error) {
      if (active()) {
        const code = error instanceof Error ? error.message : "";
        this.error =
          code === "training-save-team" ? "saveTeam" : code === "training-save-items" ? "saveItems" : "failed";
      }
    } finally {
      this.task = null;
      host.releaseTask(task);
      host.requestUpdate();
    }
  }

  render() {
    const { host, source, plan, catalog, selection, materials } = this;
    if (!source) return nothing;
    const t = (key: string) => host.t(`trainingPlan.${key}`, key);
    const number = (value: number, digits = 0) => value.toLocaleString(host.locale, { maximumFractionDigits: digits });
    const title = t("title");
    const busy = this.task !== null;
    const metric = resultMetric(host, plan?.final ?? source.hit, source.settings);
    const gain = plan ? metric.value - resultMetric(host, plan.baseline, source.settings).value : 0;
    const visibleRemaining = materials.filter((item) => plan?.remaining.has(item.identity));
    const selectedSave = this.records.find((record) => record.id === selection);
    const status = this.loading
      ? "loading"
      : this.loadError
        ? "dataFailed"
        : busy
          ? "running"
          : this.error ||
            (this.stopped ? "stopped" : plan?.incomplete ? "partial" : plan && !plan.steps.length ? "empty" : "");
    return html`
      <dialog
        class="dialog tb-team-growth tb-training-plan"
        data-managed-modal
        ${modal(() => this.close())}
        aria-label=${title}
      >
        <header class="row row--between">
          <strong>${title}</strong>
          ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: () => this.close() })}
        </header>
        <div class="tb-team-growth__body">
          <section class="tb-team-growth__results stack">
            <div class="surface stack">
              <h3 class="detail-section-title">${t("order")}</h3>
              <div class="row row--between">
                <span>${metric.label}</span>
                ${
                  plan
                    ? html`
                        <strong>
                          ${number(metric.value - gain, metric.digits)} → ${number(metric.value, metric.digits)}
                          ${metric.unit}
                        </strong>
                      `
                    : nothing
                }
              </div>
              <span role="status" class="supporting-text tb-team-growth__status">
                ${status ? t(status) : nothing}
              </span>
              ${
                plan?.steps.length
                  ? html`
                      <ol class="list tb-training-plan__steps">
                        ${plan.steps.map((step, index) => {
                          const option = host.catalog?.cardOptions(step.kind, step.cardId);
                          const changes = step.changes.map(
                            (change) =>
                              `${host.t(actionLabels[change.action], actionLabels[change.action])} ${stageDisplay(change.action, change.from!)} → ${stageDisplay(change.action, change.to)}`,
                          );
                          return html`
                            <li class="list-item">
                              ${
                                option
                                  ? html`
                                      <span class="list-item__leading tb-suggest__art">${tileMedia(option)}</span>
                                    `
                                  : nothing
                              }
                              <span class="list-item__body">
                                <strong class="list-item__headline">
                                  ${index + 1}. ${host.catalog!.cardName(step.kind, step.cardId)}
                                </strong>
                                ${changes.map(
                                  (change) => html`
                                    <span class="list-item__supporting">${change}</span>
                                  `,
                                )}
                                ${step.costs.map(
                                  (item) => html`
                                    <span class="list-item__supporting">${item.name} ×${number(item.count)}</span>
                                  `,
                                )}
                              </span>
                              <strong class="list-item__trailing tabular">
                                +${number(step.gain, Math.max(metric.digits, 2))}
                              </strong>
                            </li>
                          `;
                        })}
                      </ol>
                    `
                  : nothing
              }
            </div>
            ${
              visibleRemaining.length
                ? accordion({
                    id: "tb-training-remaining",
                    label: t("remaining"),
                    expanded: this.remainingOpen,
                    onExpandedChange: (open) => {
                      this.remainingOpen = open;
                      host.requestUpdate();
                    },
                    content: html`
                      <dl class="spec-list">
                        ${visibleRemaining.map(
                          (item) => html`
                            <div>
                              <dt>${item.name}</dt>
                              <dd>${number(plan!.remaining.get(item.identity)!)}</dd>
                            </div>
                          `,
                        )}
                      </dl>
                    `,
                  })
                : nothing
            }
          </section>
          <aside class="surface stack tb-team-growth__settings is-open">
            <h3 class="detail-section-title">${t("materials")}</h3>
            <label class="stack">
              <span>${t("source")}</span>
              <span class="field">
                <select
                  ?disabled=${this.loading || busy}
                  @change=${(event: Event) => this.select((event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="" disabled ?selected=${!selection}>${t("choose")}</option>
                  ${this.records.map(
                    (record) => html`
                      <option value=${record.id} ?selected=${selection === record.id}>
                        ${record.label}
                        ${
                          this.records.length > 1 && record.savedAt
                            ? ` ${formatDate(host.locale, record.savedAt, { time: true })}`
                            : nothing
                        }
                      </option>
                    `,
                  )}
                  <option value="manual" ?selected=${selection === "manual"}>${t("manual")}</option>
                </select>
              </span>
            </label>
            <span class="supporting-text tb-team-growth__status" role="status">
              ${
                this.saveError
                  ? t("saveFailed")
                  : selectedSave
                    ? selectedSave.savedAt
                      ? formatDate(host.locale, selectedSave.savedAt, { time: true })
                      : t("unknownDate")
                    : selection === "manual"
                      ? t("manualExp")
                      : nothing
              }
            </span>
            <a class="button button--text" href=${inApp() ? `/${host.locale}/account/?section=games` : `/${host.locale}/saves/`}>${t("saves")}</a>
            ${
              selection === "manual" && materials.length
                ? accordion({
                    id: "tb-training-manual",
                    label: t("manual"),
                    expanded: this.materialsOpen,
                    onExpandedChange: (open) => {
                      this.materialsOpen = open;
                      host.requestUpdate();
                    },
                    content: html`
                      <div class="stack">
                        ${materials.map(
                          (item) => html`
                            <label class="stack">
                              <span>${item.name}</span>
                              <span class="field">
                                <input
                                  type="number"
                                  min="0"
                                  max=${Number.MAX_SAFE_INTEGER}
                                  step="1"
                                  placeholder="—"
                                  ?disabled=${busy}
                                  .value=${this.manual.has(item.identity) ? String(this.manual.get(item.identity)) : ""}
                                  @change=${(event: Event) => this.setManualAmount(item.identity, event.currentTarget as HTMLInputElement)}
                                />
                              </span>
                            </label>
                          `,
                        )}
                      </div>
                    `,
                  })
                : nothing
            }
            ${
              this.loadError
                ? html`
                    <button class="button button--tonal" @click=${() => void this.load(source)}>${t("retry")}</button>
                  `
                : busy
                  ? html`
                      <button class="button button--tonal" @click=${() => this.stop()}>
                        ${host.common("common.actions.cancel", "Cancel")}
                      </button>
                    `
                  : html`
                      <button
                        class="button"
                        data-training-run
                        ?disabled=${
                          !catalog || !selection || host.running || (selection === "manual" && !this.manual.size)
                        }
                        @click=${() => void this.run()}
                      >
                        ${t("run")}
                      </button>
                    `
            }
          </aside>
        </div>
      </dialog>
    `;
  }
}
