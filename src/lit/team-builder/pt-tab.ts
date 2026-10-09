import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { TeamBuilder } from "../team-builder";
import { engineInputs } from "../../lib/team-builder/sync/box-view";
import type { EngineHit, EngineRequest } from "../../lib/team-builder/engine/api";
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
import { PtCheckpoint } from "../../lib/team-builder/pt-checkpoint";
import { formation } from "./results";
import { sectionHeading } from "./catalog";
import { segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { LIVE_BOOST_COSTS, liveBoostRow } from "../../lib/team-builder/engine/boosts";
import { issueField, ptField } from "./pt-fields";

export class PtController {
  job: PtJob | null = null;
  accepted = false;
  running = false;
  showAll = false;
  measure: PtMeasure = "points";
  storageError = false;
  error = "";
  dataFingerprint = "";
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
    } else host.tab = /^(cr|cm|mm|bi|p)\./u.test(field) ? "account" : field === "inventory" ? "box" : "pt";
    host.requestUpdate();
    await host.updateComplete;
    const target = host.querySelector<HTMLElement>(`[data-pt-field="${CSS.escape(field)}"]`);
    if (!target) return;
    const disclosures: HTMLDetailsElement[] = [];
    for (let parent = target.parentElement; parent && parent !== host; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        parent.open = true;
        disclosures.push(parent);
      }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // The shared disclosure transition clips its contents while opening. Focus
    // after that transition so browsers can actually focus the revealed input.
    target.getBoundingClientRect();
    await Promise.allSettled(disclosures.flatMap((node) => node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    target.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    const control = target.querySelector<HTMLElement>(
      "input, md-outlined-text-field, md-outlined-select, md-slider, button:not([disabled]), md-checkbox",
    );
    // Newly revealed Material fields may still be rendering their shadow input.
    if (control && "updateComplete" in control) await control.updateComplete;
    (control ?? target).focus({ preventScroll: true });
  }
  markFields() {
    for (const field of this.host.querySelectorAll<HTMLElement>("[data-pt-field]")) {
      const invalid = field.classList.contains("pt-field--invalid");
      for (const control of field.querySelectorAll<HTMLElement>(
        "input, md-outlined-text-field, md-outlined-select, md-slider, md-checkbox, [role=radiogroup]",
      )) {
        if (invalid) {
          control.ariaInvalid = "true";
          control.setAttribute("aria-describedby", `pt-help-${field.dataset.ptField}`);
        } else if (control.getAttribute("aria-describedby")?.startsWith("pt-help-")) {
          control.ariaInvalid = null;
          control.removeAttribute("aria-describedby");
        }
      }
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
    const { view, settings: s } = this.host;
    if (!view) return null;
    const cards = engineInputs(view);
    return {
      members: cards.members,
      snaps: s.noSnaps ? [] : cards.snaps,
      player: structuredClone(view.player),
      unknownPolicy: "min",
      goal: {
        kind: "event",
        ranking: "pt-only",
        measure: "points",
        route: "live",
        eventId: s.eventId ?? -1,
        songs: [...s.songs].sort((a, b) => a.songId - b.songId || a.difficulty - b.difficulty),
        consumption: s.boosts,
        play: { great: 0, good: 0, bad: 0, miss: 0 },
        ...(s.ptMode === "gekiso"
          ? { gekiso: { just: s.ptJust / 100, luckSamples: s.ptLuckSamples, rank: 1 as const } }
          : {}),
      },
      constraints: {
        requiredMembers: [...view.members.values()].filter((r) => r.lock).map((r) => `m${r.cardId}`),
        requiredSnaps: [...view.snaps.values()].filter((r) => r.lock).map((r) => `s${r.cardId}`),
        excludedMembers: [],
        excludedSnaps: [],
        leader: s.leader === null ? null : `m${s.leader}`,
        bindings: s.bindings.map(([m, p]) => [`m${m}`, p === null ? null : `s${p}`]),
        noSnaps: s.noSnaps,
        minBonusPercent: s.minBonus,
      },
      k: 1,
      timeLimitMs: null,
    };
  }
  cycle(): PtCycleInput {
    return {
      songs: [...this.host.settings.planChallengeSongs].sort(
        (a, b) => a.songId - b.songId || a.difficulty - b.difficulty,
      ),
      consumption: this.host.settings.challengePoints,
    };
  }
  private inputSignature() {
    return canonical([this.request(), this.cycle()]);
  }
  sync() {
    const request = this.request();
    const signature = this.inputSignature();
    if (signature !== this.signature) {
      this.signature = signature;
      this.accepted = false;
      this.issues = [];
      if (request?.goal.kind === "event" && this.host.master) {
        for (const route of ["live", "challenge"] as const)
          for (const measure of ["points", "items"] as const) {
            const goal = { ...request.goal, route, measure };
            if (route === "live") goal.cpExchange = { numerator: 0, denominator: 1 };
            else {
              goal.songs = this.cycle().songs;
              goal.consumption = this.cycle().consumption;
              delete goal.gekiso;
            }
            this.issues.push(...validatePtRequest(this.host.master, { ...request, goal }));
          }
        if (!this.cycle().songs.length) this.issues.push({ code: "chart", target: "challenge-selection" });
        this.issues = [...new Map(this.issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
      }
    }
  }
  get stale() {
    return (
      !!this.job &&
      (canonical([this.job.request, this.job.cycle]) !== this.inputSignature() ||
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
      // A previous page's unfinished Worker cannot still be running after restoration.
      for (const task of job?.tasks ?? []) if (task.status === "running") task.status = "queued";
      this.dataFingerprint = hash;
      this.job = job;
    } catch {
      if (generation !== this.generation) return;
      // Persistence is optional; the trial still works in memory and says so.
      this.dataFingerprint = hash;
      this.storageError = true;
      if (!hash) this.error = "pt-data-fingerprint";
    }
    this.host.requestUpdate();
  }
  stop() {
    this.runner?.stop();
  }
  dispose() {
    this.correcting = false;
    ++this.generation;
    this.stop();
    this.job = null;
    this.restoreKey = "";
    this.accepted = false;
  }
  async start(resume: boolean, scope?: PtScope) {
    this.sync();
    const host = this.host;
    const request = this.request();
    if (
      !request ||
      !host.engine ||
      !host.data ||
      host.running ||
      host.manualBusy ||
      this.issues.length ||
      !this.accepted ||
      !this.dataFingerprint
    )
      return;
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
            assumptions: [
              ...(request.goal.kind === "event" && request.goal.gekiso
                ? [
                    `gekiso-baseline-just:${request.goal.gekiso.just}`,
                    `gekiso-fixed-native-seeds:0..${request.goal.gekiso.luckSamples - 1}`,
                    "gekiso-all-ranges-rank-1",
                    "gekiso-evenly-spaced-baseline-judgements",
                    "challenge-ap-no-gekiso",
                  ]
                : ["solo-and-challenge-ap"]),
              "equal-120-orders",
              "long-run-cp-average-no-integer-remainder",
              "game-rules-unverified",
              ...host.data.gaps,
            ],
          },
          cycle,
        );
      }
      if (generation !== this.generation || signature !== this.inputSignature()) return;
      this.job = job;
      this.runner = new PtRunner(
        host.engine,
        this.store,
        (next) => {
          if (generation !== this.generation) return;
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
      await this.runner.run(job, scope);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.running = host.running = false;
      host.requestUpdate();
    }
  }
}

function inputLabel(host: TeamBuilder, target: string): string {
  const [key = "", field = ""] = target.split(".");
  const catalog = host.catalog!;
  const titles: Record<string, string> = {
    "p.total": host.t("totalRank", "Total character rank"),
    "p.vip": host.t("vipRank", "T.G.W card rank"),
    "five-characters": host.t("pt.fiveCharacters", "At least five different characters"),
    selection: host.t("chooseSongs", "Choose songs"),
    "challenge-selection": host.t("pt.challengeSelection", "Choose allowed challenge charts first"),
    tables: host.t("pt.eventTables", "Event and supported consumption"),
    consumption: host.t("boosts", "Boosts per live"),
    "challenge-consumption": host.t("pt.challengeCost", "CP spent per challenge"),
    "gekiso-input": host.t("pt.gekiso", "Gekisou"),
    minBonus: host.t("minBonus", "Minimum event bonus (%)"),
    member: host.t("members", "Members"),
    snap: host.t("snapshots", "Photos"),
    "required-members": host.t("pt.requiredMembers", "Required members must have different characters"),
    "photo-bindings": host.t("pt.photoBindings", "Each photo can only be equipped once"),
  };
  if (titles[target]) return titles[target];
  const fields: Record<string, string> = {
    level: host.t("level", "Level"),
    awake: host.t("training", "Training"),
    rank: host.t("awakening", "Awakening"),
    liveSkillLevel: host.t("liveSkill", "Live skill"),
    gekisoSkillLevel: host.t("gekisoSkill", "Gekisou skill"),
    cr: host.t("characterRanks", "Character ranks"),
    cm: host.t("pt.characterMemory", "Character memory points"),
    mm: host.t("pt.musicMemory", "Song memory points"),
    bi: host.t("bandItems", "Band items"),
  };
  const card = /^([ms])(\d+)(?:[.:/]|$)/u.exec(target);
  if (card)
    return `${catalog.cardName(card[1] === "m" ? "members" : "snaps", Number(card[2]))}${fields[field] ? ` · ${fields[field]}` : ""}`;
  const song = /^(?:challenge:|gekiso:)?(\d+):(\d+)$/u.exec(target);
  if (song)
    return `${catalog.songTitle(Number(song[1]))} · ${catalog.difficultyLabel(Number(song[1]), Number(song[2]))}`;
  if (key === "cr" || key === "cm") return `${catalog.characterName(Number(field))} · ${fields[key]}`;
  if (key === "mm") return `${catalog.songTitle(Number(field))} · ${fields[key]}`;
  if (key === "bi") return `${catalog.text(host.data!.bandItems[field]?.name) || `#${field}`} · ${fields[key]}`;
  return target;
}

function trialFormation(host: TeamBuilder, hit: EngineHit): TemplateResult {
  return html`
    ${formation(host, hit)}
    <details>
      <summary>${host.t("pt.teamDetails", "Member and photo names")}</summary>
      <ol>
        ${hit.members.map(
          (key, i) => html`
            <li>
              ${i === 0 ? `${host.t("leader", "Leader")} · ` : ""}${host.catalog!.cardName("members", Number(key.slice(1)))}
              →
              ${hit.snaps[i] ? host.catalog!.cardName("snaps", Number(hit.snaps[i]!.slice(1))) : host.t("noSnap", "No snap")}
            </li>
          `,
        )}
      </ol>
    </details>
  `;
}

export function renderPtTab(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  pt.sync();
  const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
    host.t(`pt.${key}`, fallback, params);
  const s = host.settings;
  const catalog = host.catalog!;
  const master = host.master!;
  const request = pt.request()!;
  const events = catalog.events();
  const boosts = LIVE_BOOST_COSTS;
  const job = pt.job;
  const ranking = job ? ptSongRanking(job, pt.measure) : [];
  const challenge = job ? ptChallengeBest(job, pt.measure) : null;
  const currency = pt.measure === "points" ? t("points", "Event PT") : t("items", "Shop medals");
  const shown = pt.showAll ? ranking : ranking.slice(0, 5);
  const counts = job
    ? {
        done: job.tasks.filter((row) => row.status === "complete" || row.status === "empty").length,
        pruned: job.tasks.filter((row) => row.status === "pruned").length,
        failed: job.tasks.filter((row) => row.status === "failed").length,
        pending: job.tasks.filter((row) => row.status === "queued" || row.status === "running").length,
        total: job.tasks.length,
      }
    : null;
  const issueTitles: Record<PtIssue["code"], string> = {
    mode: t("issueMode", "This trial supports AP solo and challenge rewards only."),
    inventory: t("issueInventory", "Check the participating inventory:"),
    practice: t("issuePractice", "Complete or correct practice:"),
    player: t("issuePlayer", "Complete or correct account bonuses:"),
    constraint: t("issueConstraint", "Resolve the fixed-team condition:"),
    event: t("issueEvent", "Event payout data is missing or invalid:"),
    chart: t("issueChart", "Choose a supported chart:"),
    skill: t("issueSkill", "A required skill cannot be calculated:"),
    rules: t("issueRules", "These rules are outside the supported calculation range:"),
  };
  // Display rounding never participates in sorting or tie detection.
  const number = (n: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 3 }).format(n);
  return html`
    <div class="pt-recommendation stack stack--loose">
      <section class="surface stack pt-setup">
        <div class="pt-heading">
          ${sectionHeading({ icon: "emoji_events", label: t("title", "Teams and songs: total rewards") })}
          <span class="badge badge--primary">${t("modelBadge", "Model trial")}</span>
        </div>
        <p class="pt-supporting">
          ${t("setupHint", "Choose your playable charts. Your inventory is used to recommend separate teams for event PT and shop medals.")}
        </p>
        ${segmented({
          label: t("mode", "Play mode"),
          value: s.ptMode,
          options: [
            { value: "solo", label: t("solo", "Solo"), icon: "person" },
            { value: "gekiso", label: t("gekiso", "Gekisou"), icon: "local_fire_department" },
          ],
          onSelect: (value) => host.updateSettings({ ptMode: value as "solo" | "gekiso" }),
        })}
        <div class="pt-form-grid">
          ${ptField(
            host,
            "event",
            html`
              <md-outlined-select
                label=${host.t("event", "Event")}
                .value=${s.eventId === null ? "" : String(s.eventId)}
                @change=${(e: Event) => host.updateSettings({ eventId: Number((e.target as HTMLInputElement).value), planChallengeSongs: [] })}
              >
                ${events.map(
                  (event) => html`
                    <md-select-option value=${String(event.id)}>
                      <div slot="headline">${event.name}</div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            `,
          )}
          ${ptField(
            host,
            "consumption",
            html`
              <md-outlined-select
                label=${host.t("boosts", "Boosts per live")}
                .value=${String(s.boosts)}
                @change=${(e: Event) => host.updateSettings({ boosts: Number((e.target as HTMLInputElement).value) })}
              >
                ${boosts.map(
                  (cost) => html`
                    <md-select-option value=${String(cost)} ?disabled=${!liveBoostRow(master.boosts, cost)}>
                      <div slot="headline">${cost}</div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            `,
          )}
          ${ptField(
            host,
            "selection",
            html`
              <button
                class="button button--tonal pt-song-choice"
                type="button"
                @click=${() => {
                  host.songPicker = {
                    songs: [...s.songs],
                    single: false,
                    query: "",
                    filtersOpen: false,
                    bands: [],
                    attributes: [],
                    gekisouTypes: [],
                    difficulty: 3,
                    change: (songs) => host.updateSettings({ songs }),
                  };
                  host.requestUpdate();
                }}
              >
                ${icon("library_music", 20)}
                <span>${host.t("chooseSongs", "Choose songs")}</span>
                <span class="tabular">(${s.songs.length})</span>
              </button>
            `,
          )}
          ${ptField(
            host,
            "challenge-selection",
            html`
              <button
                class="button button--tonal pt-song-choice"
                type="button"
                ?disabled=${s.eventId === null}
                @click=${() => {
                  host.songPicker = {
                    songs: [...s.planChallengeSongs],
                    single: false,
                    query: "",
                    filtersOpen: false,
                    bands: [],
                    attributes: [],
                    gekisouTypes: [],
                    difficulty: 3,
                    allowedSongIds: master.challengeMusics
                      .filter((row) => row.eventId === s.eventId)
                      .map((row) => row.liveMusicId),
                    title: t("chooseChallenge", "Allowed challenge songs and difficulties"),
                    change: (planChallengeSongs) => host.updateSettings({ planChallengeSongs }),
                  };
                  host.requestUpdate();
                }}
              >
                ${icon("swords", 20)}
                <span>${t("chooseChallenge", "Allowed challenge songs and difficulties")}</span>
                <span class="tabular">(${s.planChallengeSongs.length})</span>
              </button>
            `,
          )}
          ${ptField(
            host,
            "challenge-consumption",
            html`
              <md-outlined-select
                label=${t("challengeCost", "CP spent per challenge")}
                .value=${String(s.challengePoints)}
                @change=${(e: Event) => host.updateSettings({ challengePoints: Number((e.target as HTMLInputElement).value) })}
              >
                ${master.challengeBoosts
                  .filter((row) => row.consumed > 0 && row.eventPointRate > 0 && row.rewardRate > 0)
                  .map(
                    (row) => html`
                      <md-select-option value=${String(row.consumed)}>
                        <div slot="headline">${row.consumed} CP</div>
                      </md-select-option>
                    `,
                  )}
              </md-outlined-select>
            `,
          )}
          <p class="pt-supporting">
            ${t("server", "Server: {server}", { server: host.data!.identity.server })}
            <br />
            ${t("inputCount", "{members} participating members · {snaps} participating photos", { members: request.members.length, snaps: request.snaps.length })}
          </p>
        </div>
        ${
          s.ptMode === "gekiso"
            ? ptField(
                host,
                "gekiso-input",
                html`
                  <div class="pt-form-grid">
                    <md-outlined-text-field
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      label=${t("baselineJust", "Baseline JUST (%)")}
                      .value=${live(String(s.ptJust))}
                      @change=${(e: Event) => host.updateSettings({ ptJust: Number((e.target as HTMLInputElement).value) })}
                    ></md-outlined-text-field>
                    <md-outlined-text-field
                      type="number"
                      min="1"
                      step="1"
                      label=${t("luckSamples", "Luck samples")}
                      .value=${live(String(s.ptLuckSamples))}
                      @change=${(e: Event) => host.updateSettings({ ptLuckSamples: Number((e.target as HTMLInputElement).value) })}
                    ></md-outlined-text-field>
                  </div>
                `,
              )
            : nothing
        }
        <details class="pt-explanation">
          <summary>${t("assumptionsTitle", "Calculation assumptions and CP rewards")}</summary>
          <p>
            ${s.ptMode === "gekiso" ? t("gekisoIntro", "Gekisou · full combo, other notes PERFECT · every range ranked 1st. Skills convert individual notes after your baseline JUST input. Two separate reward rankings include CP spent by a separate challenge team.") : t("intro", "Solo · all PERFECT · fixed consumption. Two independent recommendations: event PT and shop medals, including the long-run value of CP spent by a separately optimized challenge team.")}
          </p>
          <p>
            ${t("cycleNote", "Total = this live's direct reward + earned CP × the best challenge reward per CP. This is a long-run average; rewards are not all received immediately.")}
          </p>
          <p>
            ${t("model", "Model trial: 120 skill orders are equally weighted. Game rules are not fully verified; these numbers are not a prediction of your actual play.")}
          </p>
          ${
            s.ptMode === "gekiso"
              ? html`
                  <p>
                    ${t("gekisoSampling", "Luck uses shared fixed random samples, settling each outcome before averaging. More samples take longer. Completed search is optimal for these samples, not proof of the true lottery expectation.")}
                  </p>
                `
              : nothing
          }
        </details>
        ${
          !events.length
            ? html`
                <p class="inline-message">${host.t("noEvents", "This server's data has no event yet.")}</p>
              `
            : nothing
        }
        <div class="cluster">
          <button class="button button--text" type="button" @click=${() => host.setTab("box")}>
            ${icon("style", 20)}${host.t("tabBox", "My cards")}
          </button>
          <button class="button button--text" type="button" @click=${() => host.setTab("account")}>
            ${icon("trending_up", 20)}${host.t("tabAccount", "Account bonuses")}
          </button>
        </div>
        <details class="pt-explanation">
          <summary>${t("constraints", "Edit leader and photo conditions")}</summary>
          ${ptField(
            host,
            "constraints",
            html`
              <div class="pt-form-grid">
                <md-outlined-select
                  label=${host.t("leader", "Leader")}
                  .value=${s.leader === null ? "" : String(s.leader)}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLInputElement).value;
                    host.updateSettings({ leader: v ? Number(v) : null });
                  }}
                >
                  <md-select-option value="">
                    <div slot="headline">${host.t("leaderAuto", "Best leader (automatic)")}</div>
                  </md-select-option>
                  ${request.members.map(
                    (m) => html`
                      <md-select-option value=${String(m.cardId)}>
                        <div slot="headline">${catalog.cardName("members", m.cardId)}</div>
                      </md-select-option>
                    `,
                  )}
                </md-outlined-select>
                ${ptField(
                  host,
                  "minBonus",
                  html`
                    <md-outlined-text-field
                      type="number"
                      min="0"
                      label=${host.t("minBonus", "Minimum event bonus (%)")}
                      .value=${live(s.minBonus === null ? "" : String(s.minBonus))}
                      @change=${(e: Event) => {
                    const v = (e.target as HTMLInputElement).value;
                    host.updateSettings({ minBonus: v === "" ? null : Number(v) });
                  }}
                    ></md-outlined-text-field>
                  `,
                )}
              </div>
              <label class="tb-check">
                <md-checkbox
                  touch-target="wrapper"
                  .checked=${live(s.noSnaps)}
                  @change=${(e: Event) => host.updateSettings({ noSnaps: (e.target as HTMLInputElement).checked })}
                ></md-checkbox>
                <span>${host.t("noSnaps", "No photos")}</span>
              </label>
              <div class="cluster">
                ${[...request.constraints.requiredMembers, ...request.constraints.requiredSnaps].map(
                  (key) => html`
                    <button
                      class="button button--text"
                      type="button"
                      @click=${() => void pt.focusIssue({ code: "practice", target: key + ".use" })}
                    >
                      ${icon("push_pin", 18)}${inputLabel(host, key)}
                    </button>
                  `,
                )}
              </div>
              ${s.bindings.map(
                ([m, p], index) => html`
                  <div class="row row--wrap">
                    <span>
                      ${catalog.cardName("members", m)} →
                      ${p === null ? host.t("noSnap", "No snap") : catalog.cardName("snaps", p)}
                    </span>
                    <button
                      type="button"
                      class="button button--text"
                      @click=${() => host.updateSettings({ bindings: s.bindings.filter((_, i) => i !== index) })}
                    >
                      ${t("removeBinding", "Remove binding")}
                    </button>
                  </div>
                `,
              )}
              <p class="pt-supporting">
                ${t("constraintScope", "Fixed members, leader, photos and minimum event bonus apply to both searches. The minimum bonus uses the reward being optimized.")}
              </p>
            `,
          )}
        </details>
        <details class="stack">
          <summary>${t("inputs", "Review inventory, practice and account inputs")}</summary>
          <p>
            ${t("inputCount", "{members} participating members · {snaps} participating photos", { members: request.members.length, snaps: request.snaps.length })}
          </p>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>${host.t("members", "Members")}</th>
                  <th>${host.t("level", "Level")}</th>
                  <th>${host.t("training", "Training")}</th>
                  <th>${host.t("awakening", "Awakening")}</th>
                  <th>${host.t("liveSkill", "Live skill")}</th>
                  ${
                    s.ptMode === "gekiso"
                      ? html`
                          <th>${host.t("gekisoSkill", "Gekisou skill")}</th>
                        `
                      : nothing
                  }
                </tr>
              </thead>
              <tbody>
                ${request.members.map(
                  (row) => html`
                    <tr>
                      <td>${catalog.cardName("members", row.cardId)}</td>
                      <td>${row.level ?? "—"}</td>
                      <td>${row.awake ?? "—"}</td>
                      <td>${row.rank ?? "—"}</td>
                      <td>${row.liveSkillLevel ?? "—"}</td>
                      ${
                        s.ptMode === "gekiso"
                          ? html`
                              <td>${row.gekisoSkillLevel ?? "—"}</td>
                            `
                          : nothing
                      }
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
          <div class="table-scroll">
            <table>
              <tbody>
                ${request.snaps.map(
                  (row) => html`
                    <tr>
                      <th>${catalog.cardName("snaps", row.cardId)}</th>
                      <td>${host.t("level", "Level")}: ${row.level ?? "—"}</td>
                      <td>${host.t("awakening", "Awakening")}: ${row.rank ?? "—"}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
          <p>
            ${host.t("totalRank", "Total character rank")}:
            ${request.player.characterTotalRank ?? t("derivedTotal", "Derived only when all character ranks are filled")};
            ${host.t("vipRank", "T.G.W card rank")}: ${request.player.vipRank ?? "—"}
          </p>
          <div class="table-scroll">
            <table>
              <tbody>
                ${(
                  [
                    ["cr", request.player.characterRanks],
                    ["bi", request.player.bandItems],
                    ["cm", request.player.characterMemory],
                    ["mm", request.player.musicMemory],
                  ] as const
                ).flatMap(([prefix, values]) =>
                  Object.entries(values).map(
                    ([id, value]) => html`
                      <tr>
                        <th>${inputLabel(host, `${prefix}.${id}`)}</th>
                        <td>${value ?? "—"}</td>
                      </tr>
                    `,
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p>
            ${t("fixed", "Fixed conditions")}:
            ${[...request.constraints.requiredMembers, ...request.constraints.requiredSnaps, ...(request.constraints.leader ? [request.constraints.leader] : [])].map((key) => inputLabel(host, key)).join(" · ") || "—"}
          </p>
          <ul>
            ${request.constraints.bindings.map(
              ([m, p]) => html`
                <li>${inputLabel(host, m)} → ${p ? inputLabel(host, p) : host.t("noSnap", "No snap")}</li>
              `,
            )}
          </ul>
          <p>
            ${host.t("noSnaps", "No photos")}:
            ${request.constraints.noSnaps ? host.common("common.states.yes", "Yes") : host.common("common.states.no", "No")};
            ${host.t("minBonus", "Minimum event bonus (%)")}: ${request.constraints.minBonusPercent ?? "—"}
          </p>
          <ul>
            ${s.songs.map(
              (song) => html`
                <li>${catalog.songTitle(song.songId)} · ${catalog.difficultyLabel(song.songId, song.difficulty)}</li>
              `,
            )}
          </ul>
        </details>
        ${
          pt.issues.length
            ? html`
                <details class="pt-issues stack" id="pt-issues" tabindex="-1" open>
                  <summary>
                    ${icon("error", 20)}${t("needsInput", "Complete these inputs before calculating ({count})", { count: pt.issues.length })}
                  </summary>
                  <p class="pt-supporting">
                    ${t("issueJumpHelp", "Choose an item to go to its input. The field is marked until it is corrected.")}
                  </p>
                  <ul class="pt-issue-list">
                    ${pt.issues.map(
                      (issue) => html`
                        <li>
                          <span>
                            <strong>${inputLabel(host, issue.target)}</strong>
                            <small>${issueTitles[issue.code]}</small>
                          </span>
                          ${
                          issueField(issue)
                            ? html`
                                <button
                                  type="button"
                                  class="button button--text"
                                  @click=${() => void pt.focusIssue(issue)}
                                  aria-label=${t("locateInput", "Go to {input}", { input: inputLabel(host, issue.target) })}
                                >
                                  ${t("fixInput", "Review")}${icon("arrow_forward", 18)}
                                </button>
                              `
                            : html`
                                <span class="pt-supporting">
                                  ${t("dataIssue", "This requires supported data or rules; changing practice cannot fix it.")}
                                </span>
                              `
                        }
                        </li>
                      `,
                    )}
                  </ul>
                </details>
              `
            : nothing
        }
        <label class="tb-check">
          <md-checkbox
            .checked=${live(pt.accepted)}
            @change=${(e: Event) => {
              pt.accepted = (e.target as HTMLInputElement).checked;
              host.requestUpdate();
            }}
          ></md-checkbox>
          <span>${t("accept", "I have checked these inputs and accept the stated model assumptions.")}</span>
        </label>
        <div class="row row--wrap">
          <button
            class="button"
            type="button"
            ?disabled=${host.running || host.manualBusy || !pt.accepted || !!pt.issues.length || !pt.dataFingerprint}
            @click=${() => void pt.start(false)}
          >
            ${t("start", "Recommend teams and songs")}
          </button>
          ${
            job && !ptComplete(job)
              ? html`
                  <button
                    class="button button--tonal"
                    type="button"
                    ?disabled=${host.running || pt.stale || !pt.accepted || !!pt.issues.length}
                    @click=${() => void pt.start(true)}
                  >
                    ${t("resume", "Continue completed-chart job")}
                  </button>
                `
              : nothing
          }
          ${
            pt.running
              ? html`
                  <button class="button button--tonal" type="button" @click=${() => pt.stop()}>
                    ${t("stop", "Stop and keep completed charts")}
                  </button>
                `
              : nothing
          }
        </div>
        <p>
          ${t("resumeNote", "No time limit. Completed charts are saved on this device; an interrupted chart starts again when you continue.")}
        </p>
        <p>
          ${t("searchScope", "First prove the top five different songs for each reward. Charts whose safe upper bound is strictly below fifth place can be excluded; ties are still searched. You can then calculate every chart.")}
        </p>
        ${
          pt.storageError
            ? html`
                <p role="status">
                  ${t("storageError", "Local saving is unavailable. Results remain in this page only; refreshing may lose them.")}
                </p>
              `
            : nothing
        }
        ${
          pt.error
            ? html`
                <p role="alert">${t("runError", "The task could not start. Check the inputs and try again.")}</p>
                <details>
                  <summary>${t("diagnostics", "Calculation details")}</summary>
                  <p class="pt-metadata">${pt.error}</p>
                </details>
              `
            : nothing
        }
      </section>
      ${
        job && counts
          ? html`
              <section class="stack" aria-live="polite">
                ${segmented({
                  label: t("objective", "Reward to optimize"),
                  value: pt.measure,
                  options: [
                    { value: "points", label: t("points", "Event PT") },
                    { value: "items", label: t("items", "Shop medals") },
                  ],
                  onSelect: (value) => {
                    pt.measure = value as PtMeasure;
                    pt.showAll = false;
                    host.requestUpdate();
                  },
                })}
                <h2>
                  ${pt.stale ? t("stale", "Previous result — inputs or data have changed") : ptComplete(job) && ranking.length ? (job.scope === "top-five" ? (job.request.goal.kind === "event" && job.request.goal.gekiso ? t("gekisoTopComplete", "Top five proven within these inputs and fixed samples") : t("topComplete", "Top five proven within these inputs and this model")) : job.request.goal.kind === "event" && job.request.goal.gekiso ? t("gekisoComplete", "Best within these inputs and fixed samples") : t("complete", "Best within these inputs and this model")) : t("partial", "Current best among completed charts")}
                </h2>
                <p>
                  ${t("modelLabel", "Model trial · game accuracy unverified")} ·
                  ${t("searchProgress", "Calculated {done}/{total} charts · excluded {pruned} · unfinished {pending} · failed {failed}", counts)}
                </p>
                ${
                  counts.pruned
                    ? html`
                        <p>
                          ${t("excludedNote", "Excluded charts cannot enter the top five. Their own optimal teams have not been calculated, and they are not included in the completed-song list.")}
                        </p>
                      `
                    : nothing
                }
                ${
                  challenge
                    ? html`
                        <article class="card card--outlined tb-hit stack">
                          <h3>${t("challengeBest", "Challenge team used to value CP")} · ${currency}</h3>
                          <p>
                            ${catalog.songTitle(challenge.song!.songId)} ·
                            ${catalog.difficultyLabel(challenge.song!.songId, challenge.song!.difficulty)}
                          </p>
                          <p>
                            ${t("challengeValue", "Average {reward} per {cost} CP · {value} per CP", { reward: number(challenge.event!.mean), cost: job.cycle!.consumption, value: number(challenge.event!.mean / job.cycle!.consumption) })}
                          </p>
                          <p>
                            ${t("ptRange", "Direct reward range")}: ${number(challenge.event!.perPlayMin)} –
                            ${number(challenge.event!.perPlayMax)} · ${host.t("eventBonus", "Event bonus")}:
                            +${number(challenge.event!.bonusPercent)}%
                          </p>
                          ${trialFormation(host, challenge)}
                        </article>
                      `
                    : html`
                        <p>
                          ${t("challengePending", "The challenge search for this reward is incomplete or has no legal team. Its solo ranking waits; CP is not treated as zero. Check chart states below.")}
                        </p>
                      `
                }
                <p>
                  ${t("rounding", "Display values round to three decimals; ranking uses full precision. Only exact equals are marked tied. IDs do not imply a speed advantage.")}
                </p>
                ${
                  pt.running
                    ? html`
                        <md-linear-progress
                          indeterminate
                          aria-label=${t("searching", "Calculating a chart")}
                        ></md-linear-progress>
                      `
                    : nothing
                }
                ${
                  !ranking.length
                    ? html`
                        <p>${t("noResults", "No fully calculated recommendation yet.")}</p>
                      `
                    : nothing
                }
                ${shown.map((hit) => {
                  const index = ranking.findIndex((row) => row.key === hit.key) + 1;
                  const tied = ranking.filter((row) => row.key === hit.key).length > 1;
                  return html`
                    <article class="card card--outlined tb-hit stack">
                      <header class="tb-hit__header">
                        <span class="tb-hit__rank">${index}</span>
                        <div class="tb-hit__main">
                          <strong>${catalog.songTitle(hit.song!.songId)}</strong>
                          <span>
                            ${catalog.difficultyLabel(hit.song!.songId, hit.song!.difficulty)}${tied ? ` · ${t("tied", "Tied PT")}` : ""}
                          </span>
                        </div>
                      </header>
                      <div class="row row--wrap">
                        <strong>${t("meanPt", "Average total")}: ${number(hit.event!.mean)} ${currency}</strong>
                        <span>
                          ${t("ptRange", "Direct reward range")}: ${number(hit.event!.perPlayMin)} –
                          ${number(hit.event!.perPlayMax)}
                        </span>
                        <span>${host.t("eventBonus", "Event bonus")}: +${number(hit.event!.bonusPercent)}%</span>
                      </div>
                      <p>
                        ${t("breakdown", "Direct {direct} + CP value {converted}; average CP earned {cp}", { direct: number(hit.event!.directMean!), converted: number(hit.event!.convertedMean!), cp: number(hit.event!.challengePoints) })}
                      </p>
                      ${
                        hit.gekiso
                          ? html`
                              <p>
                                ${t(
                                  "effectiveJust",
                                  "JUST on eligible notes: baseline {base} → after skills {effective}; {converted} converted notes.",
                                  {
                                    base:
                                      hit.gekiso.just.baselineRate === null
                                        ? "—"
                                        : `${number(hit.gekiso.just.baselineRate * 100)}%`,
                                    effective:
                                      hit.gekiso.just.effectiveRate === null
                                        ? "—"
                                        : `${number(hit.gekiso.just.effectiveRate * 100)}%`,
                                    converted: number(hit.gekiso.just.convertedHits),
                                  },
                                )}
                              </p>
                              <p>
                                ${hit.gekiso.sampled ? t("sampledResult", "Luck estimate · {samples} samples × 120 skill orders", { samples: hit.gekiso.luckSamples }) : t("deterministicResult", "No Luck lottery · 120 skill orders")}
                              </p>
                            `
                          : nothing
                      }
                      ${trialFormation(host, hit)}
                      <details>
                        <summary>${t("otherCharts", "Other completed difficulties")}</summary>
                        <ul>
                          ${job.tasks
                            .filter(
                              (task) =>
                                task.route === "live" &&
                                task.measure === pt.measure &&
                                task.status === "complete" &&
                                task.song.songId === hit.song!.songId,
                            )
                            .map(
                              (task) => html`
                                <li>
                                  ${catalog.difficultyLabel(task.song.songId, task.song.difficulty)} ·
                                  ${number(task.result!.hits[0]!.event!.mean)} ${currency}
                                </li>
                              `,
                            )}
                        </ul>
                      </details>
                    </article>
                  `;
                })}
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
                          ${pt.showAll ? t("topFive", "Show five songs") : t("showAll", "Show all completed songs ({count})", { count: ranking.length })}
                        </button>
                      `
                    : nothing
                }
                ${
                  counts.pruned && !ptAllComplete(job)
                    ? html`
                        <button
                          class="button button--tonal"
                          type="button"
                          ?disabled=${host.running || pt.stale || !pt.accepted || !!pt.issues.length}
                          @click=${() => void pt.start(true, "all")}
                        >
                          ${t("calculateAll", "Continue to calculate every song")}
                        </button>
                      `
                    : nothing
                }
                <details>
                  <summary>${t("taskDetails", "Chart states, versions and assumptions")}</summary>
                  <p class="pt-metadata">${job.server} · ${job.releaseId} · ${job.sourceId} · ${job.id}</p>
                  <p class="pt-metadata">${job.version} · ${job.fingerprint}</p>
                  <ul>
                    ${job.tasks.map(
                      (task) => html`
                        <li>
                          ${t(task.route === "live" ? (job.request.goal.kind === "event" && job.request.goal.gekiso ? "gekiso" : "solo") : "challenge", task.route)}
                          · ${t(task.measure, task.measure)} · ${catalog.songTitle(task.song.songId)} ·
                          ${catalog.difficultyLabel(task.song.songId, task.song.difficulty)}:
                          ${t(`status.${task.status}`, task.status)}${
                            task.error
                              ? html`
                                  <details>
                                    <summary>
                                      ${t("failureHelp", "Could not calculate this chart; check data or retry by continuing.")}
                                    </summary>
                                    <p class="pt-metadata">${task.error}</p>
                                  </details>
                                `
                              : nothing
                          }
                        </li>
                      `,
                    )}
                  </ul>
                  <p>
                    ${t("assumptions", "Full PERFECT, equal weights for 120 skill orders, current power and photo-equipment rules. Unverified data rules are listed below.")}
                  </p>
                  <ul>
                    ${job.assumptions.map(
                      (reason) => html`
                        <li class="pt-metadata">${reason}</li>
                      `,
                    )}
                  </ul>
                </details>
              </section>
            `
          : nothing
      }
    </div>
  `;
}
