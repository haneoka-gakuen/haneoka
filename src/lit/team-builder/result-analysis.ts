// L3 — GEB
// Input: Frozen result teams, native score distributions and current release identity.
// Output: Reward filters, frozen-scenario mistake samples and separate assumed-placement comparisons.
// Pos: [Map](../L2-2.md); on-demand diagnostics reuse the existing engine queue and chart preview.
// Effects/Dependencies: Bounded identity-scoped caches; opening controls does no scoring; cancellation releases the workspace task.
import { html, nothing } from "lit";
import "@material/web/switch/switch.js";
import type { TeamBuilder } from "../team-builder";
import type { EngineHit, EngineRequest, TeamEvaluation, TimingWindow } from "../../lib/team-builder/engine/api";
import type { EvaluateRequest, PlaySample, SampleRequest } from "../../lib/team-builder/engine/protocol";
import { resultRequest } from "./score-goal";
import { dataRows } from "../../lib/team-builder/data";
import { modal } from "../ui/modal";
import { accordion } from "../ui/accordion";
import { iconButton, segmented, filterChip } from "../ui/controls";
import { icon } from "../ui/icon";
import type { ComparisonEntry } from "./result-comparison";
import "../runtime/timing-chart-preview";

const RANK_LABELS = ["C", "B", "A", "S", "SS"];

interface Source {
  hit: EngineHit;
  input: EngineRequest;
}
interface MistakeRow {
  grade: 1 | 4;
  pattern: number;
  indices: number[];
  score: number;
  life: number;
}
interface PressureRow {
  source: Source;
  low: number;
  high: number;
  loss: number;
  ranks: number[];
}
export function evaluateResult(source: Source): EvaluateRequest {
  const { hit, input } = source,
    goal = input.goal;
  const gk =
    goal.kind === "gekiso"
      ? { accuracy: goal.accuracy, rank: goal.rank, ranks: goal.ranks, seeds: goal.seeds, arena: goal.arena, minJustWindowMs: goal.minJustWindowMs, justWindow: goal.justWindow }
      : goal.kind === "event" && goal.gekiso
        ? {
            accuracy: { great: 0, just: goal.gekiso.just, missEvery: 0 },
            rank: goal.gekiso.rank,
            seeds: goal.gekiso.luckSamples,
          }
        : undefined;
  return {
    members: input.members.filter((row) => hit.members.includes(row.key)),
    snaps: input.snaps.filter((row) => hit.snaps.includes(row.key)),
    player: input.player,
    unknownPolicy: input.unknownPolicy,
    songRules: input.songRules,
    team: { members: [...hit.members], snaps: [...hit.snaps], leader: hit.members[0]! },
    songs: hit.aggregate
      ? hit.aggregate.songs.flatMap((part) => (part.song ? [part.song] : []))
      : hit.song
        ? [hit.song]
        : [],
    play: goal.kind === "score" || goal.kind === "event" ? goal.play : { great: 0, good: 0, bad: 0, miss: 0 },
    gekiso: gk,
    challengeEventId: goal.kind === "score" ? goal.challengeEventId : null,
    event:
      goal.kind === "event"
        ? {
            eventId: goal.eventId,
            route: goal.route === "challenge" ? "challenge" : "live",
            consumption: goal.consumption,
            rewardRoom: goal.rewardRoom,
            eventEffects: goal.eventEffects,
          }
        : null,
  };
}
export function rankRisk(hit: EngineHit, rank: number): number | null {
  if (hit.aggregate) {
    const risks = hit.aggregate.songs.map((part) => rankRisk(part, rank));
    return risks.some((value) => value === null) ? null : Math.max(...(risks as number[]));
  }
  const rows = Object.entries(hit.score?.ranks ?? {}),
    total = rows.reduce((sum, [, count]) => sum + count, 0);
  return total ? rows.reduce((sum, [value, count]) => sum + (Number(value) < rank ? count : 0), 0) / total : null;
}
export class ResultAnalysis {
  mode: "filters" | "mistakes" | "pressure" | null = null;
  targetRank = 7;
  maxRisk = 1;
  onlyHighest = false;
  count = 1;
  full = false;
  error = false;
  progress = 0;
  total = 0;
  baseline?: PlaySample;
  samples: MistakeRow[] = [];
  pressureRows: PressureRow[] = [];
  selected = 0;
  private position = 0;
  private detailed = false;
  private sources: Source[] = [];
  private task: symbol | null = null;
  private generation = 0;
  private identity = "";
  private cache = new Map<string, PlaySample | TeamEvaluation[]>();
  constructor(private readonly host: TeamBuilder) {}
  sync() {
    const identity = JSON.stringify([
      this.host.snapshot?.owner,
      this.host.data?.identity,
      this.host.data?.crossServer?.identities,
    ]);
    if (identity !== this.identity) {
      this.close();
      this.cache.clear();
      this.identity = identity;
    }
  }
  private t(key: string) {
    return this.host.t(`analysis.${key}`, key);
  }
  private threshold(hit: EngineHit) {
    const source = this.sources.find((source) => source.hit === hit) ?? this.sources[0];
    const song = hit.song,
      input = source?.input;
    const row = this.host.master?.scoreRanks
      .get(this.host.master.songs.get(song?.songId ?? 0)?.rankGroup ?? 0)
      ?.find((row) => row.rank === this.targetRank);
    if (!row) return Infinity;
    const goal = input?.goal;
    if (goal?.kind === "gekiso" || (goal?.kind === "event" && goal.gekiso && goal.rewardRoom?.mode !== "solo")) {
      const room = goal.kind === "event" ? goal.rewardRoom : undefined;
      const players = room?.mode === "battle" ? room.players : 5;
      const total = Math.trunc(Math.sqrt(5 / players) * row.battleRequired * players);
      return room?.mode === "battle" && room.otherAverageScore !== undefined
        ? Math.max(0, total - room.otherAverageScore * (players - 1))
        : Math.ceil(total / players);
    }
    return row.required;
  }
  private number(value: number) {
    return new Intl.NumberFormat(this.host.locale, { maximumFractionDigits: 1 }).format(value);
  }
  private remember(key: string, result: PlaySample | TeamEvaluation[]) {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > 384) this.cache.delete(this.cache.keys().next().value!);
  }
  stop() {
    this.generation++;
    if (this.task && this.host.ownsTask(this.task)) {
      this.host.engine?.cancel();
      this.host.releaseTask(this.task);
    }
    this.task = null;
    this.host.requestUpdate();
  }
  close() {
    this.stop();
    this.mode = null;
    this.sources = [];
    this.baseline = undefined;
    this.samples = [];
    this.pressureRows = [];
  }
  openMistakes(hit: EngineHit) {
    const input = resultRequest(this.host, hit);
    if (!input || !hit.song) return;
    this.close();
    this.sources = [{ hit: structuredClone(hit), input: structuredClone(input) }];
    this.mode = "mistakes";
    this.error = false;
    this.progress = 0;
    this.total = 0;
    this.host.requestUpdate();
  }
  openPressure(hit: EngineHit) {
    const input = resultRequest(this.host, hit);
    if (!input || input.goal.kind !== "gekiso") return;
    const candidates: Source[] = [
      { hit, input },
      ...(this.host.results?.overall ?? []).map((hit) => ({ hit, input })),
      ...this.host.comparison.items
        .filter((entry) => entry.input.goal.kind === "gekiso")
        .map(({ hit, input }) => ({ hit, input })),
    ];
    const unique = [
      ...new Map(candidates.map((source) => [JSON.stringify([source.hit.members, source.hit.snaps]), source])).values(),
    ].slice(0, 3);
    this.openPressureSources(unique);
  }
  openPressureEntries(entries: ComparisonEntry[]) {
    this.openPressureSources(entries.map((entry) => ({ hit: entry.hit, input: entry.input })));
  }
  private openPressureSources(sources: Source[]) {
    this.close();
    this.sources = structuredClone(sources);
    this.mode = "pressure";
    this.error = false;
    this.progress = 0;
    this.total = 0;
    this.host.requestUpdate();
  }
  filter(rows: EngineHit[]): EngineHit[] {
    if (this.maxRisk === 1 && !this.onlyHighest) return rows;
    const value = (hit: EngineHit) => hit.event?.mean ?? hit.key;
    const maximum = Math.max(...rows.map(value));
    return rows.filter(
      (hit) =>
        (!this.onlyHighest || value(hit) === maximum) &&
        (this.maxRisk === 1 || (rankRisk(hit, this.targetRank) ?? Infinity) <= this.maxRisk),
    );
  }
  filters() {
    const active = Number(this.maxRisk < 1) + Number(this.onlyHighest);
    return html`
      <button
        class=${active ? "button button--tonal" : "button button--text"}
        type="button"
        aria-haspopup="dialog"
        @click=${() => {
          this.mode = "filters";
          this.host.requestUpdate();
        }}
      >
        ${icon("filter_list", 18)} ${this.t("filters")}
        ${active ? html`<span class="tabular">${active}</span>` : nothing}
      </button>
    `;
  }
  async run() {
    if (!this.host.engine || this.task) return;
    const task = this.host.acquireTask("analysis");
    if (!task) return;
    this.task = task;
    const generation = ++this.generation;
    this.error = false;
    this.progress = 0;
    const sample = async (request: SampleRequest) => {
      const key = JSON.stringify([this.identity, "sample", request]);
      const known = this.cache.get(key) as PlaySample | undefined;
      if (known) return known;
      const result = await this.host.engine!.sample(request);
      if (generation !== this.generation) throw new DOMException("Cancelled", "AbortError");
      this.remember(key, result);
      return result;
    };
    try {
      if (this.mode === "mistakes") {
        this.samples = [];
        const source = this.sources[0]!,
          request = evaluateResult(source);
        const orders = source.hit.score?.orders ?? [];
        const order = orders.length ? orders.indexOf(Math.min(...orders)) : 0;
        const frozen: SampleRequest = {
          ...request,
          order,
          includeNotes: true,
          gekiso: request.gekiso
            ? { ...request.gekiso, accuracy: { ...request.gekiso.accuracy, great: 0, missEvery: 0 } }
            : undefined,
          play: { ...request.play, great: 0, good: 0, bad: 0, miss: 0, missEvery: 0 },
        };
        this.baseline = await sample(frozen);
        const notes = this.baseline.notes.filter((note) => [1, 20, 40, 41, 42, 101, 102].includes(note.op));
        this.total = 24;
        for (const grade of [4, 1] as const)
          for (let pattern = 0; pattern < 12; pattern++) {
            if (generation !== this.generation) return;
            const count = Math.min(this.count, notes.length),
              positions = new Set<number>();
            for (let n = 0; n < count; n++)
              positions.add(
                pattern < 6
                  ? (Math.floor((n * notes.length) / Math.max(1, count)) + Math.floor((pattern * notes.length) / 6)) %
                      Math.max(1, notes.length)
                  : (Math.floor(((pattern - 6) * notes.length) / 6) + n) % Math.max(1, notes.length),
              );
            const indices = [...positions].flatMap((index) => (notes[index] ? [notes[index]!.index] : []));
            const result = await sample({
              ...frozen,
              includeNotes: false,
              play: { ...frozen.play, mistakes: { indices, judgement: grade } },
            });
            this.samples.push({ grade, pattern, indices, score: result.score, life: result.lowestLife });
            this.progress++;
            this.host.requestUpdate();
          }
      } else if (this.mode === "pressure") {
        this.pressureRows = [];
        const first = this.sources[0];
        if (!first || this.sources.length < 2) throw Error("teams");
        const base = evaluateResult(first);
        if (!base.songs.length || !base.gekiso) throw Error("scope");
        const ranks: [number, number, number][] = this.full
          ? Array.from({ length: 125 }, (_, index) => [
              Math.floor(index / 25) + 1,
              (Math.floor(index / 5) % 5) + 1,
              (index % 5) + 1,
            ])
          : [
              [1, 1, 1],
              [3, 3, 3],
              [5, 5, 5],
              [1, 3, 5],
              [1, 5, 3],
              [3, 1, 5],
              [3, 5, 1],
              [5, 1, 3],
              [5, 3, 1],
            ];
        this.total = ranks.length * this.sources.length;
        const scores = this.sources.map(() => [] as number[]);
        for (const scenario of ranks) {
          const requests = this.sources.map((source) => {
            const own = evaluateResult(source);
            return {
              ...own,
              songs: base.songs,
              songRules: base.songRules,
              player: base.player,
              gekiso: { ...base.gekiso!, ranks: scenario, rank: scenario[0], arena: base.gekiso!.arena ? { ...base.gekiso!.arena, objective: "score" as const, opponents: undefined } : undefined },
            };
          });
          const values: (TeamEvaluation[] | undefined)[] = requests.map(
            (request) =>
              this.cache.get(JSON.stringify([this.identity, "pressure", request])) as TeamEvaluation[] | undefined,
          );
          const missing = requests.flatMap((request, index) => (values[index] ? [] : [{ request, index }]));
          if (missing.length) {
            const fresh = await this.host.engine.evaluateBatch(missing.map((row) => row.request));
            if (generation !== this.generation) return;
            missing.forEach((row, index) => {
              values[row.index] = fresh[index];
              this.remember(JSON.stringify([this.identity, "pressure", row.request]), fresh[index]!);
            });
          }
          values.forEach((rows, index) => {
            if (!rows?.length || rows.some((row) => !row.score)) throw Error("score");
            scores[index]!.push(rows.reduce((sum, row) => sum + row.score.mean, 0) / rows.length);
          });
          this.progress += this.sources.length;
          this.host.requestUpdate();
        }
        this.pressureRows = this.sources
          .map((source, index) => {
            const values = scores[index]!,
              losses = values.map((value, scenario) => Math.max(...scores.map((row) => row[scenario]!)) - value);
            const loss = Math.max(...losses);
            return {
              source,
              low: Math.min(...values),
              high: Math.max(...values),
              loss,
              ranks: ranks[losses.indexOf(loss)]!,
            };
          })
          .sort((a, b) => a.loss - b.loss);
      }
    } catch (error) {
      if (generation === this.generation && !(error instanceof DOMException && error.name === "AbortError"))
        this.error = true;
    } finally {
      if (this.task === task) {
        this.task = null;
        this.host.releaseTask(task);
      }
      this.host.requestUpdate();
    }
  }
  private hasLuck(source: Source) {
    const song = source.hit.song; if (!song) return false;
    const goal = source.input.goal, arena = goal.kind === "gekiso" ? goal.arena : undefined;
    const original = this.host.master?.songs.get(song.songId)?.gekisoMissions ?? [];
    return [0,1,2].some(index => (arena?.missions[index] || source.input.songRules?.missions[index] || original[index]) === 2);
  }
  private delta(value: number) {
    return new Intl.NumberFormat(this.host.locale, { maximumFractionDigits: 0, signDisplay: "exceptZero" }).format(value);
  }
  private reached(row: MistakeRow) {
    return row.score >= this.threshold(this.sources[0]!.hit) && row.life > 0;
  }
  private patternLabel(row: Pick<MistakeRow, "grade" | "pattern">) {
    return `${row.grade === 4 ? "GREAT" : "MISS"} ${this.t(row.pattern < 6 ? "spread" : "cluster")} ${(row.pattern % 6) + 1}`;
  }
  private choose(index: number) {
    this.selected = index;
    this.position = 0;
    this.host.requestUpdate();
  }
  private preview() {
    const row = this.samples[this.selected],
      hit = this.sources[0]?.hit;
    if (!row || !hit?.song || !this.baseline) return html`<div class="tb-analysis-chart" aria-hidden="true"></div>`;
    const notes = row.indices
        .map((index) => this.baseline!.notes[index]!)
        .filter(Boolean)
        .sort((a, b) => a.timeMs - b.timeMs),
      position = Math.min(this.position, notes.length - 1),
      first = notes[position];
    if (!first) return nothing;
    const catalog = this.host.catalog!,
      difficulty = dataRows(catalog.data.songs[String(hit.song.songId)]!.difficulty).find(
        (row) => Number(row.difficulty) === hit.song!.difficulty,
      )!;
    const window: TimingWindow = {
      event: 0,
      member: 0,
      startMs: first.timeMs,
      endMs: first.timeMs + 3000,
      notes: notes.map((note) => note.timeMs),
      steps: notes.map((note, index) => ({
        step: index + 1,
        timeMs: note.timeMs,
        notes: 1,
        noteIndices: [note.index],
        gain: 0,
      })),
    } as unknown as TimingWindow;
    const move = (step: number) => {
      this.position = position + step;
      this.host.requestUpdate();
    };
    return html`
      <div class="tb-analysis-chart">
        <div class="tb-analysis-chart__nav">
          ${iconButton({ icon: "chevron_left", label: this.t("previousPosition"), disabled: position === 0, onClick: () => move(-1) })}
          <span class="tabular">${position + 1} / ${notes.length}</span>
          <span class="tabular tb-analysis-chart__time">${new Date(first.timeMs).toISOString().slice(14, 23)}</span>
          ${iconButton({ icon: "chevron_right", label: this.t("nextPosition"), disabled: position >= notes.length - 1, onClick: () => move(1) })}
        </div>
        <timing-chart-preview
          .source=${{ identity: catalog.songIdentity(hit.song.songId), file: difficulty.file as string }}
          .window=${window}
          .active=${true}
          .locale=${this.host.locale}
          .label=${this.t("positions")}
          .errorLabel=${this.t("failed")}
        ></timing-chart-preview>
      </div>
    `;
  }
  private rankControl(grow = false) {
    return segmented({
      label: this.t("targetRank"),
      value: String(this.targetRank),
      grow,
      options: [3, 4, 5, 6, 7].map((value) => ({ value: String(value), label: RANK_LABELS[value - 3]! })),
      onSelect: (value) => {
        this.targetRank = Number(value);
        this.host.requestUpdate();
      },
    });
  }
  private field(label: string, control: unknown) {
    return html`
      <div class="tb-analysis-field">
        <span class="tb-field__label">${label}</span>
        ${control}
      </div>
    `;
  }
  private renderFilters() {
    const t = (key: string) => this.t(key);
    return html`
      ${this.field(t("targetRank"), this.rankControl(true))}
      ${this.field(
        t("maxRisk"),
        html`
          <div class="cluster" role="group" aria-label=${t("maxRisk")}>
            ${[1, 0, 0.05, 0.1, 0.25, 0.5].map((value) =>
              filterChip({
                label: value === 1 ? t("all") : `≤ ${value * 100}%`,
                selected: this.maxRisk === value,
                onToggle: () => {
                  this.maxRisk = value;
                  this.host.requestUpdate();
                },
              }),
            )}
          </div>
        `,
      )}
      <label class="tb-switch-row tb-analysis-switch">
        <span>${t("highestOnly")}</span>
        <md-switch
          .selected=${this.onlyHighest}
          aria-label=${t("highestOnly")}
          @change=${(event: Event) => {
            this.onlyHighest = (event.target as HTMLInputElement & { selected: boolean }).selected;
            this.host.requestUpdate();
          }}
        ></md-switch>
      </label>
    `;
  }
  private runButton() {
    const running = !!this.task;
    return html`
      <button
        class=${running ? "button button--tonal tb-analysis-run" : "button button--filled tb-analysis-run"}
        type="button"
        ?disabled=${!running && (this.host.running || (this.mode === "pressure" && this.sources.length < 2))}
        @click=${() => (running ? this.stop() : void this.run())}
      >
        ${running
          ? html`${this.host.common("common.actions.cancel", "Cancel")}
              <span class="tabular">${this.progress} / ${this.total}</span>`
          : this.t("run")}
      </button>
    `;
  }
  private renderMistakes() {
    const t = (key: string) => this.t(key),
      source = this.sources[0]!;
    const countControl = segmented({
      label: t("inputCount"),
      value: String(this.count),
      grow: false,
      options: [1, 3, 5, 10, 20].map((value) => ({ value: String(value), label: String(value) })),
      onSelect: (value) => {
        this.stop();
        this.count = Number(value);
        this.samples = [];
        this.position = 0;
        this.host.requestUpdate();
      },
    });
    const grade = this.selected < 12 ? 4 : 1;
    const of = (value: 1 | 4) => this.samples.filter((row) => row.grade === value);
    const tally = (value: 1 | 4) => {
      const rows = of(value);
      return rows.length ? `${rows.filter((row) => this.reached(row)).length}/${rows.length}` : "";
    };
    const current = this.samples[this.selected];
    const baseline = this.baseline;
    return html`
      <div class="tb-analysis-controls">
        ${this.field(t("targetRank"), this.rankControl())} ${this.field(t("inputCount"), countControl)}
        ${this.runButton()}
      </div>
      ${this.error ? html`<span class="tb-analysis-error" role="alert">${t("failed")}</span>` : nothing}
      ${baseline
        ? html`
            <div class="tb-analysis-summary">
              <span class="tb-field__label">${t("fixedOrder")}</span>
              <strong class="tabular">${this.number(baseline.score)}</strong>
              ${this.hasLuck(source) ? html`<span class="chip chip--static">${t("seed")}</span>` : nothing}
            </div>
            <div class="tb-analysis-split">
              <div class="tb-analysis-picker">
                ${segmented({
                  label: t("pattern"),
                  value: String(grade),
                  options: ([4, 1] as const).map((value) => ({
                    value: String(value),
                    label: `${value === 4 ? "GREAT" : "MISS"} ${tally(value)}`.trim(),
                  })),
                  onSelect: (value) => this.choose((value === "4" ? 0 : 12) + (this.selected % 12)),
                })}
                ${([0, 6] as const).map(
                  (start) => html`
                    <div class="tb-analysis-group" role="group" aria-label=${t(start ? "cluster" : "spread")}>
                      <span class="tb-field__label">${t(start ? "cluster" : "spread")}</span>
                      <div class="tb-analysis-tiles">
                        ${[0, 1, 2, 3, 4, 5].map((offset) => {
                          const pattern = start + offset,
                            index = (grade === 4 ? 0 : 12) + pattern,
                            row = this.samples[index];
                          return html`
                            <button
                              class="tb-analysis-tile"
                              type="button"
                              aria-pressed=${String(this.selected === index)}
                              data-state=${row ? (this.reached(row) ? "reached" : "below") : nothing}
                              ?disabled=${!row}
                              aria-label=${row
                                ? `${this.patternLabel(row)}: ${this.number(row.score)}, ${t(this.reached(row) ? "reached" : "below")}`
                                : `${offset + 1}`}
                              @click=${() => this.choose(index)}
                            >
                              <span class="tb-analysis-tile__index">${offset + 1}</span>
                              <span class="tabular">${row ? this.delta(row.score - baseline.score) : "—"}</span>
                            </button>
                          `;
                        })}
                      </div>
                    </div>
                  `,
                )}
                <dl class="tb-analysis-stats">
                  <div>
                    <dt>${t("score")}</dt>
                    <dd class="tabular">${current ? this.number(current.score) : "—"}</dd>
                  </div>
                  <div>
                    <dt>${t("lowestLife")}</dt>
                    <dd class="tabular">${current ? this.number(current.life) : "—"}</dd>
                  </div>
                  <div>
                    <dt>${RANK_LABELS[this.targetRank - 3]}</dt>
                    <dd data-state=${current ? (this.reached(current) ? "reached" : "below") : nothing}>
                      ${current ? t(this.reached(current) ? "reached" : "below") : "—"}
                    </dd>
                  </div>
                </dl>
              </div>
              ${this.preview()}
            </div>
            ${this.samples.length
              ? accordion({
                  id: "tb-analysis-samples",
                  label: t("samples"),
                  metadata: String(this.samples.length),
                  expanded: this.detailed,
                  onExpandedChange: (open) => {
                    this.detailed = open;
                    this.host.requestUpdate();
                  },
                  content: html`
                    <div class="table-scroll" tabindex="0" role="region" aria-label=${t("samples")}>
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>${t("pattern")}</th>
                            <th class="tabular">${t("score")}</th>
                            <th class="tabular">${t("lowestLife")}</th>
                            <th>${RANK_LABELS[this.targetRank - 3]}</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${this.samples.map(
                            (row, index) => html`
                              <tr>
                                <th scope="row">
                                  <button class="button button--text" type="button" @click=${() => this.choose(index)}>
                                    ${this.patternLabel(row)}
                                  </button>
                                </th>
                                <td class="tabular">${this.number(row.score)}</td>
                                <td class="tabular">${this.number(row.life)}</td>
                                <td>${t(this.reached(row) ? "reached" : "below")}</td>
                              </tr>
                            `,
                          )}
                        </tbody>
                      </table>
                    </div>
                  `,
                })
              : nothing}
          `
        : nothing}
    `;
  }
  private renderPressure() {
    const t = (key: string) => this.t(key),
      catalog = this.host.catalog!;
    const rows: (PressureRow | { source: Source })[] = this.pressureRows.length
      ? this.pressureRows
      : this.sources.map((source) => ({ source }));
    return html`
      <div class="tb-analysis-controls">
        ${this.field(
          t("scenario"),
          segmented({
            label: t("scenario"),
            value: this.full ? "all" : "basic",
            grow: false,
            options: [
              { value: "basic", label: t("basicScenarios") },
              { value: "all", label: t("allScenarios") },
            ],
            onSelect: (value) => {
              this.stop();
              this.full = value === "all";
              this.pressureRows = [];
              this.host.requestUpdate();
            },
          }),
        )}
        ${this.runButton()}
      </div>
      ${this.error ? html`<span class="tb-analysis-error" role="alert">${t("failed")}</span>` : nothing}
      <ol class="tb-analysis-teams">
        ${rows.map((row) => {
          const result = "loss" in row ? row : null,
            number = this.sources.indexOf(row.source) + 1,
            names = row.source.hit.members.map((key) =>
              catalog.characterName(catalog.member(Number(key.slice(1)))?.characterId ?? 0),
            );
          return html`
            <li class="tb-analysis-team">
              <span class="tb-analysis-team__number tabular">${number}</span>
              <div class="tb-analysis-team__main">
                <ol class="tb-analysis-team__faces" aria-label=${names.join(", ")}>
                  ${row.source.hit.members.map((key, index) => {
                    const card = catalog.member(Number(key.slice(1)));
                    return html`
                      <li title=${names[index]!}>
                        <img
                          class="tb-order-card"
                          src=${card?.image || catalog.characterFace(card?.characterId ?? 0)}
                          alt=""
                          width="32"
                          height="32"
                          loading="lazy"
                          decoding="async"
                        />
                      </li>
                    `;
                  })}
                </ol>
                <dl class="tb-analysis-team__facts">
                  <div>
                    <dt>${t("scoreRange")}</dt>
                    <dd class="tabular">${result ? `${this.number(result.low)} – ${this.number(result.high)}` : "—"}</dd>
                  </div>
                  <div>
                    <dt>${t("worstScenario")}</dt>
                    <dd class="tabular">${result ? result.ranks.join(" / ") : "—"}</dd>
                  </div>
                </dl>
              </div>
              <div class="tb-analysis-team__loss">
                <span class="tb-field__label">${t("loss")}</span>
                <strong class="tabular">${result ? this.number(result.loss) : "—"}</strong>
              </div>
            </li>
          `;
        })}
      </ol>
    `;
  }
  render() {
    if (!this.mode) return nothing;
    const title = this.t(this.mode);
    return html`
      <dialog
        class=${`dialog tb-result-analysis tb-result-analysis--${this.mode}`}
        data-managed-modal
        ${modal(() => this.close())}
        aria-labelledby="tb-analysis-title"
      >
        <header class="tb-analysis-header">
          <h2 id="tb-analysis-title">${title}</h2>
          ${iconButton({ icon: "close", label: this.host.common("common.actions.close", "Close"), onClick: () => this.close() })}
        </header>
        <div class="dialog__body tb-analysis-body">
          ${this.mode === "filters"
            ? this.renderFilters()
            : this.mode === "mistakes"
              ? this.renderMistakes()
              : this.renderPressure()}
        </div>
      </dialog>
    `;
  }
}
