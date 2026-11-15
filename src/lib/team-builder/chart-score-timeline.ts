// L3 — GEB
// Input: The pinned chart-rate table or one chart timeline from it.
// Output: Scoring times, weights and judgment types for ordinary Live recommendation.
// Pos: [Map](L2-2.md); the static payload decoder for the song picker.
// Effects/Dependencies: Inflates the table's inline timeline once per table. No network.

import { isPackedChartScoreTimelines, type ChartRateTable, type LegacyChartScoreTimeline, type PackedChartScoreTimelines } from "../chart-rates";

export type ChartScoreTimeline = LegacyChartScoreTimeline | {
  skillTimes: number[];
  bytes: Uint8Array;
  noteTypes: PackedChartScoreTimelines["noteTypes"];
};

async function unpackTimelines(timelines: NonNullable<ChartRateTable["scoreTimelines"]>) {
  if (!isPackedChartScoreTimelines(timelines)) {
    return new Map<string, ChartScoreTimeline>(Object.entries(timelines));
  }
  const encoded = atob(timelines.data);
  const compressed = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) compressed[i] = encoded.charCodeAt(i);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const entries = new Map<string, ChartScoreTimeline>();
  let offset = 0;
  for (const [key, length, skillTimes] of timelines.index) {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length || entries.has(key))
      throw new Error("Invalid chart timeline index");
    entries.set(key, { skillTimes, bytes: bytes.subarray(offset, offset + length), noteTypes: timelines.noteTypes });
    offset += length;
  }
  if (offset !== bytes.length) throw new Error("Invalid chart timeline length");
  return entries;
}

const unpacked = new WeakMap<ChartRateTable, Promise<ReadonlyMap<string, ChartScoreTimeline>>>();
export async function loadChartScoreTimelines(table: ChartRateTable) {
  if (!table.scoreTimelines) return new Map<string, ChartScoreTimeline>();
  let pending = unpacked.get(table);
  if (!pending) {
    pending = unpackTimelines(table.scoreTimelines);
    unpacked.set(table, pending);
  }
  return pending;
}

export function decodeChartScoreNotes(
  timeline: ChartScoreTimeline,
  noteCount: number,
  notePercents: ReadonlyMap<number, number>,
) {
  const times = new Int32Array(noteCount);
  const kinds = new Uint8Array(noteCount);
  const fractions = new Float32Array(noteCount);
  let totalPercent = 0;
  let time = 0;
  if ("bytes" in timeline) {
    const { bytes, noteTypes } = timeline;
    let offset = 0;
    const readInteger = () => {
      const marker = bytes[offset++];
      if (marker === undefined) throw new Error("Incomplete chart scoring timeline");
      if (marker < 255) return marker;
      let value = 255;
      let scale = 1;
      for (;;) {
        const byte = bytes[offset++];
        if (byte === undefined || scale >= 2 ** 49) throw new Error("Invalid chart scoring timeline note");
        value += (byte & 127) * scale;
        if (byte < 128) return value;
        scale *= 128;
      }
    };
    for (let i = 0; i < noteCount; i++) {
      time += readInteger();
      const type = noteTypes[readInteger()];
      if (!type) throw new Error("Invalid chart scoring timeline note type");
      const percent = notePercents.get(type[0]) ?? 0;
      times[i] = time;
      fractions[i] = percent / 100;
      totalPercent += percent;
      kinds[i] = type[1];
    }
    if (offset !== bytes.length) throw new Error("Chart scoring timeline note count mismatch");
  } else {
    const bytes = atob(timeline.notes);
    if (bytes.length !== noteCount * 4) throw new Error("Chart scoring timeline note count mismatch");
    for (let i = 0; i < noteCount; i++) {
      const offset = i * 4;
      time += bytes.charCodeAt(offset) + 256 * bytes.charCodeAt(offset + 1);
      const percent = notePercents.get(bytes.charCodeAt(offset + 2)) ?? 0;
      times[i] = time;
      fractions[i] = percent / 100;
      totalPercent += percent;
      kinds[i] = bytes.charCodeAt(offset + 3);
    }
  }
  return { times, kinds, fractions, totalPercent };
}
