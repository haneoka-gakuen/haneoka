/** Build-time per-power score rates of every chart, from the team engine itself. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { teamSource } from "./tool-page-data";
import { compileFromTeamData } from "../lib/team-builder/engine/master";
import { dataRows } from "../lib/team-builder/data";
import type { ReleaseServer } from "../lib/release-server";
import { fetchStaticReleaseBytes, staticCatalogRelease } from "../lib/static-catalog-source";
import { staticBuildJson } from "./static-input-store";
import { SKILL_WINDOWS, type ChartRateTable } from "../lib/chart-rates";

const ENGINE = path.resolve("src/lib/team-builder/engine/generated/team-engine.wasm");

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
}
type Doc = Record<string, unknown>;

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

async function compute(server: ReleaseServer): Promise<ChartRateTable> {
  const release = await staticCatalogRelease(server);
  const data = await teamSource(server);
  const invoke = await engine();
  const handle = Number(invoke({ op: "create", data }).handle);
  const charts: ChartRateTable["charts"] = {};
  for (const song of Object.values(data.songs)) {
    const songId = Number(song.musicId);
    for (const level of dataRows(song.difficulty)) {
      const file = typeof level.file === "string" ? level.file : "";
      const prefix = `/assets/${server}/`;
      if (!file.startsWith(prefix)) continue;
      const ref = { songId, difficulty: Number(level.difficulty) };
      let bytes: Uint8Array = await fetchStaticReleaseBytes(`assets/${file.slice(prefix.length)}`, server, release);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      const chart = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
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
      charts[`${ref.songId}:${ref.difficulty}`] = {
        base: Number(live!.base.toPrecision(5)),
        windows: live!.windows.general.map(rounded),
        skip: Number(live!.skip.toPrecision(5)),
        notes: live!.notes,
        ranks: live!.ranks.map((row) => [row.rank, row.required, row.battleRequired]),
      };
    }
  }
  const percent = (judgement: number) =>
    Number(
      dataRows(data.liveTools.judgementParameters).find((row) => Number(row.noteSimulateJudgement) === judgement)
        ?.scorePercent,
    );
  const master = compileFromTeamData(data);
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
      staticBuildJson(`chart-rates-v6:${server}:${release.releaseId}:${build}`, "chart-rates", () => compute(server)),
    );
    pending.set(server, value);
  }
  return value;
}
