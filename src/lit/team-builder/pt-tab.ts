import type { ComparisonSettings, Formation } from "../../lib/team-builder/song-comparison";
import { skillRoleControls } from "./skill-role-controls";
import { farmingRewardPlan, renderRewardPlan } from "./reward-plan-view";
import { toolLayout } from "./tool-layout";
import { renderParking } from "./parking-view";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { TeamBuilder } from "../team-builder";
import type { EngineHit, EngineRequest, SongRef } from "../../lib/team-builder/engine/api";
import { multiSongControl, songRulesControl } from "./song-rules";
import { validatePtRequest, type PtIssue } from "../../lib/team-builder/engine/pt-eligibility";
import {
  canonical,
  createPtJob,
  digest,
  ptComplete,
  ptAllComplete,
  ptChallengeBest,
  ptChallengeCharts,
  ptFollowUpTotals,
  ptFingerprint,
  PtRunner,
  ptSongRanking,
  type PtJob,
  type PtCycleInput,
  type PtMeasure,
  type PtScope,
} from "../../lib/team-builder/pt-recommendation";
import { clock, completeResponse, improvementPercent, pendingSong } from "../../lib/team-builder/engine/execution";
import { PtCheckpoint } from "../../lib/team-builder/pt-checkpoint";
import { teamFormation, renderHit, renderResults } from "./results";
import {
  renderBuildTab,
  renderBuildRun,
  renderCandidates,
  comboBonusControl,
  justWindowControl,
  gekisoSamplesControl,
  eventSection,
  eventSectionHeading,
  useChallengeSongsButton,
  playSection,
  songList,
} from "./build-tab";
import { choiceField, sectionHeading } from "./catalog";
import { renderChecklist } from "./tool-layout";
import { boostControl, challengeCostControl } from "./boost-control";
import { rovingKeydown, segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { accordion } from "../ui/accordion";
import { issueField, ptField, ptFieldInvalid } from "./pt-fields";
import { chartKey, farmingConditions, farmingMode, farmingSettings, resolveLuckSamples, justWindowGoal } from "./workspace-state";
import type { BuildSettings, FarmingSettings } from "./types";
import { usesPtResults } from "./score-goal";
import { changeRewardMode, legacyRewardPlan } from "../../lib/team-builder/reward-plan";

export class PtController {
  parking = false;
  private task: symbol | null = null;
  job: PtJob | null = null;
  running = false;
  showAll = false;
  followUp: { key: string | EngineRequest; normal?: SongRef; challenge?: SongRef; plays?: number; cp?: number } | null = null;
  get measure(): PtMeasure {
    return farmingSettings(this.host.settings).measure === "items" ? "items" : "points";
  }
  set measure(measure: PtMeasure) {
    this.host.updateFarming({ measure });
  }
  storageError = false;
  error = "";
  dataFingerprint = "";
  showIssues = false;
  issues: PtIssue[] = [];
  correcting = false;
  async focusIssue(issue: PtIssue) {
    const field = issueField(issue);
    if (!field) return;
    this.correcting = true;
    const host = this.host;
    const card = /^(m|s)(\d+)\./u.exec(field);
    if (card) {
      host.tab = "pt";
      host.editing = { kind: card[1] === "m" ? "members" : "snaps", cardId: Number(card[2]) };
    } else host.tab = /^(cr|bi|p)\./u.test(field) ? "account" : field === "inventory" ? "box" : "pt";
    if (field === "constraints" || field === "minBonus") host.expanded.add("candidates");
    if (field === "gekiso-input") host.expanded.add("farm-advanced");
    host.requestUpdate();
    await host.updateComplete;
    await host.ensureConditionsVisible();
    const target = host.querySelector<HTMLElement>(`[data-pt-field="${CSS.escape(field)}"]`);
    if (!target) return;
    const disclosures: HTMLDetailsElement[] = [];
    for (let parent = target.parentElement; parent && parent !== host; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        parent.open = true;
        disclosures.push(parent);
      }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    target.getBoundingClientRect();
    await Promise.allSettled(
      disclosures.flatMap((node) => node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    target.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    const control = target.querySelector<HTMLElement>("#tb-luck-samples") ?? target.querySelector<HTMLElement>(
      "input, md-outlined-text-field, md-outlined-select, md-slider, button:not([disabled]), md-checkbox",
    );
    if (control && "updateComplete" in control) await control.updateComplete;
    (control ?? target).focus({ preventScroll: true });
  }
  markFields() {
    for (const field of this.host.querySelectorAll<HTMLElement>("[data-pt-field]")) {
      const invalid = ptFieldInvalid(this.host, field.dataset.ptField!);
      for (const control of field.querySelectorAll<HTMLElement>(
        "input, md-outlined-text-field, md-outlined-select, md-checkbox",
      )) {
        const value = invalid || control.closest("[data-tb-field][data-invalid]") ? "true" : null;
        if (control.ariaInvalid !== value) control.ariaInvalid = value;
      }
    }
  }
  private signature = "";
  private restoreKey = "";
  private generation = 0;
  private runner: PtRunner | null = null;
  private readonly store = new PtCheckpoint();
  constructor(private readonly host: TeamBuilder) {}
  get fixedTeam() {
    const host = this.host;
    return host.tab === "pt" && host.settings.rewardMode !== "plan" && !this.parking ? host.settings.farming.fixedTeam : null;
  }
  openRewards(team: Formation, songs: SongRef[], conditions: {
    event?: ComparisonSettings["farmingEvent"]; just?: number | null; players?: number; songRules?: BuildSettings["songRules"];
  }) {
    const host = this.host;
    host.setTab("pt");
    this.parking = false;
    const farming: FarmingSettings = { ...host.settings.farming, fixedTeam: structuredClone(team),
      play: conditions.event?.challenge ? "challenge" : "gekiso",
      ...(conditions.players ? { rewardPlayers: conditions.players } : {}),
    };
    if (farming.ptCycle && farming.play === "gekiso" && !farming.rewardPlan && farmingMode(farming) === "event")
      farming.rewardPlan = legacyRewardPlan(farmingConditions(farming));
    host.updateSettings({
      farming, rewardMode: farmingMode(farming), songs: structuredClone(songs), songRules: conditions.songRules,
      ...(conditions.event ? { eventId: conditions.event.id } : {}),
      manualEventEnabled: false, ptJust: conditions.just ?? host.settings.ptJust,
    });
  }
  private get owner() {
    return this.host.checkpointOwner;
  }
  request(): EngineRequest | null {
    const { view } = this.host;
    const s = this.host.effectiveSettings("recommendation");
    if (!view) return null;
    const request = this.host.request({
      kind: "event",
      ranking: "pt-only",
      measure: this.measure,
      route: "live",
      eventId: s.eventId ?? -1,
      songs: [...s.songs].sort((a, b) => a.songId - b.songId || a.difficulty - b.difficulty),
      consumption: s.boosts,
      play: { great: 0, good: 0, bad: 0, miss: 0 },
      ...(s.ptMode === "gekiso"
        ? {
            gekiso: {
              just: s.ptJust / 100,
              luckSamples: resolveLuckSamples(s, "rewards"),
              rank: 1 as const,
              minComboBonus: s.minComboBonus,
              ...justWindowGoal(s),
            },
          }
        : {}),
    });
    if (!request) return null;
    return {
      ...request,
      snaps: s.noSnaps ? [] : request.snaps,
      unknownPolicy: "min",
      player: {
        ...structuredClone(request.player),
        characterMemory: Object.fromEntries([...(this.host.master?.characters.keys() ?? [])].map((id) => [id, 0])),
        musicMemory: Object.fromEntries([...(this.host.master?.songs.keys() ?? [])].map((id) => [id, 0])),
      },
      k: 1,
      timeLimitMs: 3000,
    };
  }
  cycle(): PtCycleInput | null {
    if (!this.host.effectiveSettings("recommendation").ptCycle) return null;
    return {
      songs: [...this.host.effectiveSettings("recommendation").planChallengeSongs].sort(
        (a, b) => a.songId - b.songId || a.difficulty - b.difficulty,
      ),
      consumption: this.host.settings.challengePoints,
    };
  }
  private inputSignature() {
    return canonical([this.request(), this.cycle(), this.owner, this.host.data?.identity]);
  }
  sync() {
    const custom = this.host.settings.rewardMode === "event";
    const request = custom ? this.host.request() : this.request();
    const signature = custom
      ? canonical([request, this.host.settings.farming.requireGrowth, this.owner, this.host.data?.identity])
      : this.inputSignature();
    if (signature !== this.signature) {
      if (this.running) this.stop();
      this.signature = signature;
      this.issues = [];
      if (custom) {
        if (request?.goal.kind === "event" && this.host.master && this.host.settings.farming.requireGrowth) {
          // Reuse recorded-input qualification without imposing the AP-only search contract on custom rewards.
          const qualified = {
            ...request,
            k: 1,
            player: {
              ...request.player,
              characterMemory: Object.fromEntries(
                [...this.host.master.characters.keys()].map((id) => [id, request.player.characterMemory[id] ?? 0]),
              ),
            },
            goal: {
              ...request.goal,
              ranking: "pt-only" as const,
              route: "live" as const,
              measure: "points" as const,
              play: { great: 0, good: 0, bad: 0, miss: 0 },
              songs: [],
            },
          };
          this.issues = validatePtRequest(this.host.master, qualified).filter((issue) =>
            ["practice", "player", "inventory", "constraint"].includes(issue.code),
          );
        }
        return;
      }
      if (request?.goal.kind === "event" && this.host.master) {
        for (const route of (this.cycle() ? ["live", "challenge"] : ["live"]) as ("live" | "challenge")[])
          for (const measure of [this.measure]) {
            const goal = { ...request.goal, route, measure };
            if (route === "live") goal.cpExchange = { numerator: 0, denominator: 1 };
            else {
              goal.songs = this.cycle()!.songs;
              goal.consumption = this.cycle()!.consumption;
              delete goal.gekiso;
            }
            // The native request validates skill programs; retained TS scoring has a smaller skill set.
            this.issues.push(...validatePtRequest(this.host.master, { ...request, goal }).filter((issue) => issue.code !== "skill"));
          }
        if (this.cycle() && !this.cycle()!.songs.length)
          this.issues.push({ code: "chart", target: "challenge-selection" });
        this.issues = [...new Map(this.issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
      }
    }
  }
  get noFeasibleTeams(): boolean {
    if (!this.job || this.stale) return false;
    const tasks = this.job.tasks.filter(task => task.route === "live");
    return tasks.length > 0 && tasks.every(task => task.status === "empty" && task.result?.proven && !task.result.hits.length);
  }
  get stale() {
    return (
      !!this.job &&
      (this.host.settings.rewardMode !== "recommendation" ||
        !!this.job.presentation && this.job.presentation.scope !== this.host.searchSettings.scope ||
        canonical([this.job.request, this.job.cycle, this.job.owner, this.host.data?.identity]) !==
          this.inputSignature() ||
        this.job.owner !== this.owner ||
        this.job.dataFingerprint !== this.dataFingerprint)
    );
  }
  async restore() {
    const data = this.host.data;
    if (!data || this.host.snapshot?.owner === undefined) return;
    const key = `${data.identity.server}|${this.owner}|${data.identity.releaseId}`;
    if (key === this.restoreKey) return;
    this.stop();
    this.job = null;
    this.dataFingerprint = "";
    this.restoreKey = key;
    const generation = ++this.generation;
    const owner = this.owner;
    let hash = "";
    try {
      hash = await digest(data);
      const [job, saved] = await Promise.all([
        this.store.latest(data.identity.server, owner),
        this.store.latestResult<BuildSettings>(data.identity.server, owner),
      ]);
      if (generation !== this.generation) return;
      for (const task of job?.tasks ?? []) if (task.status === "running") task.status = "queued";
      this.dataFingerprint = hash;
      this.job = job?.dataFingerprint === hash ? job : null;
      if (!this.host.farmResultMode) {
        if (saved?.dataFingerprint === hash && saved.owner === owner && saved.updatedAt >= (this.job?.updatedAt ?? 0)) {
          this.host.restoreFarmingResult(saved.response, saved.settings, saved.request, saved.contextKey, saved.session);
          this.host.farmResultMode = "event";
        } else if (this.job) this.host.farmResultMode = "recommendation";
      }
      this.storageError = false;
    } catch (error) {
      console.warn("pt-checkpoint-restore", error);
      if (generation !== this.generation) return;
      this.dataFingerprint = hash;
      this.storageError = true;
      if (!hash) this.error = "pt-data-fingerprint";
    }
    this.host.requestUpdate();
  }
  async rememberResult() {
    const host = this.host;
    if (!host.data || !host.results || !host.resultInputs || !host.resultSettings || !this.dataFingerprint
        || !completeResponse(host.results) || host.results.stopReason !== "complete") return;
    const generation = this.generation;
    try {
      await this.store.saveResult({ server: host.data.identity.server, owner: this.owner, dataFingerprint: this.dataFingerprint,
        contextKey: host.resultsFor, request: host.resultInputs, response: host.results, settings: host.resultSettings,
        session: host.resultSession, updatedAt: Date.now() });
    } catch {
      if (generation === this.generation) this.storageError = true;
    }
  }
  stop() {
    if (!this.task) return;
    ++this.generation;
    if (this.host.ownsTask(this.task)) {
      this.runner?.stop();
      this.host.releaseTask(this.task);
    }
    this.task = null;
    this.runner = null;
    this.running = false;
    this.host.requestUpdate();
  }
  dispose() {
    this.correcting = false;
    ++this.generation;
    this.stop();
    this.task = null;
    this.running = false;
    this.job = null;
    this.restoreKey = "";
    this.dataFingerprint = "";
    this.storageError = false;
    this.error = "";
  }
  async start(resume: boolean, scope?: PtScope, untilProven = false) {
    this.sync();
    const host = this.host;
    host.submitted = true;
    const inputIssues = host.inputIssues(true);
    if (inputIssues.length) {
      host.requestUpdate();
      await host.updateComplete;
      host.focusInput(inputIssues[0]!.field);
      return;
    }
    if (this.issues.length) {
      this.showIssues = true;
      host.requestUpdate();
      await host.updateComplete;
      await this.focusIssue(this.issues[0]!);
      return;
    }
    const request = this.request();
    if (
      !request ||
      !host.engine ||
      !host.data ||
      host.running ||
      host.manualBusy ||
      this.issues.length ||
      !this.dataFingerprint
    )
      return;
    const task = host.acquireTask("pt");
    if (!task) return;
    this.task = task;
    const generation = ++this.generation;
    const cycle = this.cycle();
    const signature = this.inputSignature();
    const engine = host.engine;
    const cardScope = host.searchSettings.scope;
    const current = () => generation === this.generation && host.ownsTask(task) && host.engine === engine &&
      host.tab === "pt" && host.settings.rewardMode === "recommendation" && cardScope === host.searchSettings.scope && signature === this.inputSignature();
    this.running = host.running = true;
    this.error = "";
    host.requestUpdate();
    try {
      let job = this.job;
      const fingerprint = await ptFingerprint(request, this.dataFingerprint, this.owner, cycle);
      if (!current()) return;
      if (!resume || !job || job.fingerprint !== fingerprint) {
        if (resume) throw new Error("pt-input-changed");
        job = await createPtJob(
          request,
          {
            server: host.data.identity.server,
            releaseId: host.data.identity.releaseId,
            sourceId: host.data.identity.sourceId ?? "",
            owner: this.owner,
            dataFingerprint: this.dataFingerprint,
            assumptions: [],
          },
          cycle,
        );
        job.presentation = { scope: host.searchSettings.scope, maxAccountBonuses: host.searchSettings.maxAccountBonuses };
      }
      if (!current()) return;
      if (!untilProven || job.budgetSeconds === undefined) job.budgetSeconds = host.searchSettings.timeLimit;
      const deadline = untilProven || job.budgetSeconds === null ? Infinity : clock() + job.budgetSeconds * 1000;
      this.job = job;
      host.calculationSubmitted();
      host.farmResultMode = "recommendation";
      this.runner = new PtRunner(
        engine,
        this.store,
        () => host.requestUpdate(),
        () => {
          if (generation === this.generation) {
            this.storageError = true;
            host.requestUpdate();
          }
        },
        current,
      );
      await this.runner.run(job, scope, deadline);
    } catch (error) {
      if (current()) this.error = host.errorReason(error);
    } finally {
      if (this.task === task) {
        this.running = false;
        this.runner = null;
        this.task = null;
      }
      host.releaseTask(task);
      host.requestUpdate();
    }
  }
}

function inputLabel(host: TeamBuilder, target: string): string {
  const [key = "", field = ""] = target.split(".");
  const catalog = host.catalog!;
  const titles: Record<string, string> = {
    "p.vip": host.t("vipRank", "T.G.W card rank"),
    "five-characters": host.t("pt.fiveCharacters", "At least five different characters"),
    selection: host.t("chooseSongs", "Choose songs"),
    "challenge-selection": host.t("pt.chooseChallenge", "Challenge songs"),
    tables: host.t("pt.eventTables", "Event consumption tables"),
    consumption: host.t("boosts", "Boosts per live"),
    "challenge-consumption": host.t("pt.challengeCost", "CP per challenge"),
    "gekiso-input": host.t("pt.gekiso", "GEKISO"),
    minBonus: host.t("minBonus", "Minimum event bonus (%)"),
    member: host.t("members", "Members"),
    snap: host.t("snapshots", "Snapshots"),
    "required-member-count": host.t("pt.requiredMemberCount", "More than five required members"),
    "photo-bindings": host.t("pt.photoBindings", "A snapshot is bound twice"),
  };
  if (titles[target]) return titles[target];
  if (key === "required-members" && field) {
    const characterId = Number(field);
    return host.t("pt.requiredMembers", "Two required cards share {character}", {
      character: catalog.characterName(characterId) || `#${characterId}`,
    });
  }
  const fields: Record<string, string> = {
    level: host.t("level", "Level"),
    awake: host.t("training", "Training"),
    rank: host.t("awakening", "Awakening"),
    liveSkillLevel: host.t("liveSkill", "Live skill"),
    gekisoSkillLevel: host.t("gekisoSkill", "GEKISO skill"),
    cr: host.t("characterRanks", "Character ranks"),
    bi: host.t("bandItems", "Band items"),
  };
  const card = /^([ms])(\d+)(?:[.:/]|$)/u.exec(target);
  if (card)
    return `${catalog.cardName(card[1] === "m" ? "members" : "snaps", Number(card[2]))}${fields[field] ? ` / ${fields[field]}` : ""}`;
  const song = /^(?:challenge:|gekiso:)?(\d+):(\d+)$/u.exec(target);
  if (song)
    return `${catalog.songTitle(Number(song[1]))} / ${catalog.difficultyLabel(Number(song[1]), Number(song[2]))}`;
  if (key === "cr") return `${catalog.characterName(Number(field))} / ${fields[key]}`;
  if (key === "bi") return `${catalog.text(host.data!.bandItems[field]?.name) || `#${field}`} / ${fields[key]}`;
  return target;
}

function renderSetup(host: TeamBuilder): TemplateResult {
  const s = host.searchSettings,
    f = farmingConditions(s.farming),
    catalog = host.catalog!;
  const set = (patch: Partial<FarmingSettings>) => host.updateFarming(patch);
  const fixedTeam = host.pt.fixedTeam;
  const event = s.eventId === null ? undefined : host.master!.events.get(s.eventId);
  const challengeSongs = catalog.challengeSongs(s.eventId).map((row) => row.liveMusicId);
  const normal = !event || !!event.livePoints.size || !!event.liveRewards.length;
  const challenge = !s.manualEventEnabled &&
    (!event || ((!!event.challengePoints.size || !!event.challengeRewards.length) && challengeSongs.length > 0));
  const plays = [
    { value: "solo", label: host.t("routeLive", "Normal live"), icon: icon("play_arrow", 20), available: normal },
    {
      value: "gekiso",
      label: host.t("pt.gekiso", "GEKISO"),
      icon: icon("local_fire_department", 20),
      available: normal,
    },
    {
      value: "challenge",
      label: host.t("routeChallenge", "Challenge live"),
      icon: icon("swords", 20),
      available: challenge,
    },
    { value: "skip", label: host.t("routeSkip", "Skip"), icon: icon("fast_forward", 20), available: normal },
  ] as const;
  const available = plays.filter((play) => play.available).map((play) => play.value);
  const plan = farmingRewardPlan(host);
  const autoCp = !plan.bonus && plan.options["challenge-points"].mode === "convert" && plan.options["challenge-points"].auto;
  return html`
    <section class="surface stack">
      ${eventSectionHeading(host, { icon: "emoji_events", label: host.t("eventSetup", "Event") })}
      ${ptField(host, "event", eventSection(host, s, { manageInHeading: true }))}
      <div
        class="cluster tb-goals"
        role="radiogroup"
        aria-label=${host.t("pt.mode", "Play mode")}
        @keydown=${rovingKeydown(available, f.play, (play) => set({ play }))}
      >
        ${plays
          .filter((play) => play.available || play.value === f.play)
          .map(
            (play) => html`
              <button
                class="chip"
                type="button"
                role="radio"
                aria-checked=${f.play === play.value}
                tabindex=${f.play === play.value ? "0" : "-1"}
                ?disabled=${!play.available}
                @click=${() => set({ play: play.value })}
              >
                ${f.play === play.value ? icon("check", 18) : play.icon}<span class="chip__label">${play.label}</span>
              </button>
            `,
          )}
      </div>
      ${
        s.route === "challenge"
          ? challengeCostControl(host, s.challengePoints, challengePoints => host.updateSettings({ challengePoints }))
          : ptField(
              host,
              "consumption",
              boostControl(host, s.boosts, (boosts) => host.updateSettings({ boosts })),
            )
      }
      ${s.route === "live" && challenge && !plan.bonus && plan.primary !== "challenge-points" ? html`
        <label class="tb-check" id="tb-reward-scope">
          <md-checkbox touch-target="wrapper" .checked=${autoCp}
            @change=${(event: Event) => {
              const checked = (event.target as HTMLInputElement).checked;
              const next = changeRewardMode(plan, "challenge-points", checked ? "convert" : "ignore");
              next.options["challenge-points"].auto = checked;
              set({ rewardPlan: next, ptCycle: false, weighted: false, measure: next.primary });
            }}></md-checkbox>
          <span>${host.t("farm.cpConversion", "Include challenge rewards from earned CP")}</span>
        </label>` : nothing}
    </section>
    ${s.ptMode === "gekiso" && s.route === "live" ? html`
      <section class="surface stack" id="tb-reward-room" data-tb-field tabindex="-1">
        ${sectionHeading({ icon: "groups", label: host.t("rewardPlan.room", "Score grading") })}
        ${segmented({ label: host.t("rewardPlan.room", "Score grading"), value: s.rewardRoomMode,
          options: [
            { value: "battle", label: host.t("rewardPlan.battle", "Multiplayer") },
            { value: "solo", label: host.t("rewardPlan.solo", "Solo Mission") },
          ], onSelect: (rewardRoomMode) => set({ rewardRoomMode }) })}
        ${s.rewardRoomMode === "battle" ? html`
          ${segmented({ label: host.t("rewardPlan.players", "Players"), value: String(s.rewardPlayers),
            options: [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) })),
            onSelect: value => set({ rewardPlayers: Number(value) }) })}
          ${s.rewardPlayers > 1 ? html`<md-outlined-text-field type="number" min="0" max="2147483647" step="1"
            label=${host.t("rewardPlan.otherScore", "Other players’ average score")}
            .value=${s.rewardOtherScore === null ? "" : String(s.rewardOtherScore)}
            placeholder=${host.t("rewardPlan.equalScore", "Same score as you")}
            @change=${(event: Event) => { const value = (event.target as HTMLInputElement).value.trim(); set({ rewardOtherScore: value ? Number(value) : null }); }}
          ></md-outlined-text-field>` : nothing}
        ` : nothing}
      </section>` : nothing}
    ${renderRewardPlan(host, plan)}
    ${
      s.route !== "skip"
        ? html`
            <section class="surface stack">
              ${sectionHeading({ icon: "library_music", label: host.t("songs", "Songs"), count: s.songs.length })}
              ${ptField(
                host,
                "selection",
                songList(
                  host,
                  host.settings.songs,
                  (songs) => host.updateSettings({ songs }),
                  false,
                  s.route === "challenge" ? challengeSongs : catalog.normalEventSongIds(s.manualEventEnabled ? null : s.eventId),
                  "tb-songs",
                  undefined,
                  { poolAction: s.route === "challenge" && !s.manualEventEnabled
                    ? useChallengeSongsButton(host, challengeSongs, (songs) => host.updateSettings({ songs }))
                    : nothing },
                ),
              )}
              ${multiSongControl(host)}
              ${songRulesControl(host)}
              ${
                autoCp
                  ? html`
                      <span class="tb-field__label">${host.t("planChallengeSongs", "Challenge songs")}</span>
                      ${ptField(
                        host,
                        "challenge-selection",
                        songList(
                          host,
                          host.settings.planChallengeSongs,
                          (planChallengeSongs) => host.updateSettings({ planChallengeSongs }),
                          false,
                          challengeSongs,
                          "tb-challenge-songs",
                          undefined,
                          { poolAction: useChallengeSongsButton(host, challengeSongs, (planChallengeSongs) => host.updateSettings({ planChallengeSongs })) },
                        ),
                      )}
                      ${ptField(
                        host,
                        "challenge-consumption",
                        challengeCostControl(host, s.challengePoints, challengePoints => host.updateSettings({ challengePoints })),
                      )}
                    `
                  : nothing
              }
            </section>
          `
        : nothing
    }
    ${fixedTeam ? html`<section class="surface stack" id="tb-cards">
      ${sectionHeading({ icon: "groups", label: host.t("farm.fixedTeam", "Fixed team") })}
      ${teamFormation(host, fixedTeam.members.flatMap((member, i) => member === null ? [] :
        [{ member, snap: fixedTeam.snaps[i] ?? null }]), fixedTeam.leader, false)}
      <button type="button" class="button button--text" @click=${() => set({ fixedTeam: null })}>
        ${host.t("farm.releaseTeam", "Choose from my cards")}
      </button>
    </section>` : renderCandidates(host)}
      ${host.searchSettings.ptMode === "gekiso" ? skillRoleControls(host) : nothing}
    <section class="surface stack">
      ${sectionHeading({ icon: "piano", label: host.t("farm.conditions", "Play and account conditions") })}
      ${
        f.play === "gekiso"
          ? html`
              <span class="tb-results__meta">
                ${host.t("playAp", "All Perfect")} / ${host.t("gekisoPlacements", "Scoring placements")}: 1
              </span>
              ${comboBonusControl(host)}
              ${justWindowControl(host)}
              ${
                host.hasMission("JustCount")
                  ? ptField(
                      host,
                      "gekiso-input",
                      html`
                        <md-outlined-text-field
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          label=${host.t("pt.baselineJust", "Baseline JUST (%)")}
                          .value=${live(String(s.ptJust))}
                          @change=${(e: Event) => host.updateSettings({ ptJust: Number((e.target as HTMLInputElement).value) })}
                        ></md-outlined-text-field>
                      `,
                    )
                  : nothing
              }
            `
          : f.play !== "skip"
            ? playSection(host, s, (patch) => set(patch))
            : nothing
      }
      ${accordion({
        id: "tb-farm-advanced",
        label: host.t("farm.advanced", "Advanced conditions"),
        expanded: host.expanded.has("farm-advanced"),
        onExpandedChange: (expanded) => {
          if (expanded) host.expanded.add("farm-advanced");
          else host.expanded.delete("farm-advanced");
          host.requestUpdate();
        },
        content: html`
          <div class="stack">
            ${
              f.play === "gekiso"
                ? ptField(
                    host,
                    "gekiso-input",
                    gekisoSamplesControl(host, "rewards"),
                  )
                : html`
                    <label class="tb-check">
                      <md-checkbox
                        touch-target="wrapper"
                        .checked=${f.includeMemory}
                        @change=${(e: Event) => set({ includeMemory: (e.target as HTMLInputElement).checked })}
                      ></md-checkbox>
                      <span>${host.t("farm.memory", "Character and song memory bonuses")}</span>
                    </label>
                    ${!s.rewardPlan ? html`
                    <label class="tb-check">
                      <md-checkbox
                        touch-target="wrapper"
                        .checked=${f.fullRanking}
                        @change=${(e: Event) => set({ fullRanking: (e.target as HTMLInputElement).checked })}
                      ></md-checkbox>
                      <span>${host.t("fullRanking", "Full reward ranking")}</span>
                    </label>
                    ` : nothing}
                    ${choiceField({
                      type: "select",
                      label: host.t("resultCount", "Results"), value: String(f.k),
                      options: [1,3,5,10,15,20].map(k => ({value: String(k), label: String(k)})),
                      onSelect: value => set({k: Number(value)}),
                    })}
                  `
            }
            ${choiceField({
              type: "select",
              label: host.t("timeLimit", "Time limit"), value: String(f.timeLimit ?? 0),
              options: [0,3,5,15,60].map(limit => ({value: String(limit), label: limit
                ? host.t("secondsShort", "{count} s", {count: limit}) : host.t("noLimit", "Until proven")})),
              onSelect: value => set({timeLimit: Number(value) || null}),
            })}
          </div>
        `,
      })}
      <span class="tb-results__meta">
        ${host.t("farm.memory", "Character and song memory bonuses")}:
        ${f.includeMemory ? host.t("farm.included", "Included") : host.t("farm.excluded", "Excluded")}
      </span>
    </section>
  `;
}

function renderIssues(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  return html`
    <section class="surface stack pt-issues" id="pt-issues" tabindex="-1">
      ${sectionHeading({ icon: "error", label: t("needsInput", "Inputs to complete"), count: pt.issues.length })}
      <ul class="pt-issue-list" role="list">
        ${pt.issues.map((issue) => {
          const label = inputLabel(host, issue.target);
          return html`
            <li>
              <span>${label}</span>
              ${
                issueField(issue)
                  ? html`
                      <button
                        class="button button--text"
                        type="button"
                        aria-label=${t("locateInput", "Edit {input}", { input: label })}
                        @click=${() => void pt.focusIssue(issue)}
                      >
                        ${t("fixInput", "Edit")}${icon("arrow_forward", 18)}
                      </button>
                    `
                  : nothing
              }
            </li>
          `;
        })}
      </ul>
    </section>
  `;
}

function renderRun(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string) => host.t(`pt.${key}`, fallback);
  const job = pt.job;
  const blocked = host.running || host.manualBusy || !pt.dataFingerprint;
  const resume = !!job && !ptComplete(job) && !pt.stale;
  const budget = host.searchSettings.timeLimit;
  return html`
    <div class="tb-run">
      ${
        pt.running
          ? html`
              <span role="status">${host.computationStatus()}</span>
            `
          : nothing
      }
      ${
        host.hasTaskResults
          ? html`
              <button
                class="button button--text tb-run__results"
                @click=${() => host.querySelector(".tb-results-column")?.scrollIntoView({ block: "start" })}
              >
                ${host.t("viewResults", "View results")}
              </button>
            `
          : nothing
      }
      ${
        pt.running
          ? html`
              <button class="button button--tonal button--full tb-run__button" type="button" @click=${() => pt.stop()}>
                ${icon("stop", 18)}${t("stop", "Stop")}
              </button>
            `
          : html`
              <button
                class="button button--full tb-run__button"
                type="button"
                ?disabled=${blocked}
                @click=${() => void pt.start(resume)}
              >
                ${icon("search", 20)}${host.submitted && host.inputIssues(true).length ? host.t("fixConditions", "Adjust {count} conditions", { count: host.inputIssues(true).length }) : resume && budget ? host.t("modeSearch.extend", "Continue for {count} s", { count: budget }) : resume ? host.t("continueOptimal", "Continue verifying optimality") : pt.stale ? host.t("rerun", "Search again") : host.t("farm.run", "Recommend songs and teams")}
              </button>
              ${resume && budget ? html`<button class="button button--text" type="button" ?disabled=${blocked}
                @click=${() => void pt.start(true, undefined, true)}>${host.t("modeSearch.untilProven", "Continue until verified")}</button>` : nothing}
            `
      }
      ${
        pt.storageError
          ? html`
              <p class="field-note">${t("storageError", "Progress can't be saved on this device.")}</p>
            `
          : nothing
      }
      ${
        pt.error
          ? html`
              <p class="field-note" role="alert">${t("runError", "Calculation failed.")}</p>
            `
          : nothing
      }
    </div>
  `;
}

function renderFollowUp(host: TeamBuilder, key: string | EngineRequest, measure: PtMeasure, cost: number,
                        normalRows: EngineHit[], challengeRows: EngineHit[], stale: boolean) {
  const pt = host.pt;
  const saved = pt.followUp?.key === key ? pt.followUp : { key };
  const choose = (rows: EngineHit[], song?: SongRef) =>
    (song && rows.find(row => chartKey(row.song!) === chartKey(song))) || rows[0]!;
  const normal = choose(normalRows, saved.normal);
  const challenge = choose(challengeRows, saved.challenge);
  const defaultPlays = normal.event!.challengePoints > 0 ? Math.ceil(cost / normal.event!.challengePoints) : 1;
  const plays = saved.plays ?? defaultPlays;
  const cp = saved.cp ?? 0;
  const update = (patch: Partial<NonNullable<PtController["followUp"]>>) => {
    if (typeof key === "string" ? pt.job?.id !== key : host.resultInputs !== key) return;
    pt.followUp = { ...saved, ...patch };
    host.requestUpdate();
  };
  const counts = ptFollowUpTotals(normal, challenge, measure, plays, cp, cost);
  const baseline = challenge === challengeRows[0] ? null
    : ptFollowUpTotals(normal, challengeRows[0]!, measure, plays, cp, cost);
  const number = (value: number | null, signDisplay?: "exceptZero") => value === null ? "—"
    : Intl.NumberFormat(host.locale, { maximumFractionDigits: 1, signDisplay }).format(value);
  const total = (value: number | null, reference?: number | null) => html`
    ${number(value)}
    ${value !== null && typeof reference === "number" && Math.abs(value - reference) >= 0.05
      ? html`<span class="muted">(${number(value - reference, "exceptZero")})</span>` : nothing}
  `;
  const t = (key: string, fallback: string) => host.t(`pt.${key}`, fallback);
  const field = (label: string, value: number, min: number, onChange: (value: number) => void) => html`
    <md-outlined-text-field type="number" step="1" min=${min} max="1000000" label=${label}
      .value=${String(value)} @change=${(event: Event) => {
        const next = Number((event.target as HTMLInputElement).value);
        if (Number.isSafeInteger(next) && next >= min && next <= 1000000) onChange(next);
      }}></md-outlined-text-field>`;
  return html`
    <section class="card card--outlined stack">
      ${sectionHeading({ icon: "swords", label: t("followUp", "Challenge follow-up") })}
      <div class="stack stack--tight">
        <strong>${t("normalTeamSong", "Regular Live chart")}</strong>
        ${songList(host, [normal.song!], ([song]) => update({ normal: song }), true, undefined,
          "tb-follow-up-normal", normalRows.map(row => row.song!), { context: "pt:follow-up:normal", songRules: null, showMissions: false, removable: false })}
        <strong>${t("chooseChallenge", "Challenge songs")}</strong>
        ${songList(host, [challenge.song!], ([song]) => update({ challenge: song }), true, undefined,
          "tb-follow-up-challenge", challengeRows.map(row => row.song!), { context: "pt:follow-up:challenge", songRules: null, showMissions: false, removable: false })}
      </div>
      <div class="cluster">
        ${field(t("normalRunCount", "Regular Live plays"), plays, 1, value => update({ plays: value }))}
        ${field(t("startingCp", "Starting CP"), cp, 0, value => update({ cp: value }))}
      </div>
      <dl class="spec-list tabular">
        <div><dt>${host.t("pointsPerPlay", "Event points per play")}</dt><dd>${number(counts.perPlay.points)}</dd></div>
        <div><dt>${host.t("rewardPlan.itemsPerPlay", "Badges per play")}</dt><dd>${number(counts.perPlay.items)}</dd></div>
        <div><dt>${t("challengeRunCount", "Challenge Live plays")}</dt><dd>${number(counts.plays)}</dd></div>
        <div><dt>${t("remainingCp", "Remaining CP")}</dt><dd>${number(counts.remaining)}</dd></div>
        <div><dt>${t("challengePt", "PT from challenge plays")}</dt><dd>${number(counts.followUp.points)}</dd></div>
        <div><dt>${t("challengeItems", "Medals from challenge plays")}</dt><dd>${number(counts.followUp.items)}</dd></div>
        <div><dt>${t("totalPt", "Total PT")}</dt><dd>${total(counts.points, baseline?.points)}</dd></div>
        <div><dt>${t("totalItems", "Total medals")}</dt><dd>${total(counts.items, baseline?.items)}</dd></div>
      </dl>
    </section>
    ${renderHit(host, challenge, -1, { rank: icon("swords", 18), subtitle: t("challengeBest", "Challenge team"), stale })}
  `;
}

function renderRanking(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  const job = pt.job;
  if (!job) return renderChecklist(host, host.inputIssues(true));
  const measure = job.request.goal.kind === "event" && job.request.goal.measure === "items" ? "items" : "points";
  const ranking = ptSongRanking(job, measure);
  const challenge = ptChallengeBest(job, measure);
  const gap = ptComplete(job)
    ? null
    : improvementPercent(
        job.tasks
          .filter((task) => task.measure === measure && task.route === "live")
          .map((task) => task.result ?? pendingSong(task.song)),
      );
  const filtered = host.analysis.filter(ranking);
  const followUpCharts = job.cycle ? ptChallengeCharts(job, measure) : [];
  const shown = pt.showAll ? filtered : filtered.slice(0, job.scope === "top-one" ? 1 : 5);
  const number = (n: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 1 }).format(n);
  const settled = job.tasks.filter(
    (task) => task.status === "complete" || task.status === "empty" || task.status === "pruned",
  ).length;
  return html`
    <section id="pt-results" class="stack">
      <div class="pt-results-bar">
        ${host.analysis.filters()}
        <span class="tb-proof">
          ${pt.stale ? host.t("stale", "Conditions changed") : ptComplete(job)
            ? !ranking.length ? host.t("challenge.empty", "No eligible team") : ranking.some(hit => hit.gekiso?.sampled) ? host.t("sampledProven", "Optimal within samples") : host.t("challenge.verified", "Verified for the selected search")
            : job.stopReason === "budget" ? ranking.length ? host.t("modeSearch.timedCandidate", "Time limit reached · candidate found") : host.t("modeSearch.timedEmpty", "Time limit reached · no candidate yet")
            : job.stopReason === "cancelled" ? host.t("cancelled", "Search cancelled")
            : ranking.length ? host.t("challenge.candidate", "Candidate") : host.t("noCandidate", "No recommendation yet")}${
            gap === null
              ? nothing
              : html`
                  / ${host.t("improvementBound", "Up to {percent}% improvement", { percent: number(gap) })}
                `
          }
        </span>
        <span class="pt-progress tabular">${settled}/${job.tasks.length}</span>
      </div>
      <md-linear-progress
        style=${pt.running ? "" : "visibility: hidden"}
        .value=${job.tasks.length ? settled / job.tasks.length : 0}
        aria-label=${t("start", "Calculate")}
      ></md-linear-progress>
      ${
        job.cycle && followUpCharts.length && filtered.length
          ? renderFollowUp(host, job.id, measure, job.cycle.consumption, filtered, followUpCharts, pt.stale)
          : challenge
            ? renderHit(host, challenge, -1, { rank: icon("swords", 18), subtitle: t("challengeBest", "Challenge team"), stale: pt.stale })
            : nothing
      }
      ${
        !filtered.length
          ? html`
              <div class="state"><p class="state__title">${host.analysis.emptyRewards(ranking.length > 0, pt.noFeasibleTeams, pt.running)}</p></div>
            `
          : nothing
      }
      ${shown.map((hit, position) =>
        renderHit(host, hit, ranking.indexOf(hit) < 0 ? position : ranking.indexOf(hit), {
          stale: pt.stale,
          content: job.cycle
            ? html`
                <p class="pt-breakdown tabular">
                  ${t("breakdown", "Live {direct} + CP {converted}", { direct: number(hit.event!.directMean ?? hit.event!.mean), converted: number(hit.event!.convertedMean ?? 0) })}
                </p>
              `
            : undefined,
        }),
      )}
      <button
        class="button button--tonal"
        type="button"
        ?disabled=${host.running || pt.stale}
        @click=${() => void pt.start(true, "top-five")}
      >
        ${t("topFive", "Top five")}
      </button>
      ${
        ranking.length > 5
          ? html`
              <button
                class="button button--text"
                type="button"
                @click=${() => {
                  pt.showAll = !pt.showAll;
                  host.requestUpdate();
                }}
              >
                ${pt.showAll ? t("topFive", "Top five") : t("showAll", "All {count} songs", { count: ranking.length })}
              </button>
            `
          : nothing
      }
      ${
        !ptAllComplete(job) && !pt.running
          ? html`
              <button
                class="button button--tonal"
                type="button"
                ?disabled=${host.running || pt.stale || !!pt.issues.length}
                @click=${() => void pt.start(true, "all")}
              >
                ${t("calculateAll", "Calculate every song")}
              </button>
            `
          : nothing
      }
    </section>
  `;
}

function rewardFollowUp(host: TeamBuilder) {
  const { resultInputs, results } = host;
  const goal = resultInputs?.goal;
  if (!resultInputs || goal?.kind !== "event" || goal.measure === "challenge-points" || !goal.rewardPlan?.autoCp || !results?.cpChallenge?.song) return;
  const challenge = new Map([[chartKey(results.cpChallenge.song), results.cpChallenge]]);
  for (const hit of results.cpChallengeAlternatives ?? []) {
    if (hit.song && hit.event) {
      const key = chartKey(hit.song);
      if (!challenge.has(key)) challenge.set(key, hit);
    }
  }
  const normal = new Map<string, EngineHit>();
  for (const hit of [...results.overall, ...results.results.flatMap(row => row.hits)]) {
    for (const chart of hit.aggregate?.songs ?? [hit]) {
      if (chart.song && chart.event) {
        const key = chartKey(chart.song);
        if (!normal.has(key)) normal.set(key, chart);
      }
    }
  }
  const rows = host.analysis.filter([...normal.values()]);
  if (!rows.length) return;
  return renderFollowUp(host, resultInputs, goal.measure, goal.rewardPlan.autoCp.consumption,
    rows, [...challenge.values()], host.stale);
}

export function renderPtTab(host: TeamBuilder): TemplateResult {
  const mode = host.settings.rewardMode;
  if (mode !== "plan" && !host.pt.parking) host.pt.sync();
  const modes = html`
    <section class="surface stack">
      ${segmented({
        label: host.t("farm.task", "Event task"),
        value: host.pt.parking ? "parking" : mode === "plan" ? "plan" : "farm",
        options: [
          { value: "farm", label: host.t("farm.title", "Farming recommendations") },
          { value: "plan", label: host.t("farm.plan", "Resource planning") },
          { value: "parking", label: host.t("parking.title", "Parking calculator") },
        ],
        onSelect: (value) => {
          host.cancel();
          host.pt.showIssues = false;
          host.pt.parking = value === "parking";
          host.submitted = false;
          if (value === "parking") { host.requestUpdate(); return; }
          host.updateSettings({ rewardMode: value === "plan" ? "plan" : farmingMode(host.settings.farming) });
        },
      })}
    </section>
  `;
  if (host.pt.parking) return renderParking(host, modes);
  if (mode === "plan") return renderBuildTab(host, modes);
  return toolLayout(
    host,
    html`
      ${modes}${renderSetup(host)} ${host.pt.showIssues && host.pt.issues.length ? renderIssues(host) : nothing}
    `,
    mode === "recommendation" ? renderRun(host) : renderBuildRun(host, false),
    usesPtResults(host) ? renderRanking(host) : renderResults(host, rewardFollowUp(host)),
  );
}
