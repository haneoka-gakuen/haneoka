// L3 — GEB
// Input: Accepted result sessions with explicit task, scoring and growth sources.
// Output: Three retained candidates with shared metric rows and a mobile baseline/candidate view.
// Pos: [Map](../L2-2.md); page-local comparison, never persisted in Box or PtJob.
// Effects/Dependencies: Native dialog; no engine requests or changes to ranking.
import { html, nothing } from "lit";
import type { EngineHit, EngineRequest, SongResult } from "../../lib/team-builder/engine/api";
import { canonical } from "../../lib/team-builder/pt-recommendation";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";
import { snackbar } from "../../lib/snackbar";
import { modal } from "../ui/modal";
import { iconButton, inputChip } from "../ui/controls";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { resultRequest, resultSettings, usesPtResults, manualResultSource, resultOrderIndex } from "./score-goal";
import { manualResultHit } from "./manual-results";
import { resultMetric, type ResultMetric } from "./result-metric";

export interface ComparisonEntry {
  id: string;
  source: string;
  hit: EngineHit;
  settings: BuildSettings;
  input: EngineRequest;
  conditions: string;
  metric: ResultMetric;
  listed: boolean;
  proven: boolean;
  placements?: number[];
  selectedOrder?: number;
}
export function formationDifference(base: ComparisonEntry, candidate: ComparisonEntry) {
  const a = base.hit,
    b = candidate.hit;
  const replacements = (before: (string | null)[], after: (string | null)[]) =>
    after.filter((key) => key && !before.includes(key)).length;
  const binding = new Map(a.members.map((key, index) => [key, a.snaps[index] ?? null]));
  const growth = (entry: ComparisonEntry, kind: "members" | "snaps", key: string) =>
    entry.input[kind].find((row) => row.key === key);
  return {
    members: replacements(a.members, b.members),
    snaps: replacements(a.snaps, b.snaps),
    bindings: b.members.filter((key, index) => binding.has(key) && binding.get(key) !== (b.snaps[index] ?? null))
      .length,
    leader: a.members[0] !== b.members[0],
    growth: (["members", "snaps"] as const).reduce(
      (count, kind) =>
        count +
        b[kind].filter(
          (key) =>
            key &&
            a[kind].includes(key) &&
            canonical(growth(base, kind, key)) !== canonical(growth(candidate, kind, key)),
        ).length,
      0,
    ),
  };
}
export function metricDelta(base: ComparisonEntry, candidate: ComparisonEntry) {
  if (
    base.conditions !== candidate.conditions ||
    base.metric.id !== candidate.metric.id ||
    base.metric.unit !== candidate.metric.unit
  )
    return null;
  const absolute = candidate.metric.value - base.metric.value;
  return {
    absolute,
    relative: base.metric.value > 0 && candidate.metric.relative ? (absolute / base.metric.value) * 100 : null,
  };
}
function entryId(hit: EngineHit, source: string, input: EngineRequest, session: string, settings: BuildSettings, selectedOrder?: number) {
  const growth = [
    hit.members.map((key) => input.members.find((row) => row.key === key)),
    hit.snaps.map((key) => input.snaps.find((row) => row.key === key)),
  ];
  return canonical([session, source, settings.route, settings.measure, hit.song, hit.members, hit.snaps, growth, selectedOrder]);
}
function entry(
  host: TeamBuilder,
  hit: EngineHit,
  source: string,
  result: Pick<SongResult, "proven" | "placements">,
  input: EngineRequest,
  session: string,
  settings = resultSettings(host, hit),
): ComparisonEntry {
  const goal = { ...input.goal } as Record<string, unknown>;
  if (!hit.aggregate) delete goal.songs;
  const identity = hit.song ? host.catalog!.songIdentity(hit.song.songId) : host.data!.identity;
  const selectedOrder = hit.score?.orders.length ? resultOrderIndex(host, hit) : undefined;
  return {
    id: entryId(hit, source, input, session, settings, selectedOrder),
    source,
    hit: structuredClone(hit),
    settings: structuredClone(settings),
    input,
    conditions: canonical([
      identity,
      hit.song,
      goal,
      input.player,
      input.songRules,
      input.aggregation,
      input.unknownPolicy,
      result.placements,
      ...(goal.kind === "event" || goal.kind === "plan" ? [settings.route, settings.measure, settings.boosts,
        settings.challengePoints, usesPtResults(host) ? host.pt.job?.cycle : settings.ptCycle] : []),
    ]),
    metric: resultMetric(host, hit, settings),
    listed: true,
    proven: result.proven,
    placements: result.placements?.slice(),
    selectedOrder,
  };
}
export class ResultComparison {
  session = "";
  private scope = "";
  items: ComparisonEntry[] = [];
  baseline = "";
  candidate = "";
  open = false;
  sync(host: TeamBuilder) {
    const pt = usesPtResults(host),
      session = pt ? (host.pt.job?.id ?? "") : host.resultSession;
    const scope = canonical([host.snapshot?.owner, host.data?.identity, host.data?.crossServer?.identities]);
    if (scope !== this.scope) {
      this.items = [];
    } else if (session !== this.session) {
      this.items = this.items.filter((item) => item.source === "manual");
    }
    if (session !== this.session || scope !== this.scope) {
      this.session = session;
      this.scope = scope;
      if (!this.items.some((item) => item.id === this.baseline)) this.baseline = this.items[0]?.id ?? "";
      this.candidate = "";
      this.open = false;
    }
    if (!this.items.length) return;
    const all = this.sources(host);
    this.items = this.items.map((item) => all.find((next) => next.id === item.id) ?? { ...item, listed: false });
  }
  private sources(host: TeamBuilder): ComparisonEntry[] {
    const identity = (source: string, hit: EngineHit) => canonical([source, hit.song, hit.members, hit.snaps]);
    const selected = new Set(this.items.map((item) => identity(item.source, item.hit)));
    if (usesPtResults(host)) {
      const job = host.pt.job;
      return job
        ? job.tasks.flatMap(
            (task) =>
              task.result?.hits
                .filter((hit) => selected.has(identity(`${task.route}:${task.measure}`, hit)))
                .map((hit) =>
                  entry(
                    host,
                    hit,
                    `${task.route}:${task.measure}`,
                    task.result!,
                    job.request,
                    job.id,
                    resultSettings(host, hit, task),
                  ),
                ) ?? [],
          )
        : [];
    }
    const challenge = host.results?.cpChallenge;
    const input = challenge ? resultRequest(host, challenge) : null;
    const converted = challenge && input && selected.has(identity("cp-challenge", challenge))
      ? [entry(host, challenge, "cp-challenge", { proven: true }, input, host.resultSession)] : [];
    const manual = host.manualResultsFor === host.manualContext() ? (host.manualResults ?? [])
      .map(manualResultHit)
      .filter((hit) => selected.has(identity("manual", hit)))
      .map((hit) => {
        const source = manualResultSource(hit)!;
        return entry(host, hit, "manual", { proven: false }, source.input, source.session, source.settings);
      }) : [];
    return [...manual, ...converted, ...(host.resultInputs ? (host.results?.results.flatMap((result) =>
          result.hits
            .filter((hit) => selected.has(identity("build", hit)))
            .map((hit) => entry(host, hit, "build", result, host.resultInputs!, host.resultSession)),
        ) ?? []) : [])];
  }
  private source(host: TeamBuilder, hit: EngineHit): {
    input: EngineRequest; settings: BuildSettings; source: string; session?: string;
    result: Pick<SongResult, "proven" | "placements">;
  } | null {
    const manual = manualResultSource(hit);
    if (manual) return host.manualResultsFor === host.manualContext() && host.manualResults?.some((row) => manualResultHit(row) === hit)
      ? { input: manual.input, settings: manual.settings, session: manual.session, source: "manual", result: { proven: false } }
      : null;
    if (hit === host.results?.cpChallenge) {
      const input = resultRequest(host, hit);
      return input ? { result: { proven: true }, input, source: "cp-challenge", settings: resultSettings(host, hit) } : null;
    }
    const pt = usesPtResults(host),
      task = pt ? host.pt.job?.tasks.find((task) => task.result?.hits.includes(hit)) : undefined;
    const result = pt ? task?.result : host.results?.results.find((result) => result.hits.includes(hit));
    const input = pt ? host.pt.job?.request : host.resultInputs;
    return result && input
      ? {
          result,
          input,
          source: task ? `${task.route}:${task.measure}` : "build",
          settings: resultSettings(host, hit, task),
        }
      : null;
  }
  idFor(host: TeamBuilder, hit: EngineHit) {
    const source = this.source(host, hit);
    return source ? entryId(hit, source.source, source.input, source.session ?? this.session, source.settings,
      hit.score?.orders.length ? resultOrderIndex(host, hit) : undefined) : null;
  }
  find(host: TeamBuilder, hit: EngineHit) {
    const source = this.source(host, hit);
    return source ? entry(host, hit, source.source, source.result, source.input, source.session ?? this.session, source.settings) : null;
  }
  toggle(host: TeamBuilder, hit: EngineHit) {
    this.sync(host);
    const candidate = this.find(host, hit);
    if (!candidate) return;
    if (this.items.some((item) => item.id === candidate.id)) this.remove(candidate.id);
    else if (this.items.length === 3) snackbar(host.t("compareLimit", "Compare up to 3 teams"));
    else {
      this.items.push(candidate);
      this.baseline ||= candidate.id;
    }
    host.requestUpdate();
  }
  remove(id: string) {
    this.items = this.items.filter((item) => item.id !== id);
    if (this.baseline === id) this.baseline = this.items[0]?.id ?? "";
    if (this.items.length < 2) this.open = false;
  }
  title(host: TeamBuilder, item: ComparisonEntry) {
    return item.hit.song
      ? `${host.catalog!.songTitle(item.hit.song.songId)} / ${host.catalog!.difficultyLabel(item.hit.song.songId, item.hit.song.difficulty)}`
      : item.metric.label;
  }
  tray(host: TeamBuilder) {
    return this.items.length
      ? html`
          <div class="tb-compare-tray" aria-label=${host.t("comparison", "Comparison")}>
            <div class="cluster">
              ${this.items.map((item) =>
                inputChip(
                  `#${this.items.indexOf(item) + 1} / ${this.title(host, item)}`,
                  host.common("common.actions.remove", "Remove"),
                  () => {
                    this.remove(item.id);
                    host.requestUpdate();
                  },
                ),
              )}
            </div>
            <button
              class="button button--tonal"
              ?disabled=${this.items.length < 2}
              @click=${() => {
                this.open = true;
                host.requestUpdate();
              }}
            >
              ${host.t("compareTeams", "Compare teams")} / ${this.items.length}/3
            </button>
          </div>
        `
      : nothing;
  }
  dialog(host: TeamBuilder) {
    if (!this.open || this.items.length < 2) return nothing;
    const base = this.items.find((item) => item.id === this.baseline)!;
    if (!this.items.some((item) => item.id === this.candidate && item.id !== base.id))
      this.candidate = this.items.find((item) => item.id !== base.id)!.id;
    const format = (v: number, digits = 0) =>
      new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(v);
    const close = () => {
      this.open = false;
      host.requestUpdate();
    };
    const signed = (v: number, digits = 0) => `${v > 0 ? "+" : ""}${format(v, digits)}`;
    const wideValues = this.items.some((item) => format(item.metric.value, item.metric.digits).length > 12);
    const side = (item: ComparisonEntry) =>
      item.id === base.id ? "is-baseline" : item.id === this.candidate ? "is-candidate" : "is-hidden-mobile";
    const identity = (item: ComparisonEntry) =>
      `#${this.items.indexOf(item) + 1} / ${this.title(host, item)} / ${host.catalog!.cardName("members", cardIdOf(item.hit.members[0]!))}`;
    const row = (label: string, value: (item: ComparisonEntry) => unknown, main = false) => html`
      <tr class=${main ? "tb-comparison-primary" : ""}>
        <th scope="row">${label}</th>
        ${this.items.map(
          (item) => html`
            <td
              class=${side(item)}
              data-comparison-side=${host.t(item.id === base.id ? "comparisonBaseline" : "comparisonCandidate", item.id === base.id ? "Baseline" : "Candidate")}
            >
              ${value(item)}
            </td>
          `,
        )}
      </tr>
    `;
    return html`
      <dialog
        class="dialog tb-comparison"
        data-managed-modal
        ${modal(close)}
        aria-label=${host.t("compareTeams", "Compare teams")}
      >
        <header class="row row--between">
          <strong>${host.t("compareTeams", "Compare teams")}</strong>
          ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: close })}
        </header>
        ${
          this.items.some((item) => item.source !== "manual") && (usesPtResults(host) ? host.pt.stale : host.stale)
            ? html`
                <span role="status">${host.t("stale", "Conditions changed")}</span>
              `
            : nothing
        }
        <div class="tb-comparison-body">
          <div class="tb-comparison-picker">
            <md-outlined-select
              label=${host.t("comparisonCandidate", "Candidate")}
              .value=${this.candidate}
              @change=${(event: Event) => {
                this.candidate = (event.target as HTMLInputElement).value;
                host.requestUpdate();
              }}
            >
              ${this.items
                .filter((item) => item.id !== base.id)
                .map(
                  (item) => html`
                    <md-select-option value=${item.id}><div slot="headline">${identity(item)}</div></md-select-option>
                  `,
                )}
            </md-outlined-select>
          </div>
          <table class=${`tb-comparison-table${wideValues ? " tb-comparison-table--wide" : ""}`}>
            <thead>
              <tr>
                <th scope="col">${host.t("comparison", "Comparison")}</th>
                ${this.items.map(
                  (item) => html`
                    <th scope="col" class=${side(item)}>
                      <span class="tb-comparison-title">
                        #${this.items.indexOf(item) + 1} / ${this.title(host, item)}
                      </span>
                      <button
                        class="button button--text"
                        aria-pressed=${item.id === base.id}
                        @click=${() => {
                          this.baseline = item.id;
                          host.requestUpdate();
                        }}
                      >
                        ${host.t(item.id === base.id ? "comparisonBaseline" : "setBaseline", item.id === base.id ? "Baseline" : "Set as baseline")}
                      </button>
                    </th>
                  `,
                )}
              </tr>
            </thead>
            <tbody>
              ${row(
                host.t("criterion", "Score goal"),
                (item) => html`
                  <span>${item.metric.label}</span>
                  <small>
                    ${item.source === "manual" ? host.t("manualTeam", "Build a team by hand")
                      : host.t(item.proven ? "proven" : "recommendation", item.proven ? "Proven optimal" : "Recommendation")}
                  </small>
                `,
              )}
              ${row(
                host.t("comparisonValue", "Value"),
                (item) => html`
                  <strong class="tb-hit__value">
                    ${format(item.metric.value, item.metric.digits)}${item.metric.unit ? ` ${item.metric.unit}` : ""}
                  </strong>
                `,
                true,
              )}
              ${row(host.t("difference", "Difference"), (item) => {
                const delta = metricDelta(base, item);
                return delta
                  ? html`
                      <span class=${delta.absolute ? "tb-difference" : "tb-equal"}>
                        ${signed(delta.absolute, item.metric.digits)}
                        ${item.metric.unit === "%" ? host.t("percentagePoints", "percentage points") : item.metric.unit}
                      </span>
                    `
                  : "—";
              })}
              ${row(host.t("relativeDifference", "Relative change"), (item) => {
                const delta = metricDelta(base, item);
                return delta?.relative != null
                  ? html`
                      <span class=${delta.relative ? "tb-difference" : "tb-equal"}>${signed(delta.relative, 2)}%</span>
                    `
                  : "—";
              })}
              ${row(host.t("power", "Power"), (item) => format(item.hit.power))}
              ${this.items.some((item) => item.selectedOrder !== undefined) ? row(host.t("selectedOrderScore", "Selected-order score"), (item) => {
                const value = item.selectedOrder === undefined ? undefined : item.hit.score?.orders[item.selectedOrder];
                const before = base.selectedOrder === undefined ? undefined : base.hit.score?.orders[base.selectedOrder];
                return value === undefined ? "—" : html`<span>${format(value)}</span>
                  ${before !== undefined && item.conditions === base.conditions
                    ? html`<small class=${value === before ? "tb-equal" : "tb-difference"}>${signed(value - before)}</small>` : nothing}`;
              }) : nothing}
              ${this.items.some((item) => item.hit.comboBonus != null) ? row(host.t("comboBonus", "Base COMBO BONUS"), (item) => (item.hit.comboBonus == null ? "—" : `×${format(item.hit.comboBonus, 2)}`)) : nothing}
              ${(["members", "snaps", "bindings", "growth"] as const).map((key) =>
                row(host.t(`diff${key}`, key), (item) => {
                  const value = formationDifference(base, item)[key];
                  return html`
                    <span class=${value ? "tb-difference" : "tb-equal"}>${value}</span>
                  `;
                }),
              )}
              ${row(
                host.t("leader", "Leader"),
                (item) => html`
                  <span class=${formationDifference(base, item).leader ? "tb-difference" : "tb-equal"}>
                    ${formationDifference(base, item).leader ? host.t("changed", "Changed") : "—"}
                  </span>
                  <small>${host.catalog!.cardName("members", cardIdOf(item.hit.members[0]!))}</small>
                `,
              )}
              ${row(
                host.t("originalConditions", "Original result conditions"),
                (item) => html`
                  ${
                    item.input.goal.kind === "gekiso"
                      ? html`
                          <span>
                            ${host.t("gekisoPlacements", "Scoring placements")}:
                            ${item.input.goal.opponents ? (item.placements?.join(" / ") ?? "—") : item.input.goal.ranks?.join(" / ") ?? item.input.goal.rank}
                          </span>
                          <span>
                            GREAT ${format(item.input.goal.accuracy.great * 100, 2)}% / JUST
                            ${format(item.input.goal.accuracy.just * 100, 2)}%
                          </span>
                        `
                      : nothing
                  }
                  ${
                    item.input.goal.kind === "event" && item.input.goal.gekiso && item.settings.route !== "challenge"
                      ? html`
                          <span>
                            ${host.t("gekisoPlacements", "Scoring placements")}: 1 / JUST
                            ${format(item.input.goal.gekiso.just * 100, 2)}%
                          </span>
                        `
                      : nothing
                  }
                  ${
                    item.settings.goal === "event" || item.settings.goal === "plan"
                      ? html`
                          <span>
                            ${item.settings.route === "challenge" ? host.t("routeChallenge", "Challenge live") : item.settings.route === "skip" ? host.t("routeSkip", "Skip") : host.t("routeLive", "Normal live")}
                            /
                            ${item.settings.route === "challenge" ? `${item.settings.challengePoints} CP` : `${item.settings.boosts} Boost`}
                          </span>
                        `
                      : nothing
                  }
                  <span>
                    ${item.source === "manual" ? host.t("manualTeam", "Build a team by hand")
                      : item.settings.scope === "theoretical" ? host.t("scopeAll", "All cards, full growth") : host.t("scopeBox", "My cards")}
                    /
                    ${item.input.unknownPolicy === "max" ? host.t("unknownMax", "Count as max") : host.t("unknownMin", "Count as minimum")}
                  </span>
                  ${
                    !item.listed && item.source !== "manual"
                      ? html`
                          <span>${host.t("outsideRanking", "Outside current ranking")}</span>
                        `
                      : nothing
                  }
                `,
              )}
              ${[0, 1, 2, 3, 4].map((index) =>
                row(
                  `${host.t("members", "Members")} ${index + 1}`,
                  (item) => html`
                    <strong>${host.catalog!.cardName("members", cardIdOf(item.hit.members[index]!))}</strong>
                    <small>
                      ${item.hit.snaps[index] ? host.catalog!.cardName("snaps", cardIdOf(item.hit.snaps[index]!)) : host.t("noSnap", "No Snapshot")}
                    </small>
                  `,
                ),
              )}
            </tbody>
          </table>
        </div>
      </dialog>
    `;
  }
}
