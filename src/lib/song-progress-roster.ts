// Input: Own Box snapshot, frozen R1 benchmark and the current published catalogue.
// Output: Locally certified current/potential roster ratings and one legal witness team.
// Pos: [Map](L2-2.md); lazy song-progress calculation adapter.
// Effects/Dependencies: Reuses EngineClient Worker/WASM and immutable chart downloads; no account queries or background polling.
import { EngineClient } from "./team-builder/engine/client";
import { fetchTeamBuilderData } from "./team-builder/data/fetch";
import { readBox, engineInputs } from "./team-builder/sync/box-view";
import type { BoxSnapshot } from "./team-builder/sync/box-store";
import { contentPublished } from "./content-publication";
import { rosterRequest, fullGrowthMember, fullGrowthSnap, type RosterReference } from "./song-progress-rating";
import type { TeamBuilderData } from "./team-builder/data";
import type { EngineHit } from "./team-builder/engine/api";
import engineUrl from "./team-builder/engine/generated/team-engine.wasm?url";

export interface RosterResult {
  value: number;
  witness: EngineHit;
  referenceId: string;
  dataId: string;
  key: string;
}
export interface RosterRatings {
  current: RosterResult | null;
  potential: RosterResult | null;
  incomplete: boolean;
}
const memory = new Map<string, RosterResult>();
const CACHE_VERSION = "haneoka.roster-rating.r1";
export class SongProgressRoster {
  private engine?: EngineClient;
  private data?: TeamBuilderData;
  private reference?: RosterReference;
  private lifetime = new AbortController();
  private generation = 0;
  private loading?: Promise<void>;
  load(server: string): Promise<void> {
    return (this.loading ??= (async () => {
      const [data, referenceModule] = await Promise.all([
        fetchTeamBuilderData(server, this.lifetime.signal),
        server === "jp" ? import("../config/roster-rating-r1-jp.json") : import("../config/roster-rating-r1-intl.json"),
      ]);
      this.lifetime.signal.throwIfAborted();
      const reference = referenceModule.default as RosterReference;
      data.songs = { ...data.songs, ...reference.songs };
      this.engine = new EngineClient(data, undefined, { maxWorkers: 1, charts: reference.charts });
      this.data = data;
      this.reference = reference;
    })().catch((error) => {
      this.loading = undefined;
      throw error;
    }));
  }
  get catalog() {
    return this.data;
  }
  cancel() {
    ++this.generation;
    this.engine?.cancel();
  }
  dispose() {
    this.cancel();
    this.lifetime.abort();
    this.engine?.dispose();
  }
  async calculate(
    snapshot: BoxSnapshot,
    server: string,
    progress: (done: number, total: number) => void,
  ): Promise<RosterRatings> {
    const generation = ++this.generation;
    const active = () => {
      this.lifetime.signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException("Cancelled", "AbortError");
    };
    await this.load(server);
    active();
    const data = this.data!,
      reference = this.reference!;
    const input = engineInputs(readBox(snapshot.entries), true);
    const members = input.members.filter(
      (row) => data.members[String(row.cardId)] && contentPublished(data.members[String(row.cardId)]),
    );
    const snaps = input.snaps.filter(
      (row) => data.snapshots[String(row.cardId)] && contentPublished(data.snapshots[String(row.cardId)]),
    );
    if (members.length !== input.members.length || snaps.length !== input.snaps.length)
      throw new Error("rating-card-data-missing");
    if (new Set(members.map((row) => data.members[String(row.cardId)]!.characterId)).size < 5 || snaps.length < 5)
      return { current: null, potential: null, incomplete: false };
    const incomplete =
      members.some((row) =>
        [
          row.level,
          row.awake,
          row.rank,
          ...(Number(data.members[String(row.cardId)]!.liveSkillId) > 0 ? [row.liveSkillLevel] : []),
        ].some((value) => value === null),
      ) || snaps.some((row) => row.level === null || row.rank === null);
    const versions = [reference.id, data.identity.releaseId, engineUrl];
    const run = async (potential: boolean): Promise<RosterResult> => {
      const m = potential
        ? members.map((row) => fullGrowthMember(row.cardId))
        : members.map((row) => ({ ...row, gekisoSkillLevel: null }));
      const s = potential ? snaps.map((row) => fullGrowthSnap(row.cardId)) : snaps;
      m.sort((a, b) => a.cardId - b.cardId);
      s.sort((a, b) => a.cardId - b.cardId);
      const bytes = new TextEncoder().encode(JSON.stringify([versions, m, s]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const key = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      let cached = memory.get(key);
      try {
        cached ??=
          (JSON.parse(localStorage.getItem(`${CACHE_VERSION}.${key}`) || "null") as RosterResult | null) ?? undefined;
      } catch {
        /* Storage is optional. */
      }
      if (cached?.key === key) return cached;
      const scores: number[] = [],
        bounds: number[] = [];
      let witness: EngineHit | undefined;
      for (const [index, scenario] of reference.cases.entries()) {
        active();
        const response = await this.engine!.run(rosterRequest(m, s, [scenario.song], 30_000));
        active();
        if (response.stopReason === "cancelled") throw new DOMException("Cancelled", "AbortError");
        const result = response.results[0],
          hit = result?.hits[0];
        if (!hit?.score || response.unknownCards.length) throw new Error("rating-score-unavailable");
        const score = hit.score.mean;
        scores.push(score / scenario.score);
        bounds.push((result.proven ? score : Math.max(score, result.bound ?? Infinity)) / scenario.score);
        witness ??= hit;
        progress(index + 1, reference.cases.length);
      }
      const mean = (values: number[]) =>
        (values.reduce((sum, value) => sum + value, 0) * 1000) / reference.cases.length;
      const lower = mean(scores),
        upper = mean(bounds);
      if (Math.round(lower * 10) !== Math.round(upper * 10)) throw new Error("rating-search-incomplete");
      const value: RosterResult = {
        value: Math.round(lower * 10) / 10,
        witness: witness!,
        referenceId: reference.id,
        dataId: data.identity.releaseId,
        key,
      };
      memory.set(key, value);
      try {
        const keys = Object.keys(localStorage).filter((key) => key.startsWith(CACHE_VERSION + "."));
        for (const old of keys.slice(0, Math.max(0, keys.length - 3))) localStorage.removeItem(old);
        localStorage.setItem(`${CACHE_VERSION}.${key}`, JSON.stringify(value));
      } catch {
        /* The in-memory result remains usable. */
      }
      return value;
    };
    const potential = await run(true);
    const current = incomplete ? null : await run(false);
    return { current, potential, incomplete };
  }
}
