// L3 — GEB
// Input: A selected result or manual team, frozen card inputs and the growth items chosen for one card.
// Output: Shared training priorities and same-team / rebuilt-team scenario details.
// Pos: [Map](../L2-2.md); in-workspace growth comparison controller and dialog.
// Effects/Dependencies: Native searches, cached responses and release-bound material JSON; no Box writes.
import { icon } from "../ui/icon";
import { html, nothing } from "lit";
import type { EngineHit, EngineRequest, EngineResponse, TeamEvaluation } from "../../lib/team-builder/engine/api";
import { completeResponse } from "../../lib/team-builder/engine/execution";
import { cpExchange } from "../../lib/team-builder/engine/pt-value";
import { ptChallengeBest } from "../../lib/team-builder/pt-recommendation";
import { engineInputs } from "../../lib/team-builder/sync/box-view";
import {
  fixedGrowthRequest,
  freshGrowthRequest,
  teamGrowthActions,
  teamGrowthChange,
  type TeamGrowthChoice,
} from "../../lib/team-builder/team-growth";
import type { GrowthPageData } from "../../lib/growth-catalog";
import { summarizeCatalogCosts } from "../../lib/catalog-cost-summary";
import { memberStat, snapshotPercent } from "../../lib/card-growth";
import { upgradeCost } from "../ui/upgrade-cost";
import { stageDisplay, growthSkillLevel } from "../../lib/growth-catalog";
import { iconButton, segmented } from "../ui/controls";
import { modal } from "../ui/modal";
import { tileMedia } from "../ui/tile";
import { accordion } from "../ui/accordion";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { resultRequest, resultSettings, usesPtResults } from "./score-goal";
import { resultMetric } from "./result-metric";

interface Source {
  input: EngineRequest;
  hit: EngineHit;
  settings: BuildSettings;
  identity: string;
  cycle?: { songs: import("../../lib/team-builder/engine/api").SongRef[]; consumption: number };
}
type Phase = "fixedBefore" | "fixedAfter" | "searchBefore" | "searchAfter";
const actionLabels = {
  level: "level",
  training: "training",
  awakening: "awakening",
  live: "liveSkill",
  gekisou: "gekisoSkill",
  break: "limitBreak",
  full: "tg.full",
};

export class TeamGrowthComparison {
  source: Source | null = null;
  choice: TeamGrowthChoice = { kind: "members", key: "", actions: ["level"], target: "next" };
  results: Partial<Record<Phase, EngineResponse>> = {};
  phase: Phase | null = null;
  error = "";
  private catalogData?: GrowthPageData;
  private catalogError = false;
  private cache = new Map<string, EngineResponse>();
  private cacheIdentity = "";
  private cacheKey(input: EngineRequest) {
    const identity = this.identity();
    if (identity !== this.cacheIdentity) {
      this.cache.clear();
      this.cacheIdentity = identity;
    }
    const request = freshGrowthRequest(input);
    request.timeLimitMs = null;
    return JSON.stringify([identity, request]);
  }
  private cached(key: string) {
    const result = this.cache.get(key);
    if (result) {
      this.cache.delete(key);
      this.cache.set(key, result);
    }
    return result;
  }
  private remember(key: string, result: EngineResponse) {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
  }
  private task: symbol | null = null;
  private stopped = false;
  private expanded = new Set(["new"]);
  private settingsOpen = true;
  constructor(private readonly host: TeamBuilder) {}
  private identity() {
    return JSON.stringify([
      this.host.snapshot?.owner,
      this.host.data?.identity,
      this.host.data?.crossServer?.identities,
    ]);
  }
  sync() {
    if (this.source && this.source.identity !== this.identity()) {
      this.close();
      this.cache.clear();
    }
  }
  close() {
    this.stop();
    this.source = null;
    if (this.host.slotPicker && "growth" in this.host.slotPicker) this.host.slotPicker = null;
    this.results = {};
    this.host.requestUpdate();
  }
  stop() {
    if (this.task && this.host.ownsTask(this.task)) {
      this.stopped = true;
      this.host.engine?.cancel();
    }
  }
  openResult(hit: EngineHit, upgrade?: { kind: "members" | "snaps"; key: string }) {
    const host = this.host;
    const input = resultRequest(host, hit);
    if (!input || host.running) return;
    const settings = structuredClone(resultSettings(host, hit));
    const request = freshGrowthRequest(input);
    if (request.goal.kind === "plan") return;
    if (request.goal.kind === "event" && usesPtResults(host)) {
      const job = host.pt.job!;
      request.goal.route = settings.route;
      request.goal.measure = settings.measure;
      request.goal.songs = job.tasks
        .filter((task) => task.route === settings.route && task.measure === settings.measure)
        .map((task) => task.song);
      if (settings.route === "challenge") {
        request.goal.consumption = job.cycle!.consumption;
        delete request.goal.gekiso;
      } else if (job.cycle) {
        const best = ptChallengeBest(job, settings.measure === "items" ? "items" : "points");
        if (best?.event?.rewardSum == null || best.event.orders == null) return;
        request.goal.cpExchange = cpExchange(best.event.rewardSum, best.event.orders, job.cycle.consumption);
      }
    }

    this.show(
      {
        input: request,
        hit: structuredClone(hit),
        settings,
        identity: this.identity(),
        cycle:
          usesPtResults(host) && settings.route === "live"
            ? structuredClone(host.pt.job?.cycle ?? undefined)
            : undefined,
      },
      upgrade,
    );
  }
  openManual(row: TeamEvaluation) {
    const host = this.host;
    if (host.running || host.manualResultsFor !== host.manualContext() || !host.manualResults?.includes(row)) return;
    const goal = host.manualGoal(),
      base = host.request(goal);
    if (!base || !host.view) return;
    const selected = host.manualInputs(),
      owned = engineInputs(host.view, true);
    const input = freshGrowthRequest(base);
    // Manual evaluation scores each chart separately from the automatic search's aggregation.
    input.aggregation = undefined;
    input.members = [
      ...new Map(
        [
          ...base.members.map((item) => owned.members.find((card) => card.key === item.key) ?? item),
          ...selected.members,
        ].map((item) => [item.key, item]),
      ).values(),
    ];
    input.snaps = [
      ...new Map(
        [...base.snaps.map((item) => owned.snaps.find((card) => card.key === item.key) ?? item), ...selected.snaps].map(
          (item) => [item.key, item],
        ),
      ).values(),
    ];
    input.unknownPolicy = selected.unknownPolicy;
    const order = [host.manual.leader, ...[0, 1, 2, 3, 4].filter((slot) => slot !== host.manual.leader)];
    const hit: EngineHit = {
      ...row,
      key: row.score.mean,
      potential: null,
      members: order.map((slot) => `m${host.manual.members[slot]}`),
      snaps: order.map((slot) => (host.manual.snaps[slot] === null ? null : `s${host.manual.snaps[slot]}`)),
      slotPowers: row.slotPowers,
      event: null,
    };
    this.show({
      input,
      hit,
      settings: { ...host.searchSettings, goal: goal.kind, criterion: "mean", scoreTarget: "none" },
      identity: this.identity(),
    });
  }
  private show(source: Source, upgrade?: { kind: "members" | "snaps"; key: string }) {
    this.source = source;
    this.results = {};
    this.error = "";
    this.settingsOpen = true;
    this.choice = {
      kind: upgrade?.kind ?? "members",
      key: upgrade?.key ?? source.hit.members[0]!,
      actions: upgrade ? teamGrowthActions(upgrade.kind) : ["level"],
      target: upgrade ? "cap" : "next",
    };
    this.restoreSearch();
    void this.loadMaterials(source);
    this.host.requestUpdate();
  }
  select(choice: Partial<TeamGrowthChoice>) {
    if (this.phase) return;
    this.choice = { ...this.choice, ...choice };
    delete this.results.fixedAfter;
    delete this.results.searchAfter;
    this.error = "";
    this.restoreSearch();
    if (this.source) void this.loadMaterials(this.source);
    this.host.requestUpdate();
  }
  private change() {
    return this.source && this.host.master ? teamGrowthChange(this.host.master, this.source.input, this.choice) : null;
  }
  private restoreSearch() {
    if (!this.source) return;
    this.results.searchBefore = this.cached(this.cacheKey(this.source.input));
    const change = this.change();
    if (change?.request) this.results.searchAfter = this.cached(this.cacheKey(change.request));
  }
  private async loadMaterials(source: Source) {
    this.catalogError = false;
    const selection = `${this.choice.kind}:${this.choice.key}`;
    const item = source.input[this.choice.kind].find((row) => row.key === this.choice.key)!;
    const server =
      this.host.data!.crossServer?.owners[this.choice.kind === "members" ? "members" : "snapshots"]?.[
        String(item.cardId)
      ] ?? this.host.data!.identity.server;
    const identity = this.host.data!.crossServer?.identities[server] ?? this.host.data!.identity;
    const matches = (data: GrowthPageData) =>
      data.identity.server === identity.server &&
      data.identity.releaseId === identity.releaseId &&
      data.identity.sourceId === identity.sourceId &&
      data.locale === this.host.locale;
    if (this.catalogData && matches(this.catalogData)) return;
    this.catalogData = undefined;
    try {
      const response = await fetch(`/${server}/${this.host.locale}/growth-data.json`);
      if (!response.ok) throw new Error(String(response.status));
      const data: GrowthPageData = await response.json();
      if (data.schema !== "haneoka-growth-page-v1" || !matches(data)) throw new Error("growth-data-release");
      if (this.source === source && selection === `${this.choice.kind}:${this.choice.key}`) this.catalogData = data;
    } catch {
      if (this.source === source && selection === `${this.choice.kind}:${this.choice.key}`) this.catalogError = true;
    }
    if (this.source === source) this.host.requestUpdate();
  }
  async priorities(input: EngineRequest, progress: (done: number, total: number) => void) {
    const request = freshGrowthRequest(input),
      identity = this.identity();
    request.timeLimitMs = null;
    const evaluate = async (request: EngineRequest) => {
      const key = this.cacheKey(request),
        cached = this.cached(key);
      if (cached && completeResponse(cached) && !cached.error) return cached;
      const result = await this.host.engine!.run({
        ...request,
        seeds: cached?.overall,
        completed: cached?.results.filter((row) => row.proven),
      });
      if (identity !== this.identity()) throw new DOMException("Cancelled", "AbortError");
      this.remember(key, result);
      if (result.error) throw new Error(result.error);
      if (!completeResponse(result)) throw new DOMException("Cancelled", "AbortError");
      return result;
    };
    const base = await evaluate(request);
    if (!base.overall[0]) throw new Error("growth-no-team");
    const candidates = (["members", "snaps"] as const).flatMap((kind) =>
      request[kind].flatMap((row) => {
        const change = teamGrowthChange(this.host.master!, request, {
          kind,
          key: row.key,
          actions: teamGrowthActions(kind),
          target: "cap",
        });
        return change.request ? [{ kind, key: row.key, request: change.request }] : [];
      }),
    );
    const responses: EngineResponse[] = [];
    const pending: Array<{ index: number; key: string; request: EngineRequest }> = [];
    let done = 0;
    for (const [index, candidate] of candidates.entries()) {
      const key = this.cacheKey(candidate.request);
      const cached = this.cached(key);
      if (cached && completeResponse(cached) && !cached.error) {
        responses[index] = cached;
        progress(++done, candidates.length);
      } else pending.push({ index, key, request: {
        ...candidate.request,
        seeds: cached?.overall,
        completed: cached?.results.filter((row) => row.proven),
      } });
    }
    if (pending.length) await this.host.engine!.runBatch(pending.map((item) => item.request), (index, result) => {
      if (identity !== this.identity()) throw new DOMException("Cancelled", "AbortError");
      const item = pending[index]!;
      this.remember(item.key, result);
      if (result.error) throw new Error(result.error);
      if (!completeResponse(result)) throw new DOMException("Cancelled", "AbortError");
      responses[item.index] = result;
      progress(++done, candidates.length);
    });
    const upgrades = [];
    const settings = resultSettings(this.host);
    const metric = (hit: EngineHit) => resultMetric(this.host, hit, settings).value;
    for (const [index, candidate] of candidates.entries()) {
      const team = responses[index]!.overall[0] ?? null;
      if (team)
        upgrades.push({
          kind: candidate.kind,
          key: candidate.key,
          value: metric(team),
          gain: metric(team) - metric(base.overall[0]),
          team,
        });
    }
    upgrades.sort((a, b) => b.gain - a.gain);
    return { base: metric(base.overall[0]), upgrades };
  }
  async run(search = false) {
    const source = this.source,
      change = this.change(),
      host = this.host,
      engine = host.engine;
    if (!source || source.identity !== this.identity() || !change?.request || !engine || host.running) return;
    if (search && (!this.results.fixedAfter || !completeResponse(this.results.fixedAfter))) return;
    const task = host.acquireTask("team-growth");
    if (!task) return;
    this.task = task;
    this.stopped = false;
    this.error = "";
    const active = () => host.ownsTask(task) && this.source === source && source.identity === this.identity();
    const step = async (phase: Phase, input: EngineRequest) => {
      if (!active() || this.stopped) return false;
      const previous = this.results[phase] ?? this.cached(this.cacheKey(input));
      if (previous) this.results[phase] = previous;
      if (previous && completeResponse(previous) && !previous.error) return true;
      this.phase = phase;
      host.requestUpdate();
      const request = freshGrowthRequest(input);
      if (source.cycle && request.goal.kind === "event" && request.goal.route === "live") {
        const candidates = phase.endsWith("After") ? change.request! : source.input;
        const calibration = freshGrowthRequest(candidates);
        calibration.goal = {
          ...request.goal,
          route: "challenge",
          songs: source.cycle.songs,
          consumption: source.cycle.consumption,
        };
        delete calibration.goal.gekiso;
        delete calibration.goal.cpExchange;
        const key = this.cacheKey(calibration);
        let calibrated = this.cached(key);
        if (!calibrated || !completeResponse(calibrated)) {
          calibrated = await engine.run(calibration);
          if (!active() || this.stopped) return false;
          this.remember(key, calibrated);
        }
        if (!completeResponse(calibrated) || calibrated.error)
          throw new Error(calibrated.error ?? "growth-cp-incomplete");
        const event = calibrated.overall[0]?.event;
        if (event?.rewardSum == null || event.orders == null) throw new Error("growth-cp-empty");
        request.goal.cpExchange = cpExchange(event.rewardSum, event.orders, source.cycle.consumption);
      }
      request.contextKey = `${source.identity}:${phase}`;
      request.seeds = previous?.overall;
      request.completed = previous?.results.filter((result) => result.proven);
      const accept = (result: EngineResponse) => {
        if (!active()) return;
        this.results[phase] = result;
        this.remember(this.cacheKey(input), result);
        host.requestUpdate();
      };
      const result = await engine.run(request, undefined, (snapshot) => accept(snapshot.response));
      accept(result);
      if (result.error) throw new Error(result.error);
      return active() && !this.stopped && completeResponse(result) && result.stopReason !== "cancelled";
    };
    try {
      if (search) {
        if (await step("searchBefore", source.input)) await step("searchAfter", change.request);
      } else {
        let before = source.input,
          after = change.request;
        if (before.goal.kind === "event" && before.goal.rewardPlan?.autoCp) {
          if (!(await step("searchBefore", before)) || !(await step("searchAfter", after))) return;
          const resolved = (input: EngineRequest, phase: Phase) => {
            const plan = this.results[phase]?.overall[0]?.event?.rewardPlan;
            if (!plan) throw new Error("growth-missing-reward-plan");
            return { ...input, goal: { ...input.goal, rewardPlan: plan } } as EngineRequest;
          };
          before = resolved(before, "searchBefore");
          after = resolved(after, "searchAfter");
        }
        if (await step("fixedBefore", fixedGrowthRequest(before, source.hit)))
          await step("fixedAfter", fixedGrowthRequest(after, source.hit));
      }
    } catch (error) {
      if (active() && !this.stopped && !(error instanceof DOMException && error.name === "AbortError"))
        this.error = host.t("searchFailed", "The search failed: {reason}", {
          reason: host.errorReason(error),
        });
    } finally {
      if (this.task === task) {
        this.task = null;
        this.phase = null;
      }
      if (active() && this.results.fixedAfter?.overall.length) this.settingsOpen = false;
      host.releaseTask(task);
      host.requestUpdate();
      if (this.source === source)
        void host.updateComplete.then(() => host.querySelector(".tb-team-growth__body")?.scrollTo({ top: 0 }));
    }
  }
  private materials(id: number) {
    const card = this.catalogData?.cards.find(
      (card) => card.id === id && card.kind === (this.choice.kind === "members" ? "member" : "support"),
    );
    if (!card)
      return html`
        <span>${this.host.t(this.catalogError ? "growthComparison.loadError" : "tg.pending", "—")}</span>
      `;
    const input = this.source!.input[this.choice.kind].find((row) => row.cardId === id)!;
    const state = Object.fromEntries(
      Object.entries({
        level: "level",
        training: "awake",
        awakening: "rank",
        live: "liveSkillLevel",
        gekisou: "gekisoSkillLevel",
        break: "rank",
      }).map(([action, field]) => [action, (input as unknown as Record<string, number | null>)[field]]),
    );
    const steps = this.change()?.steps ?? [];
    const actions = steps.map((step) => step.action);
    const after = { ...state };
    for (const step of steps) after[step.action] = step.to;
    const stats = (values: typeof state) => {
      const level = card.tracks.level?.stages.find((row) => row.value === values.level)?.rates;
      if (!card.maximum || !level) return null;
      if (card.kind === "support") return card.maximum.map((max, i) => snapshotPercent(max, level[i]!));
      const training = card.tracks.training?.stages.find((row) => row.value === values.training)?.rates;
      const rank = card.tracks.awakening?.stages.find((row) => row.value === values.awakening)?.rates;
      return training && rank ? card.maximum.map((max, i) => memberStat(max, level[i]!, training[i]!, rank[i]!)) : null;
    };
    const beforeStats = stats(state),
      afterStats = stats(after);
    return html`
      <div class="stack">
        ${
          beforeStats && afterStats
            ? html`
                <dl class="spec-list">
                  ${["performance", "technique", "visual"].map(
                    (key, i) => html`
                      <div>
                        <dt>${this.host.common(`catalog.cards.fields.${key}`, key)}</dt>
                        <dd>
                          ${card.kind === "support" ? new Intl.NumberFormat(this.host.locale, { maximumFractionDigits: 2 }).format(beforeStats[i]! / 100) : beforeStats[i]}
                          →
                          ${card.kind === "support" ? new Intl.NumberFormat(this.host.locale, { maximumFractionDigits: 2 }).format(afterStats[i]! / 100) : afterStats[i]}${card.kind === "support" ? "%" : ""}
                        </dd>
                      </div>
                    `,
                  )}
                </dl>
              `
            : nothing
        }
        ${actions.map((action) => {
          const track = card.tracks[action];
          if (!track) return nothing;
          const from = state[action];
          const to = after[action];
          if (from == null || to == null)
            return html`
              <span>${this.host.t("growthComparison.status.missing-state", "—")}</span>
            `;
          if (from === to) return nothing;
          const label = this.host.t(actionLabels[action], action);
          return html`
            <section class="stack">
              ${
                action === "level"
                  ? html`
                      <strong>${label}</strong>
                      <span>${from} → ${to}</span>
                      <span>${this.host.t("growthComparison.expUnknown", "—")}</span>
                    `
                  : summarizeCatalogCosts(track.costs, from, to).complete
                    ? upgradeCost({
                        label,
                        from: stageDisplay(action, from),
                        to: stageDisplay(action, to),
                        items: summarizeCatalogCosts(track.costs, from, to).items,
                        locale: this.host.locale,
                      })
                    : html`
                        <span>${this.host.t("growthComparison.status.missing-data", "—")}</span>
                      `
              }
              ${card.skills
                .filter(
                  (skill) =>
                    growthSkillLevel(skill, card, state) !== growthSkillLevel(skill, card, { ...state, [action]: to }),
                )
                .map((skill) => {
                  const before = growthSkillLevel(skill, card, state),
                    after = growthSkillLevel(skill, card, { ...state, [action]: to });
                  return html`
                    <section class="stack">
                      <strong>${skill.name}</strong>
                      <dl class="spec-list">
                        <div>
                          <dt>${this.host.t("level", "Level")} ${before}</dt>
                          <dd>${skill.levels.find((row) => row.level === before)?.description ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>${this.host.t("level", "Level")} ${after}</dt>
                          <dd>${skill.levels.find((row) => row.level === after)?.description ?? "—"}</dd>
                        </div>
                      </dl>
                    </section>
                  `;
                })}
            </section>
          `;
        })}
      </div>
    `;
  }
  render() {
    const source = this.source;
    if (!source) return nothing;
    const host = this.host,
      catalog = host.catalog!,
      choice = this.choice,
      change = this.change()!;
    const t = (key: string) => host.t(`tg.${key}`, key);
    const fmt = (value: number, digits = 0) =>
      new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(value);
    const hit = (phase: Phase) =>
      this.results[phase]?.overall[0] ?? (phase === "fixedBefore" && !this.results[phase] ? source.hit : null);
    const metric = (value: EngineHit) => resultMetric(host, value, source.settings);
    const delta = (before: EngineHit | null, after: EngineHit | null) => {
      if (!before || !after) return "—";
      const a = metric(before),
        b = metric(after),
        value = b.value - a.value;
      if ((!a.id.startsWith("reward-plan:") && a.id !== b.id) || a.unit !== b.unit) return "—";
      return `${value > 0 ? "+" : ""}${fmt(value, Math.max(b.digits, 2))}${b.unit === "%" ? host.t("percentagePoints", "percentage points") : b.unit ? ` ${b.unit}` : ""}`;
    };
    const value = (item: EngineHit | null) => {
      if (!item) return "—";
      const m = metric(item);
      return `${fmt(m.value, m.digits)}${m.unit ? ` ${m.unit}` : ""}`;
    };
    const status = (phase: Phase) =>
      this.phase === phase
        ? host.computationStatus()
        : !this.results[phase]
          ? t("pending")
          : this.results[phase]!.error
            ? t("failed")
            : !completeResponse(this.results[phase]!)
              ? t("partial")
              : !hit(phase)
                ? t("noTeam")
                : t("complete");
    const item = source.input[choice.kind].find((row) => row.key === choice.key)!;
    const actions = teamGrowthActions(choice.kind);
    const title = (key: string) => host.t(actionLabels[key as keyof typeof actionLabels], key);
    const stepText = (steps: typeof change.steps) =>
      steps.map((step) => `${title(step.action)} ${step.from === null ? "—" : stageDisplay(step.action, step.from)} → ${stageDisplay(step.action, step.to)}`).join(" / ");
    const cardHref = (kind: "members" | "snaps", id: number) => {
      const server =
        host.data!.crossServer?.owners[kind === "members" ? "members" : "snapshots"]?.[String(id)] ??
        host.data!.identity.server;
      return `/${server}/${host.locale}/${kind === "members" ? "member-cards" : "support-cards"}/${id}/`;
    };
    const formation = (result: EngineHit, input: EngineRequest) => html`
      <ol class="tb-formation" aria-label=${host.t("formation", "Formation")}>
        ${[1, 2, 0, 3, 4].map(
          (index) => html`
            <li class=${`tb-slot${index === 0 ? " is-leader" : ""}`}>
              ${(["members", "snaps"] as const).map((kind) => {
                const key = result[kind][index],
                  row = input[kind].find((row) => row.key === key);
                const option = row
                  ? catalog.cardOptions(kind, row.cardId, catalog.resolvedGrowth(kind, row, input.unknownPolicy))
                  : null;
                return option
                  ? html`
                      <a
                        class=${kind === "members" ? "tb-slot__member" : "tb-slot__snap"}
                        href=${cardHref(kind, row!.cardId)}
                        aria-label=${option.label}
                      >
                        ${tileMedia(option)}
                      </a>
                    `
                  : html`
                      <span class="tb-slot__empty">${host.t("noSnap", "No snap")}</span>
                    `;
              })}
            </li>
          `,
        )}
      </ol>
    `;
    return html`
      <dialog class="dialog tb-team-growth" data-managed-modal ${modal(() => this.close())} aria-label=${t("title")}>
        <header class="row row--between">
          <strong>${t("title")}</strong>
          <div class="cluster">
            <button
              class="button button--text tb-team-growth__settings-toggle"
              aria-expanded=${this.settingsOpen}
              @click=${() => {
                this.settingsOpen = !this.settingsOpen;
                host.requestUpdate();
              }}
            >
              ${t("scenario")}
            </button>
            ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: () => this.close() })}
          </div>
        </header>
        <div class="tb-team-growth__body">
          <div class="tb-team-growth__results stack">
            <div class="stack">
              <strong lang=${source.hit.song ? catalog.songTitleLanguage(source.hit.song.songId) : host.locale}>${source.hit.song ? catalog.songTitle(source.hit.song.songId) : metric(source.hit).label}</strong>
              <div class="cluster supporting-text">
                ${
                  source.hit.song
                    ? html`
                        <span>${catalog.difficultyLabel(source.hit.song.songId, source.hit.song.difficulty)}</span>
                      `
                    : nothing
                }
                <span>${t("snapshot")}</span>
              </div>
              <div class="stack">
                <span>${catalog.cardName(choice.kind, item.cardId)}</span>
                <span>${stepText(change.steps)}</span>
              </div>
            </div>
            <div class="tb-team-growth__values">
              ${(["fixedBefore", "fixedAfter"] as const).map(
                (phase) => html`
                  <section class="surface stack" data-growth-result=${phase}>
                    <h3 class="detail-section-title">${t(phase)}</h3>
                    <span>${metric(source.hit).label}</span>
                    <strong class="tb-team-growth__value tabular">${value(hit(phase))}</strong>
                    <span class="supporting-text" role="status">
                      ${phase === "fixedBefore" && !this.results.fixedBefore ? t("original") : status(phase)}
                    </span>
                  </section>
                `,
              )}
            </div>
            <dl class="spec-list">
              <div>
                <dt>${t("fixedGain")}</dt>
                <dd class="tabular" data-growth-delta="fixed">${delta(hit("fixedBefore"), hit("fixedAfter"))}</dd>
              </div>
            </dl>
            ${accordion({
              id: "tb-growth-current-team",
              label: host.t("formation", "Formation"),
              expanded: this.expanded.has("current"),
              onExpandedChange: (open) => {
                if (open) this.expanded.add("current");
                else this.expanded.delete("current");
                host.requestUpdate();
              },
              content: formation(hit("fixedAfter") ?? source.hit, hit("fixedAfter") ? change.request! : source.input),
            })}
            ${
              hit("searchAfter")
                ? accordion({
                    id: "tb-growth-new-team",
                    label: t("searchAfter"),
                    expanded: this.expanded.has("new"),
                    onExpandedChange: (open) => {
                      if (open) this.expanded.add("new");
                      else this.expanded.delete("new");
                      host.requestUpdate();
                    },
                    content: html`
                      <div class="stack">
                        ${
                          hit("searchAfter")!.song
                            ? html`
                                <div class="cluster">
                                  <span lang=${catalog.songTitleLanguage(hit("searchAfter")!.song!.songId)}>${catalog.songTitle(hit("searchAfter")!.song!.songId)}</span>
                                  <span>
                                    ${catalog.difficultyLabel(hit("searchAfter")!.song!.songId, hit("searchAfter")!.song!.difficulty)}
                                  </span>
                                </div>
                              `
                            : nothing
                        }
                        ${formation(hit("searchAfter")!, change.request!)}
                      </div>
                    `,
                  })
                : nothing
            }
            <section class="surface stack">
              <h3 class="detail-section-title">${t("searchBefore")}</h3>
              <div class="row row--between">
                <strong class="tabular">${value(hit("searchBefore"))} → ${value(hit("searchAfter"))}</strong>
                <span role="status">${status("searchBefore")}</span>
              </div>
              <dl class="spec-list">
                <div>
                  <dt>${t("searchGrowthGain")}</dt>
                  <dd class="tabular" data-growth-delta="search">${delta(hit("searchBefore"), hit("searchAfter"))}</dd>
                </div>
              </dl>
            </section>
          </div>
          <aside class=${`surface stack tb-team-growth__settings${this.settingsOpen ? " is-open" : ""}`}>
            <div class="stack tb-team-growth__fields">
              <h3 class="detail-section-title">${t("scenario")}</h3>
              <span class="tb-field__label">${host.t("growthComparison.card", "Card")}</span>
              <button
                class="button button--outlined button--full"
                type="button"
                data-growth-card-picker
                ?disabled=${!!this.phase}
                @click=${() => {
                  host.slotPicker = { growth: true, kind: choice.kind };
                  host.requestUpdate();
                }}
              >${icon("search", 20)}<span class="truncate">${catalog.cardName(choice.kind, item.cardId)}</span></button>
              <div class="stack stack--tight" role="group" aria-label=${host.t("growthComparison.action", "Training")}>
                <span class="tb-field__label">${host.t("growthComparison.action", "Training")}</span>
                <div class="cluster tb-growth-options">
                  ${actions.map((action) => {
                    const selected = choice.actions.includes(action);
                    const step = change.steps.find((row) => row.action === action);
                    return html`
                      <button class="chip" type="button" role="checkbox" aria-checked=${String(selected)} ?disabled=${!!this.phase}
                        @click=${() => this.select({ actions: selected ? choice.actions.filter((item) => item !== action) : [...choice.actions, action] })}>
                        ${selected ? icon("check", 18) : nothing}
                        <span class="chip__label">${title(action)}</span>
                        ${step ? html`<span class="chip__count tabular">${step.from === null ? "—" : stageDisplay(action, step.from)} → ${stageDisplay(action, step.to)}</span>` : nothing}
                      </button>
                    `;
                  })}
                </div>
                <div class="cluster tb-growth-actions">
                  <button class="button button--text button--small" type="button" ?disabled=${!!this.phase}
                    @click=${() => this.select({ actions: [...actions] })}>${host.t("quickOwnAll", "Select all")}</button>
                  <button class="button button--text button--small" type="button" ?disabled=${!!this.phase || !choice.actions.length}
                    @click=${() => this.select({ actions: [] })}>${host.common("common.actions.clear", "Clear")}</button>
                </div>
              </div>
              ${segmented({
                label: host.t("growthComparison.target", "Target level"),
                value: choice.target,
                options: [
                  { value: "next" as const, label: host.t("tg.targetNext", "Next stage"), disabled: !!this.phase },
                  { value: "cap" as const, label: host.t("tg.targetMax", "Max"), disabled: !!this.phase },
                ],
                onSelect: (target) => this.select({ target }),
              })}
              <div class="tb-team-growth__transition tabular">
                ${change.status === "ready" ? stepText(change.steps) : host.t(`growthComparison.status.${change.status}`, change.status)}
              </div>
              ${
                change.status === "missing-state"
                  ? html`
                      <button
                        class="button button--text"
                        @click=${() => {
                          this.close();
                          host.setTab("box");
                          if (host.view?.[choice.kind].has(item.cardId))
                            host.editing = { kind: choice.kind, cardId: item.cardId };
                        }}
                      >
                        ${host.t("growthComparison.edit", "Enter growth")}
                      </button>
                    `
                  : nothing
              }
              <dl class="spec-list supporting-text">
                <div>
                  <dt>${t("pool")}</dt>
                  <dd>${source.input.members.length} / ${source.input.snaps.length}</dd>
                </div>
                <div>
                  <dt>${host.t("unknownPolicy", "Growth not entered")}</dt>
                  <dd>
                    ${host.t(source.input.unknownPolicy === "max" ? "unknownMax" : "unknownMin", source.input.unknownPolicy)}
                  </dd>
                </div>
              </dl>
            </div>
            <div class="tb-team-growth__status" role="status" data-active=${!!(this.error || this.phase)}>
              ${
                this.error ||
                (this.phase
                  ? html`
                      <span>${t(this.phase)}</span>
                      <span>${host.computationStatus()}</span>
                    `
                  : nothing)
              }
            </div>
            ${
              this.phase
                ? html`
                    <button class="button button--tonal" @click=${() => this.stop()}>
                      ${host.common("common.actions.cancel", "Cancel")}
                    </button>
                  `
                : html`
                    <button
                      class="button"
                      data-growth-run="fixed"
                      ?disabled=${change.status !== "ready" || host.running}
                      @click=${() => void this.run()}
                    >
                      ${t("runFixed")}
                    </button>
                    <button
                      class="button button--tonal"
                      data-growth-run="search"
                      ?disabled=${!this.results.fixedAfter || !completeResponse(this.results.fixedAfter) || !!this.results.fixedAfter.error || host.running}
                      @click=${() => void this.run(true)}
                    >
                      ${t(this.results.searchAfter && !completeResponse(this.results.searchAfter) ? "continue" : "runSearch")}
                    </button>
                  `
            }
            ${accordion({
              id: "tb-growth-materials",
              label: t("materials"),
              expanded: this.expanded.has("materials"),
              onExpandedChange: (open) => {
                if (open) this.expanded.add("materials");
                else this.expanded.delete("materials");
                host.requestUpdate();
              },
              content: this.materials(item.cardId),
            })}
          </aside>
        </div>
      </dialog>
    `;
  }
}
