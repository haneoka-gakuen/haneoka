// L3 — GEB
// Input: Event rules, regional leaderboard metadata, selected difficulties and the current engine request.
// Output: Search progress and best qualifying chart per event song, or one shared team's mean scores.
// Pos: [Map](../L2-2.md); totals within the challenge ranking task.
// Effects/Dependencies: Reads the regional archive; runs the normal Worker and saves device checkpoints.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { releaseSongTotal } from "../../lib/event-challenge-route";
import type { TrackedEventDto } from "../../lib/game-records";
import { gameAccountRegion } from "../shared/game-records";
import { songPickerDifficultyFilters } from "../ui/song-picker-filters";
import { fetchJson } from "../shared/catalog";
import type { EngineResponse, SongRef } from "../../lib/team-builder/engine/api";
import { clock, singleSongRequest } from "../../lib/team-builder/engine/execution";
import { countChart, countChallengeSongs, loadChallengeTotal, saveChallengeTotal,
  type ChallengeTotalResult } from "../../lib/team-builder/challenge-total";
import { choiceField, sectionHeading } from "./catalog";
import { teamFormation } from "./results";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";

export class ChallengeTotal {
  private archives = new Map<string, TrackedEventDto[]>();
  private releaseFlags = new Map<string, boolean | undefined>();
  private scope = "";
  private restoring?: Promise<void>;
  private runKey = "";
  private stopRequested = false;
  result?: ChallengeTotalResult;
  storageError = false;
  constructor(private readonly host: TeamBuilder) {}

  get region() {
    return this.host.challenge.region ?? gameAccountRegion(this.host.server, this.host.locale, this.host.gameAccount?.uid);
  }
  rankedEvent(event: number) {
    return this.archives.get(this.region)?.find(row => Number(row.id) === event);
  }
  enabled(event: number | null) {
    if (event === null) return false;
    const flag = this.host.data?.events[String(event)]?.totalMusicRankingEnabled;
    return this.rankedEvent(event)?.totalRankingEnabled ??
      releaseSongTotal(this.host.server, event, flag) ?? this.releaseFlags.get(this.releaseKey(event));
  }
  private releaseKey(event: number) {
    return JSON.stringify([this.host.data?.identity, event]);
  }
  get selected() {
    return this.host.settings.challengeTotal === true && this.enabled(this.host.settings.eventId) === true;
  }
  get shared() { return this.host.settings.challengeShared === true; }
  get difficulties() { return this.host.settings.challengeDifficulties ?? this.host.songDifficulties; }
  pool(event: number | null) {
    if (event === null) return [];
    const tracks = this.host.catalog!.challengeSongs(event);
    const ids = new Set(tracks.map(track => track.liveMusicId));
    for (const track of this.rankedEvent(event)?.challenges ?? []) ids.add(Number(track.musicId));
    return [...ids].map(id => {
      // A regional entry alone cannot establish the release-specific scoring rules for a chart.
      const source = this.host.data?.crossServer?.owners.songs?.[String(id)] ?? this.host.data?.identity.server;
      const rows = source === this.host.server && tracks.some(track => track.liveMusicId === id) && this.host.catalog!.songVisible(id)
        ? this.host.catalog!.difficultyRows(id) : [];
      return { id, available: rows.map(row => Number(row.difficulty)) };
    });
  }
  charts(event: number | null): SongRef[] {
    return this.pool(event).flatMap(song => song.available.filter(d => this.difficulties.includes(d))
      .map(difficulty => ({ songId: song.id, difficulty })));
  }

  private key() {
    const h = this.host;
    return h.tab === "challenge" && h.snapshot && this.selected
      ? JSON.stringify([h.server, h.snapshot.owner, h.gameAccount?.id, h.data?.identity.releaseId,
        this.region, h.settings.eventId, this.shared]) : "";
  }
  private context() {
    return JSON.stringify([this.host.calculationContext(), this.pool(this.host.settings.eventId), this.difficulties]);
  }
  get stale() { return !!this.result && this.result.context !== this.context(); }

  sync() {
    const h = this.host;
    if (h.tab === "challenge" && h.snapshot && h.data) {
      const region = this.region;
      if (!this.archives.has(region)) {
        this.archives.set(region, []);
        void fetchJson<{ events: TrackedEventDto[] }>(`/api/v1/game/records/${region}/events/archive`)
          .then(({ events }) => {
            this.archives.set(region, events);
            if (h.isConnected && h.tab === "challenge" && this.region === region) h.challenge.applyRoute();
          })
          .catch(() => { /* A release's board rules also apply before a regional record is captured. */ });
      }
      const event = h.settings.eventId;
      if (event !== null && this.enabled(event) === undefined && !this.releaseFlags.has(this.releaseKey(event))) {
        const key = this.releaseKey(event), identity = h.data.identity;
        this.releaseFlags.set(key, undefined);
        void fetch(`/api/v1/servers/${h.server}/events/${event}?release=${encodeURIComponent(identity.releaseId)}`)
          .then(async response => {
            if (!response.ok || response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
              response.headers.get("x-haneoka-source-id") !== identity.sourceId) return;
            const row = await response.json() as { totalMusicRankingEnabled?: boolean };
            if (typeof row.totalMusicRankingEnabled === "boolean") {
              this.releaseFlags.set(key, row.totalMusicRankingEnabled);
              h.requestUpdate();
            }
          }).catch(() => {});
      }
    }
    const key = this.key();
    if (key !== this.scope) {
      this.stop();
      this.scope = key;
      this.result = undefined;
      this.storageError = false;
      this.restoring = key ? loadChallengeTotal(key).then(saved => {
        if (this.scope === key) this.result = saved;
      }).catch(() => { if (this.scope === key) this.storageError = true; }).finally(() => h.requestUpdate()) : undefined;
      h.requestUpdate();
    } else if (this.runKey && this.runKey !== this.context()) this.stop();
  }

  get resumable() {
    return !!this.result && !this.stale && this.result.songs.some(song => song.charts.some(row => !row.proven));
  }
  dispose() {
    this.stop();
    this.runKey = "";
    this.scope = "";
    this.result = undefined;
  }
  stop() {
    if (!this.runKey || this.stopRequested) return;
    this.stopRequested = true;
    this.host.engine?.cancel();
  }

  async run() {
    const h = this.host, engine = h.engine, request = h.request();
    if (!engine || request?.goal.kind !== "score" || !this.selected) return;
    const token = h.acquireTask("challenge-total");
    if (!token) return;
    const goal = request.goal, scope = this.key(), context = this.context(), shared = this.shared;
    this.runKey = context;
    this.stopRequested = false;
    const active = () => h.ownsTask(token) && this.scope === scope && !this.stopRequested && this.runKey === context;
    const save = async (snapshot: ChallengeTotalResult) => {
      try { await saveChallengeTotal(scope, snapshot); }
      catch { if (this.scope === scope) this.storageError = true; }
    };
    try {
      await this.restoring;
      if (!active()) return;
      const continuing = this.result?.context === context;
      const result: ChallengeTotalResult = this.result = continuing ? this.result! : {
        context, shared, sharedKey: null,
        songs: this.pool(h.settings.eventId).map(song => ({ id: song.id,
          charts: goal.songs.filter(row => row.songId === song.id).map(row => ({ ...row, proven: false })) })),
      };
      result.stopped = false;
      h.calculationSubmitted();
      const deadline = request.timeLimitMs === null || continuing ? Infinity : clock() + request.timeLimitMs;
      const charts = result.songs.flatMap(song => song.charts);
      const groups = shared ? [charts] : charts.filter(row => !row.proven).map(chart => [chart]);
      for (const group of groups) {
        if (!active() || !group.length || group.every(chart => chart.proven) || clock() >= deadline) break;
        let savedKey = -Infinity;
        const accept = (response: EngineResponse) => {
          if (!active()) return;
          const part = response.results[0], hit = part?.hits[0];
          if (!part) return;
          if (shared && hit && result.sharedKey !== null && hit.key < result.sharedKey) return;
          if (shared && hit) result.sharedKey = hit.key;
          const scores = shared && group.length > 1 ? hit?.aggregate?.songs ?? [] : hit ? [hit] : [];
          for (const chart of group) {
            const score = scores.find(row => row.song?.songId === chart.songId && row.song.difficulty === chart.difficulty);
            countChart(chart, score, part.proven, shared);
            chart.error = response.error;
          }
          if (hit && hit.key > savedKey) {
            savedKey = hit.key;
            void save(result);
          }
          h.requestUpdate();
        };
        try {
          const response = await engine.run(singleSongRequest({ ...request, deadline, k: 1,
            goal: { ...goal, songs: group.map(({ songId, difficulty }) => ({ songId, difficulty })) } }),
            undefined, snapshot => accept(snapshot.response));
          accept(response);
        } catch (error) {
          if (active()) for (const chart of group) chart.error = h.errorReason(error);
        }
        await save(result);
        h.requestUpdate();
      }
      if (result.songs.some(song => song.charts.some(chart => !chart.proven)) &&
        (this.stopRequested || clock() >= deadline)) {
        result.stopped = true;
        await save(result);
      }
    } finally {
      if (h.ownsTask(token)) {
        this.runKey = "";
        h.releaseTask(token);
      }
    }
  }
}

export function totalControls(host: TeamBuilder) {
  const { total } = host.challenge;
  const levels = [...new Set(total.pool(host.settings.eventId).flatMap(row => row.available))].sort((a,b) => a-b);
  return html`
    <div class="stack stack--tight"><span class="tb-field__label">${host.t("difficulty", "Difficulty")}</span>
      ${songPickerDifficultyFilters({ label: host.t("difficulty", "Difficulty"),
        choices: levels.map(value => ({ value, label: ["EASY", "NORMAL", "HARD", "EXPERT", "SPECIAL"][value]! })),
        selected: total.difficulties, change: values => host.updateSettings({ challengeDifficulties: values.sort((a, b) => a - b) }),
        allLabel: host.t("allChartDifficulties", "All difficulties") })}
    </div>
    ${choiceField({type:"select", label:host.t("challenge.teamMode", "Team selection"),
      value:total.shared ? "shared" : "individual", options:[
        {value:"individual", label:host.t("challenge.individual","Best single play per song")},
        {value:"shared", label:host.t("challenge.shared","One team · highest mean across selected charts")}],
      onSelect:value => host.updateSettings({challengeShared: value === "shared"})})}`;
}

export function totalResults(host: TeamBuilder) {
  const { total } = host.challenge;
  const pool = total.pool(host.settings.eventId);
  const state = total.result ?? { context: "", shared: total.shared, sharedKey: null,
    songs: pool.map(song => ({ id: song.id, charts: total.charts(host.settings.eventId)
      .filter(chart => chart.songId === song.id).map(chart => ({ ...chart, proven: false })) })) };
  const counted = countChallengeSongs(state);
  const fmt = (score: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 2 }).format(score);
  const complete = host.t("challenge.verified", "Verified for the selected search");
  const candidate = host.t("challenge.candidate", "Candidate");
  const t = (k: string, label: string) => host.t("challenge." + k, label);
  return html`<section class="surface stack" data-challenge-total-results>
    ${sectionHeading({ icon:"emoji_events", label:t("estimated","Estimated song total") })}
    <div class="cluster">
      <strong>${counted.covered === counted.songs.length && counted.covered ? t("current","Current total") : t("subtotal","Subtotal")}
        · ${fmt(counted.total)}</strong>
      <span>${host.t("challenge.covered","{done}/{total} songs with a score",{ done:counted.covered,total:counted.songs.length })}</span>
      ${total.result?.stopped && !total.stale ? html`<span>${t("paused", "Paused")}</span>` : nothing}
      ${total.stale ? html`<span>${host.t("stale","Conditions changed")}</span>` : counted.complete ? html`<span>${complete}</span>` : nothing}
    </div>
    ${state.shared ? html`<span>${t("shared","One team · highest mean across selected charts")}${state.sharedKey !== null ? " · " + fmt(state.sharedKey) : ""}</span>` : nothing}
    ${counted.songs.map(song => {
      const best = song.best, value = best?.candidate;
      const status = !song.charts.length ? t("missing","No selected chart available")
        : song.charts.some(row => row.error) ? t("failed","Chart search failed")
        : song.complete ? value ? complete : t("empty","No eligible team")
        : value ? candidate : host.t("challenge.pending","Pending");
      return html`<section class="stack stack--tight" data-song-id=${song.id}>
        <h3>${host.catalog!.songTitle(song.id) || "#" + song.id}</h3>
        <div class="cluster">${best ? html`<span>${host.catalog!.difficultyLabel(song.id, best.difficulty)}</span><strong>${fmt(value!.score)}</strong>` : nothing}
          <span>${status}</span>
          <span>${host.t("provenChartProgress","Charts proven {done}/{total}",{done:song.proven,total:song.charts.length})}</span>
        </div>
        ${value ? teamFormation(host, value.members.map((member,index) => ({ member:cardIdOf(member), snap:value.snaps[index] ? cardIdOf(value.snaps[index]!) : null })),0,false) : nothing}
      </section>`;
    })}
    ${total.storageError ? html`<span role="status">${host.t("pt.storageError","Progress could not be saved on this device")}</span>` : nothing}
  </section>`;
}
