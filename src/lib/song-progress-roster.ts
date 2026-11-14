// Input: Own Box snapshot, frozen R1 benchmark and the current published catalogue.
// Output: Locally certified current/potential roster ratings and a legal witness team.
// Pos: [Map](L2-2.md); lazy song-progress calculation adapter.
// Effects/Dependencies: Shares the team builder's Rust/WASM pool, batches independent cases, resumes partial proofs and caches compact reports; no account queries or polling.
import { EngineClient } from "./team-builder/engine/client";
import {
  fetchCurrentTeamBuilderIdentity,
  fetchTeamBuilderData,
  type CurrentTeamBuilderIdentity,
} from "./team-builder/data/fetch";
import { readBox, engineInputs } from "./team-builder/sync/box-view";
import type { BoxSnapshot } from "./team-builder/sync/box-store";
import { contentPublished } from "./content-publication";
import { rosterRequest, type RosterReference } from "./song-progress-rating";
import type { TeamBuilderData } from "./team-builder/data";
import type { EngineHit, SongResult } from "./team-builder/engine/api";
import { compileFromTeamData, type EngineMaster } from "./team-builder/engine/master";
import { maxMemberGrowth, maxSnapGrowth, memberGrowth, snapGrowth } from "./team-builder/engine/box";
import engineUrl from "./team-builder/engine/generated/team-engine.wasm?url";
import intlReferenceUrl from "../config/roster-rating-r1-intl.json?url";
import jpReferenceUrl from "../config/roster-rating-r1-jp.json?url";

export interface RosterCard {
  id: number;
  name: unknown;
  image: string;
}
export interface RosterResult {
  value: number;
  witness: EngineHit;
  team: (RosterCard | null)[];
  referenceId: string;
  dataId: string;
  key: string;
}
export interface RosterRatings {
  current: RosterResult | null;
  potential: RosterResult | null;
  incomplete: boolean;
  pending?: boolean;
}
type Inputs = Pick<ReturnType<typeof rosterRequest>, "members" | "snaps">;
type CacheEntry = { key: string; result: RosterResult | null; incomplete: boolean };
type Work = { input: Inputs; aliases: string[]; parts: (SongResult | undefined)[] };
const CACHE_VERSION = "haneoka.roster-rating.r1.v2";
const memory = new Map<string, CacheEntry>();
function readCache(key: string): CacheEntry | undefined {
  let entry = memory.get(key);
  try {
    entry ??= JSON.parse(localStorage.getItem(`${CACHE_VERSION}.${key}`) || "null") ?? undefined;
  } catch {
    /* Optional cache. */
  }
  return entry?.key === key ? entry : undefined;
}
function writeCache(entry: CacheEntry) {
  memory.delete(entry.key);
  memory.set(entry.key, entry);
  while (memory.size > 8) memory.delete(memory.keys().next().value!);
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(CACHE_VERSION + "."));
    for (const key of keys.slice(0, Math.max(0, keys.length - 7))) localStorage.removeItem(key);
    localStorage.setItem(`${CACHE_VERSION}.${entry.key}`, JSON.stringify(entry));
  } catch {
    /* The memory cache remains available. */
  }
}
async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class SongProgressRoster {
  private engine?: EngineClient;
  private data?: TeamBuilderData;
  private master?: EngineMaster;
  private reference?: RosterReference;
  private identity?: Promise<CurrentTeamBuilderIdentity>;
  private loading?: Promise<void>;
  private lifetime = new AbortController();
  private generation = 0;
  private partials = new Map<string, (SongResult | undefined)[]>();
  private source(server: string) {
    return (this.identity ??= fetchCurrentTeamBuilderIdentity(server, this.lifetime.signal).catch((error) => {
      this.identity = undefined;
      throw error;
    }));
  }
  private load(server: string, identity: CurrentTeamBuilderIdentity, referenceUrl: string): Promise<void> {
    return (this.loading ??= (async () => {
      const [data, response] = await Promise.all([
        fetchTeamBuilderData(server, this.lifetime.signal, fetch, identity),
        fetch(referenceUrl, { signal: this.lifetime.signal }),
      ]);
      if (!response.ok) throw new Error("rating-reference-unavailable");
      const reference = (await response.json()) as RosterReference;
      this.lifetime.signal.throwIfAborted();
      data.songs = { ...data.songs, ...reference.songs };
      this.master = compileFromTeamData(data);
      this.engine = new EngineClient(data, undefined, { charts: reference.charts });
      this.data = data;
      this.reference = reference;
    })().catch((error) => {
      this.loading = undefined;
      throw error;
    }));
  }
  cancel() {
    ++this.generation;
    this.engine?.cancel();
  }
  dispose() {
    this.cancel();
    this.lifetime.abort();
    this.engine?.dispose();
    this.partials.clear();
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
    const input = engineInputs(readBox(snapshot.entries), true);
    input.members.sort((a, b) => a.cardId - b.cardId);
    input.snaps.sort((a, b) => a.cardId - b.cardId);
    const currentInput = { ...input, members: input.members.map((row) => ({ ...row, gekisoSkillLevel: null })) };
    const identity = await this.source(server);
    active();
    const referenceUrl = server === "jp" ? jpReferenceUrl : intlReferenceUrl;
    const versions = [referenceUrl, identity.releaseId, engineUrl];
    const [currentKey, potentialKey] = await Promise.all([
      fingerprint([versions, currentInput]),
      fingerprint([versions, input.members.map((row) => row.cardId), input.snaps.map((row) => row.cardId)]),
    ]);
    active();
    let currentCache = readCache(currentKey),
      potentialCache = readCache(potentialKey);
    if (potentialCache?.result && (currentCache?.result || currentCache?.incomplete))
      return {
        current: currentCache?.result ?? null,
        potential: potentialCache.result,
        incomplete: currentCache?.incomplete ?? false,
      };
    await this.load(server, identity, referenceUrl);
    active();
    const data = this.data!,
      master = this.master!,
      reference = this.reference!;
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
    if (incomplete) writeCache({ key: currentKey, result: null, incomplete: true });
    const potentialInput: Inputs = {
      members: members.map((row) => ({
        ...row,
        ...maxMemberGrowth(master, master.members.get(row.cardId)!),
        gekisoSkillLevel: null,
      })),
      snaps: snaps.map((row) => ({ ...row, ...maxSnapGrowth(master, master.snaps.get(row.cardId)!) })),
    };
    const resolvedCurrent: Inputs | null = incomplete
      ? null
      : {
          members: members.map((row) => ({
            ...row,
            ...memberGrowth(master, master.members.get(row.cardId)!, row, "max"),
            gekisoSkillLevel: null,
          })),
          snaps: snaps.map((row) => ({ ...row, ...snapGrowth(master, master.snaps.get(row.cardId)!, row, "max") })),
        };
    const grownCache = potentialCache?.result ?? currentCache?.result;
    if (grownCache && resolvedCurrent && JSON.stringify(resolvedCurrent) === JSON.stringify(potentialInput)) {
      const current = { ...grownCache, key: currentKey },
        potential = { ...grownCache, key: potentialKey };
      writeCache({ key: currentKey, result: current, incomplete: false });
      writeCache({ key: potentialKey, result: potential, incomplete: false });
      return { current, potential, incomplete: false };
    }
    const groups = new Map<string, Work>();
    const add = (key: string, input: Inputs) => {
      const signature = JSON.stringify(input);
      const same = groups.get(signature);
      if (same) {
        same.aliases.push(key);
        return;
      }
      let parts = this.partials.get(key);
      if (!parts) {
        parts = [];
        this.partials.set(key, parts);
      }
      groups.set(signature, { input, aliases: [key], parts });
    };
    if (!potentialCache?.result) add(potentialKey, potentialInput);
    if (resolvedCurrent && !currentCache?.result) add(currentKey, resolvedCurrent);
    const jobs = [...groups.values()].flatMap((work) =>
      reference.cases.flatMap((scenario, index) =>
        work.parts[index]?.proven
          ? []
          : [
              {
                work,
                index,
                request: {
                  ...rosterRequest(work.input.members, work.input.snaps, [scenario.song]),
                  completed: work.parts[index] ? [work.parts[index]!] : undefined,
                  seeds: work.parts[index]?.hits,
                },
              },
            ],
      ),
    );
    let completed = 0;
    if (jobs.length) progress(0, jobs.length);
    await this.engine!.runBatch(
      jobs.map((job) => job.request),
      (index, response) => {
        active();
        const job = jobs[index]!,
          result = response.results[0];
        if (!response.unknownCards.length && result?.hits[0]?.score) job.work.parts[job.index] = result;
        progress(++completed, jobs.length);
      },
    );
    active();
    for (const work of groups.values()) {
      const rows = work.parts;
      if (reference.cases.some((_, index) => !rows[index]?.hits[0]?.score)) continue;
      const scores = reference.cases.map((scenario, index) => rows[index]!.hits[0]!.score!.mean / scenario.score);
      const bounds = reference.cases.map((scenario, index) => {
        const row = rows[index]!,
          score = row.hits[0]!.score!.mean;
        return (row.proven ? score : Math.max(score, row.bound ?? Infinity)) / scenario.score;
      });
      const mean = (values: number[]) =>
        (values.reduce((sum, value) => sum + value, 0) * 1000) / reference.cases.length;
      const lower = mean(scores),
        upper = mean(bounds);
      if (Math.round(lower * 10) !== Math.round(upper * 10)) continue;
      const witness = rows[0]!.hits[0]!;
      const team = [
        ...witness.members.map((key) => data.members[key.slice(1)]!),
        ...witness.snaps.map((key) => (key ? data.snapshots[key.slice(1)] : undefined)),
      ].map((row) => (row ? { id: Number(row.id), name: row.name, image: String(row.image || "") } : null));
      for (const key of work.aliases)
        writeCache({
          key,
          incomplete: false,
          result: {
            value: Math.round(lower * 10) / 10,
            witness,
            team,
            referenceId: reference.id,
            dataId: identity.releaseId,
            key,
          },
        });
      for (const key of work.aliases) this.partials.delete(key);
    }
    while (this.partials.size > 4) this.partials.delete(this.partials.keys().next().value!);
    currentCache = readCache(currentKey);
    potentialCache = readCache(potentialKey);
    const current = currentCache?.result ?? null,
      potential = potentialCache?.result ?? null;
    return { current, potential, incomplete, pending: !potential || (!incomplete && !current) };
  }
}
