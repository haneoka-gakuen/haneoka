/** Build-time per-power score rates of every chart, from the team engine itself. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { teamSource } from "./tool-page-data";
import { compileFromTeamData, type EngineMaster } from "../lib/team-builder/engine/master";
import { convertChartBytes } from "../lib/team-builder/engine/chart";
import { gekisoChart, gekisoContext, scoreOrdersGekiso } from "../lib/team-builder/engine/gekiso";
import { ORDERS } from "../lib/team-builder/engine/order-equivalence";
import { missionPattern, rankingFactors } from "../lib/team-builder/engine/full/gekisou";
import type { SlotSkill } from "../lib/team-builder/engine/skills";
import { dataRows } from "../lib/team-builder/data";
import type { ReleaseServer } from "../lib/release-server";
import { fetchStaticReleaseBytes, staticCatalogRelease } from "../lib/static-catalog-source";
import { staticBuildJson } from "./static-input-store";
import { SKILL_WINDOWS, type ChartRateTable, type GekisouRates } from "../lib/chart-rates";

const ENGINE = path.resolve("src/lib/team-builder/engine/generated/team-engine.wasm");

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
}
type Doc = Record<string, unknown>;
type ReusableRates = ChartRateTable & { schema: "haneoka-chart-rates-v7"; sourceId: string; engineCommit: string };

async function publishedRates(server: ReleaseServer, engineCommit: string): Promise<ReusableRates | undefined> {
  const release = await staticCatalogRelease(server);
  try {
    const origin = process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
    const response = await fetch(new URL(`/data/chart-rates/${server}.json`, origin), {
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: "application/json",
        ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
      },
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as ReusableRates;
    if (
      value.schema !== "haneoka-chart-rates-v7" ||
      value.releaseId !== release.releaseId ||
      value.sourceId !== release.sourceId ||
      value.engineCommit !== engineCommit
    )
      return undefined;
    const data = await teamSource(server);
    const expected = Object.values(data.songs).flatMap((song) =>
      dataRows(song.difficulty)
        .filter((level) => typeof level.file === "string" && level.file.startsWith(`/assets/${server}/`))
        .map((level) => `${Number(song.musicId)}:${Number(level.difficulty)}`),
    );
    if (
      Object.keys(value.charts).length !== expected.length ||
      expected.some((key) => !value.charts[key] || value.charts[key].windows.length !== SKILL_WINDOWS.length)
    )
      return undefined;
    console.log(`reused verified chart rates ${server}: ${expected.length} charts`);
    return value;
  } catch {
    return undefined;
  }
}

async function engine() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(ENGINE), {
    env: { haneoka_now_ms: () => performance.timeOrigin + performance.now(), haneoka_progress: () => {} },
  });
  const e = instance.exports as unknown as Exports;
  return (input: Doc): Doc => {
    const bytes = encoder.encode(JSON.stringify(input));
    const pointer = e.haneoka_buffer_alloc(bytes.length + 1);
    const target = new Uint8Array(e.memory.buffer, pointer, bytes.length + 1);
    target.set(bytes);
    target[bytes.length] = 0;
    const result = e.haneoka_context_json(pointer);
    try {
      const memory = new Uint8Array(e.memory.buffer);
      let end = result;
      while (memory[end]) end++;
      const output = JSON.parse(decoder.decode(memory.subarray(result, end))) as Doc;
      if (typeof output.error === "string") throw new Error(output.error);
      return output;
    } finally {
      e.haneoka_string_free(result);
      e.haneoka_buffer_free(pointer, bytes.length + 1);
    }
  };
}

const rounded = (values: number[]) => values.map((value) => Number(value.toPrecision(5)));

const PROBE_POWER = 1_000_003;
const BLANK = {
  liveSkill: null,
  supportSkills: [],
  bandId: 0,
  characterId: 0,
  cardType: 0,
  tagIds: [],
  liveSkillCategories: [],
  gekisouSkillCategories: [],
  gekisouMissionType: 0,
  gekisouSkill: null,
  gekisouSupportSkills: [],
};
const PLAIN: SlotSkill = {
  effects: [{ type: 2000, delta: 100_000, seconds: 5, gate: { kind: "always" }, judgements: [] }],
  extensionMs: 0,
  recovery: 0,
  convert: null,
};

/** A Gekisou live's per-power score split by range, before rank bonuses, so any ranks, Just share and skills combine
 * linearly: one run without skills, and one with a +100 % five-second skill in slot 0, whose 120 orders put it on
 * each skill event. */
export function gekisouRates(master: EngineMaster, source: Parameters<typeof gekisoChart>[1], level: number, missions: readonly number[]): GekisouRates | undefined {
  if (source.feverMs.length < 3 || missions.length < 3 || missions.some((mission) => !mission)) return undefined;
  const deck = Array(5).fill(BLANK);
  const runs = [0, 1].map((just) => {
    const chart = gekisoChart(master, source, level, missions, { great: 0, just }, 1);
    const context = gekisoContext(master, chart, deck, []);
    const parts = (slots: SlotSkill[]) => {
      const out = ORDERS.map(() => [0, 0, 0, 0]);
      scoreOrdersGekiso(master, chart, context, PROBE_POWER, slots, (order, note, score) => {
        out[order]![chart.rangeOf[note]! + 1]! += score;
      });
      return out;
    };
    const base = parts([])[0]!;
    const skilled = parts([PLAIN]);
    const events = [0, 1, 2, 3, 4].map((event) => {
      const order = ORDERS.findIndex((row) => row[event] === 0);
      return skilled[order]!.map((value, part) => (value - base[part]!) / PROBE_POWER);
    });
    const ranges = [0, 1, 2];
    return {
      base: base.map((value) => value / PROBE_POWER),
      events,
      notes: ranges.map((range) => chart.rangeOf.filter((value) => value === range).length),
      just: ranges.map((range) => chart.rangeOf.filter((value, note) => value === range && context.judgement[note] === 6).length),
    };
  });
  return {
    missions: missions.slice(0, 3),
    percents: rankingFactors(master.live.gekiso, missionPattern(missions[0]!, missions[1]!, missions[2]!)),
    base: [rounded(runs[0]!.base), rounded(runs[1]!.base)],
    events: [runs[0]!.events.map(rounded), runs[1]!.events.map(rounded)],
    notes: runs[1]!.notes,
    just: runs[1]!.just,
  };
}

async function compute(server: ReleaseServer, engineCommit: string): Promise<ReusableRates> {
  const release = await staticCatalogRelease(server);
  const data = await teamSource(server);
  const invoke = await engine();
  const handle = Number(invoke({ op: "create", data }).handle);
  const master = compileFromTeamData(data);
  const inputs: Array<{ ref: { songId: number; difficulty: number }; file: string }> = [];
  for (const song of Object.values(data.songs)) {
    const songId = Number(song.musicId);
    for (const level of dataRows(song.difficulty)) {
      const file = typeof level.file === "string" ? level.file : "";
      const prefix = `/assets/${server}/`;
      if (!file.startsWith(prefix)) continue;
      inputs.push({
        ref: { songId, difficulty: Number(level.difficulty) },
        file: `assets/${file.slice(prefix.length)}`,
      });
    }
  }
  const rows: Array<readonly [string, ChartRateTable["charts"][string]]> = new Array(inputs.length);
  let cursor = 0;
  const load = async () => {
    while (cursor < inputs.length) {
      const index = cursor++;
      const { ref, file } = inputs[index]!;
      let bytes: Uint8Array = await fetchStaticReleaseBytes(file, server, release);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      const chart = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      const song = master.songs.get(ref.songId);
      const level = song?.difficulties.find((row) => row.difficulty === ref.difficulty)?.playLevel;
      const gekisou =
        song && level !== undefined
          ? gekisouRates(master, await convertChartBytes(bytes), level, song.gekisoMissions)
          : undefined;
      type Row = {
        base: number;
        weights: number[];
        ranks: { rank: number; required: number; battleRequired: number }[];
        skip: number;
        notes: number;
        windows: { general: number[][] };
      };
      const [live] = invoke({
        op: "rates",
        handle,
        request: { goal: { mode: "live", songs: [ref], windows: SKILL_WINDOWS } },
        charts: [{ song: ref, chart }],
      }).songs as Row[];
      rows[index] = [
        `${ref.songId}:${ref.difficulty}`,
        {
          base: Number(live!.base.toPrecision(5)),
          windows: live!.windows.general.map(rounded),
          skip: Number(live!.skip.toPrecision(5)),
          notes: live!.notes,
          ranks: live!.ranks.map((row) => [row.rank, row.required, row.battleRequired]),
          ...(gekisou ? { gekisou } : {}),
        },
      ];
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, load));
  const charts: ChartRateTable["charts"] = Object.fromEntries(rows);
  const percent = (judgement: number) =>
    Number(
      dataRows(data.liveTools.judgementParameters).find((row) => Number(row.noteSimulateJudgement) === judgement)
        ?.scorePercent,
    );
  const events = [...master.events.values()]
    .filter((event) => event.livePoints.size)
    .map((event) => {
      return {
        id: event.id,
        title: data.events[String(event.id)]?.title ?? null,
        startAt: event.startAt,
        endAt: event.endAt,
        points: [...event.livePoints].sort((a, b) => a[0] - b[0]),
        items: event.liveRewards
          .filter((reward) => !event.itemId || reward.resourceId === event.itemId)
          .map((reward): [number, number, number] => [reward.scoreRank, reward.count, reward.probability]),
      };
    });
  return {
    schema: "haneoka-chart-rates-v7",
    sourceId: release.sourceId,
    engineCommit,
    releaseId: release.releaseId,
    greatFactor: percent(4) / percent(5),
    boosts: master.boosts.map((row) => [row.consumed, row.eventPointRate, row.rewardRate]),
    events,
    charts,
  };
}

const pending = new Map<string, Promise<ChartRateTable>>();
export function chartRates(server: ReleaseServer): Promise<ChartRateTable> {
  let value = pending.get(server);
  if (!value) {
    const build = execFileSync("git", ["-C", ".dependencies/ournotes-team-builder", "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    value = staticCatalogRelease(server).then((release) =>
      staticBuildJson(
        `chart-rates-v7:${server}:${release.releaseId}:${build}`,
        "chart-rates",
        async () => (await publishedRates(server, build)) || compute(server, build),
      ),
    );
    pending.set(server, value);
  }
  return value;
}
