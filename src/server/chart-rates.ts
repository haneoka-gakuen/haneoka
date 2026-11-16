// L3 — GEB
// Input: The pinned team source and public chart files.
// Output: Static chart rates and ordinary Live scoring timelines.
// Pos: [Map](L2-2.md); shared chart-rate artifact for song analysis and the team picker.
// Effects/Dependencies: Reuses fixed-release files and native WASM rates at build time.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { teamSource } from "./tool-page-data";
import { compileFromTeamData } from "../lib/team-builder/engine/master";
import { convertChartBytes, type ChartSource } from "../lib/team-builder/engine/chart";
import { chartGekisoRates as gekisouRates } from "../lib/team-builder/engine/gekiso";
export { gekisouRates };
import { dataRows } from "../lib/team-builder/data";
import type { ReleaseServer } from "../lib/release-server";
import { fetchStaticReleaseBytes, staticCatalogRelease } from "../lib/static-catalog-source";
import { staticBuildJson } from "./static-input-store";
import {
  CHART_RATE_SCHEMA, isPackedChartScoreTimelines, SKILL_WINDOWS, type ChartRateTable,
  type LegacyChartScoreTimeline, type PackedChartScoreTimelines,
} from "../lib/chart-rates";

const ENGINE = path.resolve("src/lib/team-builder/engine/generated/team-engine.wasm");
const LEGACY_SCHEMA = "haneoka-chart-rates-v10";

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
}
type Doc = Record<string, unknown>;
type PublishedRateFields = ChartRateTable & {
  sourceId: string;
  engineCommit: string;
};
type LegacyPublishedRates = PublishedRateFields & {
  schema: typeof LEGACY_SCHEMA;
  scoreTimelines: Record<string, LegacyChartScoreTimeline>;
};
type ReusableRates = PublishedRateFields & {
  schema: typeof CHART_RATE_SCHEMA;
  scoreTimelines: PackedChartScoreTimelines;
};

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
    const value = (await response.json()) as ReusableRates | LegacyPublishedRates;
    if (
      (value.schema !== CHART_RATE_SCHEMA && value.schema !== LEGACY_SCHEMA) ||
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
      expected.some((key) => value.charts[key]?.windows.length !== SKILL_WINDOWS.length)
    )
      return undefined;
    if (value.schema === LEGACY_SCHEMA) {
      const timelines: BuildScoreTimeline[] = [];
      for (const key of expected) {
        const timeline = value.scoreTimelines?.[key];
        if (!timeline || !Array.isArray(timeline.skillTimes)) return undefined;
        const bytes = Buffer.from(timeline.notes, "base64");
        if (bytes.length !== value.charts[key]!.notes * 4) return undefined;
        timelines.push({ key, skillTimes: timeline.skillTimes, notes: legacyTimelineNotes(bytes) });
      }
      console.log(`repacked verified chart rates ${server}: ${expected.length} charts`);
      return { ...value, schema: CHART_RATE_SCHEMA, scoreTimelines: packChartScoreTimelines(timelines) };
    }
    const packed = value.scoreTimelines;
    if (!packed || !isPackedChartScoreTimelines(packed) || packed.index.length !== expected.length) return undefined;
    const timelineKeys = new Set(packed.index.map(([key]) => key));
    if (expected.some((key) => !timelineKeys.has(key))) return undefined;
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

function writeTimelineInteger(bytes: number[], value: number) {
  if (value < 255) {
    bytes.push(value);
    return;
  }
  bytes.push(255);
  for (value -= 255; value >= 128; value = Math.floor(value / 128)) bytes.push((value % 128) | 128);
  bytes.push(value);
}

interface BuildScoreTimeline {
  key: string;
  skillTimes: number[];
  notes: Iterable<Pick<ChartSource["notes"][number], "timeMs" | "operateType" | "judgementType">>;
}

function* legacyTimelineNotes(bytes: Buffer) {
  let timeMs = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    timeMs += bytes.readUInt16LE(i);
    yield { timeMs, operateType: bytes[i + 2]!, judgementType: bytes[i + 3]! };
  }
}

function packChartScoreTimelines(timelines: readonly BuildScoreTimeline[]): PackedChartScoreTimelines {
  const noteTypes: PackedChartScoreTimelines["noteTypes"] = [];
  const noteTypeIds = new Map<string, number>();
  const index: PackedChartScoreTimelines["index"] = [];
  const buffers: Buffer[] = [];
  for (const { key, skillTimes, notes } of timelines) {
    const bytes: number[] = [];
    let previous = 0;
    for (const { timeMs, operateType, judgementType } of notes) {
      const delta = timeMs - previous;
      if (!Number.isSafeInteger(delta) || delta < 0) throw new Error("Invalid chart scoring timeline order for " + key);
      previous = timeMs;
      const typeKey = `${operateType}:${judgementType}`;
      let id = noteTypeIds.get(typeKey);
      if (id === undefined) {
        id = noteTypes.length;
        noteTypeIds.set(typeKey, id);
        noteTypes.push([operateType, judgementType]);
      }
      writeTimelineInteger(bytes, delta);
      writeTimelineInteger(bytes, id);
    }
    index.push([key, bytes.length, skillTimes]);
    buffers.push(Buffer.from(bytes));
  }
  return { format: "gzip-delta-v1", noteTypes, index, data: gzipSync(Buffer.concat(buffers), { level: 9 }).toString("base64") };
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
  const timelines: BuildScoreTimeline[] = new Array(inputs.length);
  let cursor = 0;
  const load = async () => {
    while (cursor < inputs.length) {
      const index = cursor++;
      const { ref, file } = inputs[index]!;
      let bytes: Uint8Array = await fetchStaticReleaseBytes(file, server, release);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      const chart = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      const source = await convertChartBytes(bytes);
      const song = master.songs.get(ref.songId);
      const level = song?.difficulties.find((row) => row.difficulty === ref.difficulty)?.playLevel;
      const gekisou =
        song && level !== undefined
          ? gekisouRates(master, source, level, song.gekisoMissions)
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
      const notes = source.notes.filter((note) => note.judged);
      if (notes.length !== live!.notes)
        throw new Error("Chart scoring timeline note count differs for " + ref.songId + ":" + ref.difficulty);
      timelines[index] = { key: `${ref.songId}:${ref.difficulty}`, notes, skillTimes: source.skillTimesMs.slice(0, 5) };
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
    schema: CHART_RATE_SCHEMA,
    sourceId: release.sourceId,
    engineCommit,
    releaseId: release.releaseId,
    greatFactor: percent(4) / percent(5),
    boosts: master.boosts.map((row) => [row.consumed, row.eventPointRate, row.rewardRate]),
    events,
    charts,
    scoreTimelines: packChartScoreTimelines(timelines),
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
        `${CHART_RATE_SCHEMA}:${server}:${release.releaseId}:${build}`,
        "chart-rates",
        async () => (await publishedRates(server, build)) || compute(server, build),
      ),
    );
    pending.set(server, value);
  }
  return value;
}
