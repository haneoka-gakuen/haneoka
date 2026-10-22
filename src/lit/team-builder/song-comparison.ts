// L3 — GEB
// Input: TeamBuilder 的当前队伍、资料、账户与选曲条件。
// Output: 串行评分状态、内存结果缓存、分组顺序与字段校验。
// Pos: [Map](../L2-2.md)；激奏选曲对比控制器。
// Effects/Dependencies: 写入 Box 偏好；持有共享引擎任务令牌，取消旧请求并更新 DOM。
import type { TeamBuilder } from "../team-builder";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import type { EngineHit, SongRef } from "../../lib/team-builder/engine/api";
import { canonical } from "../../lib/team-builder/pt-recommendation";
import {
  acceptComparisonResult,
  availableOnServer,
  chartIssue,
  chartKey,
  comparisonDefaults,
  comparisonIssues,
  comparisonRequest,
  fixedFormation,
  groupedSongs,
  readComparisonSettings,
  type ComparisonIssue,
  type ComparisonRow,
  type ComparisonSettings,
} from "../../lib/team-builder/song-comparison";

const PREF = "song-comparison";
export class SongComparison {
  settings = comparisonDefaults();
  rows: ComparisonRow[] = [];
  private previous: { rows: ComparisonRow[]; settings: ComparisonSettings } | null = null;
  private evaluatedSettings: ComparisonSettings | null = null;
  get stale() {
    return this.previous !== null;
  }
  get resultRows() {
    return this.previous?.rows ?? this.rows;
  }
  get resultSettings() {
    return { ...(this.previous?.settings ?? this.evaluatedSettings ?? this.settings), sort: this.settings.sort };
  }
  expanded = new Set<number>();
  issues: ComparisonIssue[] = [];
  submitted = false;
  running = false;
  private generation = 0;
  private signature = "";
  private selection = "";
  private owner = "";
  private engine: TeamBuilder["engine"] = null;
  private token: symbol | null = null;
  private readonly cache = new Map<string, EngineHit>();
  private order: number[] = [];
  constructor(private readonly host: TeamBuilder) {}
  team() {
    return fixedFormation(this.host.master!, this.host.view!, this.host.manual);
  }
  restore() {
    this.settings = readComparisonSettings(this.host.view?.prefs[PREF]);
    this.sync();
  }
  get effectiveSettings(): ComparisonSettings {
    const songs = this.settings.songs.filter(
      (song) =>
        availableOnServer(this.host.data!, "songs", song.songId) &&
        this.host.catalog!.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty),
    );
    return { ...this.settings, songs, just: this.host.hasMission("JustCount", songs) ? this.settings.just : 100 };
  }
  private context() {
    const host = this.host,
      s = this.effectiveSettings;
    const team = this.team();
    return canonical([
      host.snapshot?.owner,
      host.server,
      host.data?.identity,
      host.data?.crossServer,
      team.members,
      team.snaps,
      team.bindings,
      team.leader,
      team.player,
      "min",
      s.mode,
      s.mode === "ap" ? 0 : s.great,
      s.just,
      s.mode === "ap" ? 0 : s.missEvery,
      s.rank,
      0,
    ]);
  }
  sync() {
    if (!this.host.master || !this.host.view) return;
    const signature = this.context(),
      selection = canonical(this.settings.songs);
    const owner = canonical([
      this.host.snapshot?.owner,
      this.host.server,
      this.host.data?.identity,
      this.host.data?.crossServer,
    ]);
    if (this.owner !== owner || this.engine !== this.host.engine) {
      this.stop();
      this.cache.clear();
      this.previous = null;
      this.evaluatedSettings = null;
      this.rows = [];
      this.signature = "";
      this.owner = owner;
      this.engine = this.host.engine;
    }
    if (signature === this.signature && selection === this.selection) return;
    this.stop();
    if (!this.previous && this.rows.some((row) => row.hit) && this.evaluatedSettings)
      this.previous = { rows: structuredClone(this.rows), settings: structuredClone(this.evaluatedSettings) };
    if (signature !== this.signature) this.cache.clear();
    this.signature = signature;
    this.selection = selection;
    this.rows = this.settings.songs
      .filter(
        (song) =>
          availableOnServer(this.host.data!, "songs", song.songId) &&
          this.host.catalog!.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty),
      )
      .map((song) => {
        const hit = this.cache.get(chartKey(song));
        return { song, status: hit ? "complete" : "pending", hit };
      });
    this.order = [...new Set(this.rows.map((row) => row.song.songId))];
    this.validate();
  }
  update(patch: Partial<ComparisonSettings>) {
    this.settings = { ...this.settings, ...patch };
    if (this.settings.rank !== null && this.settings.rank > this.settings.players) this.settings.rank = null;
    this.host.write([{ key: `pref.${PREF}`, value: this.settings as unknown as BoxValue }]);
    this.sync();
    if (!this.stale && this.evaluatedSettings)
      this.evaluatedSettings = {
        ...this.evaluatedSettings,
        target: this.settings.target,
        players: this.settings.players,
      };
    if (patch.sort || patch.target || patch.players) this.reorder();
    this.host.requestUpdate();
  }
  private validate() {
    const team = this.team();
    this.issues = [
      ...team.issues,
      ...comparisonIssues({ ...this.effectiveSettings, songs: this.rows.map((row) => row.song) }),
    ];
    for (const [slot, id] of this.host.manual.members.entries())
      if (id !== null && !availableOnServer(this.host.data!, "members", id))
        this.issues.push({ field: `sc-slot-${slot}`, reason: "source", slot });
    for (const [slot, id] of this.host.manual.snaps.entries())
      if (id !== null && !availableOnServer(this.host.data!, "snapshots", id))
        this.issues.push({ field: `sc-slot-${slot}`, reason: "source", slot });
  }
  markFields() {
    for (const element of this.host.querySelectorAll<HTMLElement>("[data-sc-field]"))
      element.toggleAttribute(
        "data-invalid",
        this.host.tab === "song-comparison" &&
          this.submitted &&
          this.issues.some((issue) => issue.field === element.id),
      );
  }
  choose() {
    this.host.songPicker = {
      songs: this.settings.songs.map((song) => ({ ...song })),
      single: false,
      query: "",
      filtersOpen: false,
      bands: [],
      attributes: [],
      gekisouTypes: [],
      difficulty: 2,
      allowedSongIds: [...this.host.master!.songs.keys()].filter((id) =>
        availableOnServer(this.host.data!, "songs", id),
      ),
      context: "comparison",
      title: this.host.t("sc.choose", "Playable charts"),
      change: (songs) => this.update({ songs }),
    };
    this.host.requestUpdate();
  }
  groups() {
    const groups = groupedSongs(this.resultRows, this.host.master!, this.resultSettings);
    return groups.sort((a, b) => this.order.indexOf(a.id) - this.order.indexOf(b.id));
  }
  reorder() {
    const anchor = [...this.host.querySelectorAll<HTMLElement>("[data-sc-song]")].find((row) => {
      const bounds = row.getBoundingClientRect();
      const region = row.closest<HTMLElement>(".table-scroll")!.getBoundingClientRect();
      return bounds.bottom > Math.max(0, region.top) && bounds.top < Math.min(window.innerHeight, region.bottom);
    });
    const id = anchor?.dataset.scSong,
      top = anchor?.getBoundingClientRect().top;
    this.order = groupedSongs(this.resultRows, this.host.master!, this.resultSettings).map((group) => group.id);
    this.host.requestUpdate();
    if (id && top !== undefined)
      void this.host.updateComplete.then(() => {
        const current = this.host.querySelector<HTMLElement>(`[data-sc-song="${id}"]`);
        if (current)
          current.closest<HTMLElement>(".table-scroll")!.scrollTop += current.getBoundingClientRect().top - top;
      });
  }
  stop() {
    ++this.generation;
    if (this.token && this.host.ownsTask(this.token)) {
      this.engine?.cancel();
      this.host.releaseTask(this.token);
    }
    this.token = null;
    this.running = false;
    for (const row of this.rows) if (row.status === "running" || row.status === "pending") row.status = "cancelled";
    this.host.requestUpdate();
  }
  dispose() {
    this.stop();
    this.cache.clear();
    this.rows = [];
    this.previous = null;
    this.evaluatedSettings = null;
    this.signature = "";
    this.selection = "";
  }
  async start(only?: SongRef) {
    this.sync();
    this.submitted = true;
    this.validate();
    const host = this.host;
    if (this.issues.length || !host.engine) {
      host.requestUpdate();
      await host.updateComplete;
      if (this.issues[0]) await host.focusInput(this.issues[0].field);
      return;
    }
    const token = host.acquireTask("comparison");
    if (!token) return;
    this.previous = null;
    this.evaluatedSettings = structuredClone(this.effectiveSettings);
    this.token = token;
    this.engine = host.engine;
    const engine = host.engine,
      generation = ++this.generation,
      signature = this.signature;
    const team = structuredClone(this.team()),
      settings = structuredClone(this.effectiveSettings);
    const current = () => generation === this.generation && host.ownsTask(token) && this.context() === signature;
    const queue = this.rows.filter(
      (row) => row.status !== "complete" && (!only || chartKey(row.song) === chartKey(only)),
    );
    this.running = true;
    host.calculationSubmitted();
    host.requestUpdate();
    try {
      for (const row of queue) {
        if (!current()) break;
        row.status = "running";
        delete row.reason;
        host.requestUpdate();
        const issue = chartIssue(host.master!, host.data!, row.song, settings.rank!);
        if (issue) {
          row.status = "failed";
          row.reason = issue;
          continue;
        }
        const request = comparisonRequest(team, settings, row.song, signature);
        const started = performance.now();
        let completed = false;
        try {
          await engine.run(request, undefined, undefined, (final) => {
            if (!current() || final.requestId !== request.requestId || final.contextKey !== signature) return;
            const hit = acceptComparisonResult(request, final.response);
            completed = true;
            row.hit = hit;
            row.status = "complete";
            row.elapsedMs = performance.now() - started;
            this.cache.set(chartKey(row.song), hit);
            host.requestUpdate();
          });
          if (current() && !completed) throw new Error("final-score-missing");
        } catch (error) {
          if (!current()) break;
          console.error("song-comparison", row.song, error);
          row.status = "failed";
          row.reason = "scoreFailed";
        }
        if (current()) host.requestUpdate();
      }
    } finally {
      if (generation === this.generation) {
        for (const row of this.rows) if (row.status === "running") row.status = "cancelled";
        this.running = false;
        this.token = null;
        host.releaseTask(token);
        this.reorder();
      }
    }
  }
}
