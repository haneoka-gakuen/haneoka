import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { TeamBuilder } from "../team-builder";
import { engineInputs } from "../../lib/team-builder/sync/box-view";
import type { EngineRequest, SongRef } from "../../lib/team-builder/engine/api";
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
import { boostControl } from "./boost-control";
import type { SongPickerState } from "./song-picker";
import { iconButton, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { icon } from "../ui/icon";
import { issueField, ptField } from "./pt-fields";

export class PtController {
  job: PtJob | null = null;
  running = false;
  showAll = false;
  measure: PtMeasure = "points";
  storageError = false;
  error = "";
  dataFingerprint = "";
  constraintsOpen = false;
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
    if (field === "constraints" || field === "minBonus") this.constraintsOpen = true;
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
    const { view, settings: s } = this.host;
    if (!view) return null;
    const cards = engineInputs(view);
    return {
      members: cards.members,
      snaps: s.noSnaps ? [] : cards.snaps,
      player: {
        ...structuredClone(view.player),
        // The game has no memory growth yet; stored values must not count.
        characterMemory: Object.fromEntries([...(this.host.master?.characters.keys() ?? [])].map((id) => [id, 0])),
        musicMemory: Object.fromEntries([...(this.host.master?.songs.keys() ?? [])].map((id) => [id, 0])),
      },
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
      for (const task of job?.tasks ?? []) if (task.status === "running") task.status = "queued";
      this.dataFingerprint = hash;
      this.job = job;
    } catch {
      if (generation !== this.generation) return;
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
  }
  async start(resume: boolean, scope?: PtScope) {
    this.sync();
    const host = this.host;
    if (this.issues.length) {
      this.showIssues = true;
      host.requestUpdate();
      await host.updateComplete;
      host.querySelector<HTMLElement>("#pt-issues")?.focus();
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
    snap: host.t("snapshots", "Photos"),
    "required-members": host.t("pt.requiredMembers", "Required members share a character"),
    "photo-bindings": host.t("pt.photoBindings", "A photo is bound twice"),
  };
  if (titles[target]) return titles[target];
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

function songButton(
  host: TeamBuilder,
  options: { label: string; icon: TemplateResult; count: number; disabled?: boolean; open: () => void },
) {
  return html`
    <button
      class="button button--tonal pt-song-choice"
      type="button"
      ?disabled=${options.disabled}
      @click=${options.open}
    >
      ${options.icon}
      <span>${options.label}</span>
      <span class="tabular">${options.count}</span>
    </button>
  `;
}

function renderSetup(host: TeamBuilder): TemplateResult {
  const pt = host.pt;
  const t = (key: string, fallback: string) => host.t(`pt.${key}`, fallback);
  const s = host.settings;
  const catalog = host.catalog!;
  const master = host.master!;
  const request = pt.request()!;
  const picker = (songs: SongRef[], change: (songs: SongRef[]) => void, extra: Partial<SongPickerState> = {}) => {
    host.songPicker = {
      songs: [...songs],
      single: false,
      query: "",
      filtersOpen: false,
      bands: [],
      attributes: [],
      gekisouTypes: [],
      difficulty: 3,
      change,
      ...extra,
    };
    host.requestUpdate();
  };
  const constraints = html`
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
    ${
      s.bindings.length
        ? html`
            <ul class="pt-bindings">
              ${s.bindings.map(
            ([m, p], index) => html`
              <li>
                <span>
                  ${catalog.cardName("members", m)} →
                  ${p === null ? host.t("noSnap", "No snap") : catalog.cardName("snaps", p)}
                </span>
                ${iconButton({
                icon: "close",
                label: t("removeBinding", "Remove binding"),
                onClick: () => host.updateSettings({ bindings: s.bindings.filter((_, i) => i !== index) }),
              })}
              </li>
            `,
          )}
            </ul>
          `
        : nothing
    }
  `;
  return html`
    <section class="surface stack">
      ${sectionHeading({ icon: "emoji_events", label: host.t("eventSetup", "Event") })}
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
              ${catalog.events().map(
              (event) => html`
                <md-select-option value=${String(event.id)}><div slot="headline">${event.name}</div></md-select-option>
              `,
            )}
            </md-outlined-select>
          `,
        )}
        ${ptField(
          host,
          "consumption",
          boostControl(host, s.boosts, (boosts) => host.updateSettings({ boosts })),
        )}
        ${
          s.ptMode === "gekiso"
            ? html`
                ${ptField(
                host,
                "gekiso-input",
                html`
                  <md-outlined-text-field
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    label=${t("baselineJust", "Baseline JUST (%)")}
                    .value=${live(String(s.ptJust))}
                    @change=${(e: Event) => host.updateSettings({ ptJust: Number((e.target as HTMLInputElement).value) })}
                  ></md-outlined-text-field>
                `,
              )}
                <md-outlined-text-field
                  type="number"
                  min="1"
                  step="1"
                  label=${t("luckSamples", "Luck samples")}
                  .value=${live(String(s.ptLuckSamples))}
                  @change=${(e: Event) => host.updateSettings({ ptLuckSamples: Number((e.target as HTMLInputElement).value) })}
                ></md-outlined-text-field>
              `
            : nothing
        }
      </div>
    </section>
    <section class="surface stack">
      ${sectionHeading({ icon: "library_music", label: host.t("songs", "Songs") })}
      <div class="pt-form-grid">
        ${ptField(
          host,
          "selection",
          songButton(host, {
            label: host.t("chooseSongs", "Choose songs"),
            icon: icon("library_music", 20),
            count: s.songs.length,
            open: () => picker(s.songs, (songs) => host.updateSettings({ songs })),
          }),
        )}
        ${ptField(
          host,
          "challenge-selection",
          songButton(host, {
            label: t("chooseChallenge", "Challenge songs"),
            icon: icon("swords", 20),
            count: s.planChallengeSongs.length,
            disabled: s.eventId === null,
            open: () =>
              picker(s.planChallengeSongs, (planChallengeSongs) => host.updateSettings({ planChallengeSongs }), {
                allowedSongIds: master.challengeMusics
                  .filter((row) => row.eventId === s.eventId)
                  .map((row) => row.liveMusicId),
                title: t("chooseChallenge", "Challenge songs"),
              }),
          }),
        )}
        ${ptField(
          host,
          "challenge-consumption",
          html`
            <md-outlined-select
              label=${t("challengeCost", "CP per challenge")}
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
      </div>
    </section>
    ${accordion({
      id: "pt-constraints",
      className: "surface tb-accordion",
      leading: icon("tune", 20),
      label: t("constraints", "Leader and photos"),
      supportingText: host.t("candidateSummary", "{members} members · {snaps} snaps", {
        members: request.members.length,
        snaps: request.snaps.length,
      }),
      content: ptField(host, "constraints", constraints),
      expanded: pt.constraintsOpen,
      onExpandedChange: (expanded) => {
        pt.constraintsOpen = expanded;
        host.requestUpdate();
      },
    })}
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
  return html`
    <div class="tb-run">
      ${
        pt.running
          ? html`
              <button class="button button--tonal button--full" type="button" @click=${() => pt.stop()}>
                ${icon("stop", 18)}${t("stop", "Stop")}
              </button>
            `
          : html`
              <button
                class="button button--full tb-run__button"
                type="button"
                ?disabled=${blocked}
                @click=${() => void pt.start(false)}
              >
                ${icon("search", 20)}${t("start", "Calculate")}
              </button>
            `
      }
      ${
        !pt.running && job && !ptComplete(job) && !pt.stale
          ? html`
              <button
                class="button button--tonal button--full"
                type="button"
                ?disabled=${blocked}
                @click=${() => void pt.start(true)}
              >
                ${icon("play_arrow", 18)}${t("resume", "Continue")}
              </button>
            `
          : nothing
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
  if (!job)
    return html`
      <div class="state">
        <span class="state__icon">${icon("emoji_events", 40)}</span>
        <p class="state__title">${host.t("resultsEmpty", "Results appear here")}</p>
      </div>
    `;
  const catalog = host.catalog!;
  const ranking = ptSongRanking(job, pt.measure);
  const challenge = ptChallengeBest(job, pt.measure);
  const shown = pt.showAll ? ranking : ranking.slice(0, 5);
  const currency = pt.measure === "points" ? t("points", "Event PT") : t("items", "Shop medals");
  const number = (n: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 1 }).format(n);
  const settled = job.tasks.filter((task) => task.status !== "queued" && task.status !== "running").length;
  const pruned = job.tasks.filter((task) => task.status === "pruned").length;
  return html`
    <section class="stack" aria-live="polite">
      <div class="pt-results-bar">
        ${segmented({
          label: t("objective", "Reward"),
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
        <span class="pt-progress tabular">${settled}/${job.tasks.length}</span>
        ${
          pt.stale
            ? html`
                <span class="chip chip--static"><span class="chip__label">${t("stale", "Inputs changed")}</span></span>
              `
            : nothing
        }
      </div>
      ${
        pt.running
          ? html`
              <md-linear-progress
                .value=${job.tasks.length ? settled / job.tasks.length : 0}
                aria-label=${t("start", "Calculate")}
              ></md-linear-progress>
            `
          : nothing
      }
      ${
        challenge
          ? html`
              <article class="card card--outlined tb-hit stack">
                <header class="tb-hit__header">
                  <span class="tb-hit__rank">${icon("swords", 18)}</span>
                  <div class="tb-hit__main">
                    <strong>${catalog.songTitle(challenge.song!.songId)}</strong>
                    <span>
                      ${catalog.difficultyLabel(challenge.song!.songId, challenge.song!.difficulty)} ·
                      ${t("challengeBest", "Challenge team")}
                    </span>
                  </div>
                  <strong class="tabular">${number(challenge.event!.mean)}</strong>
                </header>
                ${formation(host, challenge)}
              </article>
            `
          : nothing
      }
      ${shown.map((hit, position) => {
        const index = ranking.indexOf(hit) + 1 || position + 1;
        return html`
          <article class=${`card card--outlined tb-hit stack${index === 1 ? " is-best" : ""}`}>
            <header class="tb-hit__header">
              <span class="tb-hit__rank">${index}</span>
              <div class="tb-hit__main">
                <strong>${catalog.songTitle(hit.song!.songId)}</strong>
                <span>
                  ${catalog.difficultyLabel(hit.song!.songId, hit.song!.difficulty)} ·
                  ${host.t("eventBonus", "Event bonus")} +${number(hit.event!.bonusPercent)}%
                </span>
              </div>
              <strong class="tabular">${number(hit.event!.mean)} ${currency}</strong>
            </header>
            <p class="pt-breakdown tabular">
              ${t("breakdown", "Live {direct} + CP {converted}", { direct: number(hit.event!.directMean!), converted: number(hit.event!.convertedMean!) })}
            </p>
            ${formation(host, hit)}
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
                ${pt.showAll ? t("topFive", "Top five") : t("showAll", "All {count} songs", { count: ranking.length })}
              </button>
            `
          : nothing
      }
      ${
        pruned && !ptAllComplete(job) && !pt.running
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
  host.pt.sync();
  return html`
    <div class="tb-build pt-recommendation">
      <div class="tb-config stack">
        ${renderSetup(host)} ${host.pt.showIssues && host.pt.issues.length ? renderIssues(host) : nothing}
        ${renderRun(host)}
      </div>
      <div class="tb-results-column">${renderRanking(host)}</div>
    </div>
  `;
}
