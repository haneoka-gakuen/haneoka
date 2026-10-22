import { toolLayout } from "./tool-layout";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { TeamBuilder } from "../team-builder";
import type { EngineRequest } from "../../lib/team-builder/engine/api";
import { validatePtRequest, type PtIssue } from "../../lib/team-builder/engine/pt-eligibility";
import {
  canonical,
  createPtJob,
  digest,
  ptComplete,
  ptAllComplete,
  ptChallengeBest,
  ptFingerprint,
  PtRunner,
  ptSongRanking,
  type PtJob,
  type PtCycleInput,
  type PtMeasure,
  type PtScope,
} from "../../lib/team-builder/pt-recommendation";
import { improvementPercent, pendingSong } from "../../lib/team-builder/engine/execution";
import { PtCheckpoint } from "../../lib/team-builder/pt-checkpoint";
import { renderHit, renderResults } from "./results";
import {
  renderBuildTab,
  renderBuildRun,
  renderCandidates,
  comboBonusControl,
  eventSection,
  playSection,
  songList,
} from "./build-tab";
import { sectionHeading } from "./catalog";
import { boostControl } from "./boost-control";
import { rovingKeydown, segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { accordion } from "../ui/accordion";
import { issueField, ptField } from "./pt-fields";
import { farmingConditions, farmingMode, farmingSettings } from "./workspace-state";
import type { FarmingSettings } from "./types";
import { usesPtResults } from "./score-goal";

export class PtController {
  private task: symbol | null = null;
  job: PtJob | null = null;
  running = false;
  showAll = false;
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
    const control = target.querySelector<HTMLElement>(
      "input, md-outlined-text-field, md-outlined-select, md-slider, button:not([disabled]), md-checkbox",
    );
    if (control && "updateComplete" in control) await control.updateComplete;
    (control ?? target).focus({ preventScroll: true });
  }
  markFields() {
    for (const field of this.host.querySelectorAll<HTMLElement>("[data-pt-field]")) {
      const invalid = field.classList.contains("pt-field--invalid");
      for (const control of field.querySelectorAll<HTMLElement>(
        "input, md-outlined-text-field, md-outlined-select, md-checkbox",
      ))
        control.ariaInvalid = invalid ? "true" : null;
    }
  }
  private signature = "";
  private restoreKey = "";
  private generation = 0;
  private runner: PtRunner | null = null;
  private readonly store = new PtCheckpoint();
  constructor(private readonly host: TeamBuilder) {}
  private get owner() {
    return this.host.snapshot?.owner ?? "local";
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
              luckSamples: s.ptLuckSamples,
              rank: 1 as const,
              minComboBonus: s.minComboBonus,
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
        ...structuredClone(view.player),
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
            this.issues.push(...validatePtRequest(this.host.master, { ...request, goal }));
          }
        if (this.cycle() && !this.cycle()!.songs.length)
          this.issues.push({ code: "chart", target: "challenge-selection" });
        this.issues = [...new Map(this.issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
      }
    }
  }
  get stale() {
    return (
      !!this.job &&
      (this.host.settings.rewardMode !== "recommendation" ||
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
    this.restoreKey = key;
    const generation = ++this.generation;
    const owner = this.owner;
    let hash = "";
    try {
      hash = await digest(data);
      const job = await this.store.latest(data.identity.server, owner);
      if (generation !== this.generation) return;
      for (const task of job?.tasks ?? []) if (task.status === "running") task.status = "queued";
      this.dataFingerprint = hash;
      this.job = job?.dataFingerprint === hash ? job : null;
      if (this.job && !this.host.farmResultMode) this.host.farmResultMode = "recommendation";
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
  stop() {
    ++this.generation;
    if (this.task && this.host.ownsTask(this.task)) {
      this.runner?.stop();
    }
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
  async start(resume: boolean, scope?: PtScope) {
    // Results stream in as they are found; the search runs until every song is proven or it is stopped.
    const deadline = Infinity;
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
    const generation = this.generation;
    const cycle = this.cycle();
    const signature = this.inputSignature();
    this.running = host.running = true;
    this.error = "";
    host.requestUpdate();
    try {
      let job = this.job;
      const fingerprint = await ptFingerprint(request, this.dataFingerprint, this.owner, cycle);
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
        job.presentation = { scope: host.settings.scope };
      }
      if (generation !== this.generation || signature !== this.inputSignature()) return;
      this.job = job;
      host.calculationSubmitted();
      host.farmResultMode = "recommendation";
      this.runner = new PtRunner(
        host.engine,
        this.store,
        (next) => {
          if (generation !== this.generation || signature !== this.inputSignature()) return;
          this.job = next;
          host.requestUpdate();
        },
        () => {
          if (generation === this.generation) {
            this.storageError = true;
            host.requestUpdate();
          }
        },
      );
      await this.runner.run(job, scope, deadline);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.task === task) {
        this.running = false;
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
    "gekiso-input": host.t("pt.gekiso", "Gekisou"),
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
    gekisoSkillLevel: host.t("gekisoSkill", "Gekisou skill"),
    cr: host.t("characterRanks", "Character ranks"),
    bi: host.t("bandItems", "Band items"),
  };
  const card = /^([ms])(\d+)(?:[.:/]|$)/u.exec(target);
  if (card)
    return `${catalog.cardName(card[1] === "m" ? "members" : "snaps", Number(card[2]))}${fields[field] ? ` · ${fields[field]}` : ""}`;
  const song = /^(?:challenge:|gekiso:)?(\d+):(\d+)$/u.exec(target);
  if (song)
    return `${catalog.songTitle(Number(song[1]))} · ${catalog.difficultyLabel(Number(song[1]), Number(song[2]))}`;
  if (key === "cr") return `${catalog.characterName(Number(field))} · ${fields[key]}`;
  if (key === "bi") return `${catalog.text(host.data!.bandItems[field]?.name) || `#${field}`} · ${fields[key]}`;
  return target;
}

function renderSetup(host: TeamBuilder): TemplateResult {
  const s = host.searchSettings,
    f = farmingConditions(host.settings.farming),
    catalog = host.catalog!;
  const set = (patch: Partial<FarmingSettings>) => host.updateFarming(patch);
  const event = s.eventId === null ? undefined : host.master!.events.get(s.eventId);
  const challengeSongs = catalog.challengeSongs(s.eventId).map((row) => row.liveMusicId);
  const normal = !event || !!event.livePoints.size || !!event.liveRewards.length;
  const challenge =
    !event || ((!!event.challengePoints.size || !!event.challengeRewards.length) && challengeSongs.length > 0);
  const plays = [
    { value: "solo", label: host.t("routeLive", "Normal live"), icon: icon("play_arrow", 20), available: normal },
    {
      value: "gekiso",
      label: host.t("pt.gekiso", "Gekisou"),
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
  const numberField = (key: "weightPoints" | "weightItems" | "weightCp", label: string) => html`
    <md-outlined-text-field
      type="number"
      min="0"
      step="any"
      label=${label}
      .value=${live(String(f[key]))}
      @change=${(e: Event) => set({ [key]: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
    ></md-outlined-text-field>
  `;
  return html`
    <section class="surface stack">
      ${sectionHeading({ icon: "emoji_events", label: host.t("eventSetup", "Event") })}
      ${ptField(host, "event", eventSection(host, s))}
      <div
        class="tb-goals"
        role="radiogroup"
        aria-label=${host.t("pt.mode", "Play mode")}
        @keydown=${rovingKeydown(available, f.play, (play) => set({ play }))}
      >
        ${plays
          .filter((play) => play.available || play.value === f.play)
          .map(
            (play) => html`
              <button
                class=${`tb-goal${f.play === play.value ? " is-selected" : ""}`}
                type="button"
                role="radio"
                aria-checked=${f.play === play.value}
                tabindex=${f.play === play.value ? "0" : "-1"}
                ?disabled=${!play.available}
                @click=${() => set({ play: play.value })}
              >
                <span class="tb-goal__icon">${play.icon}</span>
                <span>${play.label}</span>
              </button>
            `,
          )}
      </div>
      <md-outlined-select
        label=${host.t("farm.reward", "Prioritize reward")}
        .value=${s.weighted ? "weighted" : s.measure}
        @change=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value;
          set(
            value === "weighted"
              ? { weighted: true }
              : { weighted: false, measure: value as FarmingSettings["measure"] },
          );
        }}
      >
        <md-select-option value="points">
          <div slot="headline">${host.t("measurePoints", "Event points")}</div>
        </md-select-option>
        <md-select-option value="items">
          <div slot="headline">${host.t("measureItems", "Shop items")}</div>
        </md-select-option>
        ${
          f.play === "solo"
            ? html`
                <md-select-option value="challenge-points">
                  <div slot="headline">${host.t("measureCp", "Challenge points")}</div>
                </md-select-option>
              `
            : nothing
        }
        ${
          f.play !== "gekiso"
            ? html`
                <md-select-option value="weighted">
                  <div slot="headline">${host.t("measureWeighted", "Weighted rewards")}</div>
                </md-select-option>
              `
            : nothing
        }
      </md-outlined-select>
      ${
        s.weighted
          ? html`
              <div class="pt-form-grid" id="tb-reward-weights" data-tb-field tabindex="-1">
                ${numberField("weightPoints", host.t("weightPoints", "Weight per event point"))}
                ${numberField("weightItems", host.t("weightItems", "Weight per shop item"))}
                ${s.route === "live" ? numberField("weightCp", host.t("weightCp", "Weight per challenge point")) : nothing}
              </div>
            `
          : nothing
      }
      ${
        s.route === "challenge"
          ? segmented({
              label: host.t("cpPerLive", "CP per live"),
              value: String(s.challengePoints),
              options: host
                .master!.challengeBoosts.filter((row) => row.consumed > 0)
                .map((row) => ({ value: String(row.consumed), label: `${row.consumed} CP` })),
              onSelect: (value) => host.updateSettings({ challengePoints: Number(value) }),
            })
          : ptField(
              host,
              "consumption",
              boostControl(host, s.boosts, (boosts) => host.updateSettings({ boosts })),
            )
      }
      ${
        challenge || s.ptCycle
          ? html`
              <label class="tb-check" id="tb-reward-scope" data-tb-field tabindex="-1">
                <md-checkbox
                  touch-target="wrapper"
                  .checked=${s.ptCycle}
                  @change=${(e: Event) => set({ ptCycle: (e.target as HTMLInputElement).checked })}
                ></md-checkbox>
                <span>${host.t("farm.cpConversion", "Include challenge rewards from earned CP")}</span>
              </label>
            `
          : nothing
      }
      <span class="tb-results__meta">
        ${s.ptCycle ? host.t("farm.converted", "Direct rewards + CP conversion") : host.t("farm.direct", "Direct rewards per play")}
      </span>
    </section>
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
                  s.route === "challenge" ? challengeSongs : catalog.normalEventSongIds(s.eventId),
                ),
              )}
              ${
                s.ptCycle
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
                        ),
                      )}
                      ${ptField(
                        host,
                        "challenge-consumption",
                        segmented({
                          label: host.t("cpPerLive", "CP per live"),
                          value: String(s.challengePoints),
                          options: host
                            .master!.challengeBoosts.filter((row) => row.consumed > 0)
                            .map((row) => ({ value: String(row.consumed), label: `${row.consumed} CP` })),
                          onSelect: (value) => host.updateSettings({ challengePoints: Number(value) }),
                        }),
                      )}
                    `
                  : nothing
              }
            </section>
          `
        : nothing
    }
    ${renderCandidates(host)}
    <section class="surface stack">
      ${sectionHeading({ icon: "piano", label: host.t("farm.conditions", "Play and account conditions") })}
      ${
        f.play === "gekiso"
          ? html`
              <span class="tb-results__meta">
                ${host.t("playAp", "All Perfect")} · ${host.t("gekisoPlacements", "Scoring placements")}: 1
              </span>
              ${comboBonusControl(host)}
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
                    html`
                      <md-outlined-text-field
                        type="number"
                        min="1"
                        step="1"
                        label=${host.t("pt.luckSamples", "Luck samples")}
                        .value=${live(String(s.ptLuckSamples))}
                        @change=${(e: Event) => host.updateSettings({ ptLuckSamples: Number((e.target as HTMLInputElement).value) })}
                      ></md-outlined-text-field>
                    `,
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
                    <label class="tb-check">
                      <md-checkbox
                        touch-target="wrapper"
                        .checked=${f.fullRanking}
                        @change=${(e: Event) => set({ fullRanking: (e.target as HTMLInputElement).checked })}
                      ></md-checkbox>
                      <span>${host.t("fullRanking", "Full reward ranking")}</span>
                    </label>
                    <md-outlined-select
                      label=${host.t("resultCount", "Results")}
                      .value=${String(f.k)}
                      @change=${(e: Event) => set({ k: Number((e.target as HTMLInputElement).value) })}
                    >
                      ${[1, 3, 5, 10, 15, 20].map(
                        (k) => html`
                          <md-select-option value=${String(k)}><div slot="headline">${k}</div></md-select-option>
                        `,
                      )}
                    </md-outlined-select>
                    <md-outlined-select
                      label=${host.t("timeLimit", "Time limit")}
                      .value=${String(f.timeLimit ?? 0)}
                      @change=${(e: Event) => set({ timeLimit: Number((e.target as HTMLInputElement).value) || null })}
                    >
                      ${[0, 3, 5, 15, 60].map(
                        (value) => html`
                          <md-select-option value=${String(value)}>
                            <div slot="headline">${value ? `${value} s` : host.t("noLimit", "Until proven")}</div>
                          </md-select-option>
                        `,
                      )}
                    </md-outlined-select>
                  `
            }
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
        host.submitted && host.inputIssues(true).length
          ? html`
              <div role="alert">
                ${host.inputIssues(true).map(
                  (issue) => html`
                    <button class="button button--text" @click=${() => host.focusInput(issue.field)}>
                      ${issue.message}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing
      }
      ${
        host.hasTaskResults
          ? html`
              <button
                class="button button--text"
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
                ${icon("search", 20)}${resume ? host.t("continueOptimal", "Continue verifying optimality") : pt.stale ? host.t("rerun", "Search again") : host.t("farm.run", "Recommend songs and teams")}
              </button>
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

function renderRanking(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  const job = pt.job;
  if (!job) {
    const issue = host.inputIssues(true)[0];
    const emptyBox = issue?.field === "tb-cards" && host.searchSettings.scope === "box" && !host.view?.members.size;
    return html`
      <div class="state tb-results--empty">
        <span class="state__icon">${icon("emoji_events", 32)}</span>
        <p class="state__title">
          ${emptyBox ? host.t("emptyBoxTitle", "No cards imported yet") : (issue?.message ?? host.t("readyToCalculate", "Ready to calculate"))}
        </p>
        ${
          issue
            ? html`
                <button
                  class="button button--tonal"
                  @click=${() => (emptyBox ? host.imports.openBox() : host.focusInput(issue.field))}
                >
                  ${emptyBox ? host.t("importMyCards", "Import my cards") : host.t("adjustConditions", "Adjust conditions")}
                </button>
              `
            : nothing
        }
      </div>
    `;
  }
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
  const shown = pt.showAll ? ranking : ranking.slice(0, job.scope === "top-one" ? 1 : 5);
  const number = (n: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 1 }).format(n);
  const settled = job.tasks.filter(
    (task) => task.status === "complete" || task.status === "empty" || task.status === "pruned",
  ).length;
  return html`
    <section id="pt-results" class="stack">
      <div class="pt-results-bar">
        <span class="tb-proof">
          ${ptComplete(job) ? host.t("proven", "Proven optimal") : host.t("recommendation", "Recommendation")}${
            gap === null
              ? nothing
              : html`
                  · ${host.t("improvementBound", "Up to {percent}% improvement", { percent: number(gap) })}
                `
          }
        </span>
        <span class="pt-progress tabular">${settled}/${job.tasks.length}</span>
        ${
          pt.stale
            ? html`
                <span class="chip chip--static"><span class="chip__label">${t("stale", "Inputs changed")}</span></span>
              `
            : nothing
        }
      </div>
      <md-linear-progress
        style=${pt.running ? "" : "visibility: hidden"}
        .value=${job.tasks.length ? settled / job.tasks.length : 0}
        aria-label=${t("start", "Calculate")}
      ></md-linear-progress>
      ${
        challenge
          ? html`
              ${renderHit(host, challenge, -1, { rank: icon("swords", 18), subtitle: t("challengeBest", "Challenge team"), stale: pt.stale })}
            `
          : nothing
      }
      ${
        !ranking.length && !pt.running
          ? html`
              <div class="state"><p class="state__title">${host.t("noCandidate", "No recommendation yet")}</p></div>
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

export function renderPtTab(host: TeamBuilder): TemplateResult {
  const mode = host.settings.rewardMode;
  if (mode !== "plan") host.pt.sync();
  const modes = html`
    <section class="surface stack">
      ${segmented({
        label: host.t("farm.task", "Event task"),
        value: mode === "plan" ? "plan" : "farm",
        options: [
          { value: "farm", label: host.t("farm.title", "Farming recommendations") },
          { value: "plan", label: host.t("farm.plan", "Resource planning") },
        ],
        onSelect: (value) => {
          host.cancel();
          host.pt.showIssues = false;
          host.updateSettings({ rewardMode: value === "plan" ? "plan" : farmingMode(host.settings.farming) });
        },
      })}
    </section>
  `;
  if (mode === "plan") return renderBuildTab(host, modes);
  return toolLayout(
    host,
    html`
      ${modes}${renderSetup(host)} ${host.pt.showIssues && host.pt.issues.length ? renderIssues(host) : nothing}
    `,
    mode === "recommendation" ? renderRun(host) : renderBuildRun(host, false),
    usesPtResults(host) ? renderRanking(host) : renderResults(host),
  );
}
