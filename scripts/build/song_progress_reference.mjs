// Input: Explicit frozen TeamBuilderData JSON, pinned WASM and output path.
// Output: R1 per-case proven optimal reference scores and legal team witnesses.
// Pos: [Map](L2-2.md); offline song-progress benchmark publication.
// Effects/Dependencies: Fetches pinned published charts, runs local WASM, writes the explicitly selected JSON; never runs during requests or routine frontend builds.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const [dataPath, outputPath] = process.argv.slice(2);
if (!dataPath || !outputPath) throw new Error("Expected data JSON and output JSON paths");
const compiled = await build({
  stdin: {
    contents:
      'export { rosterRequest, fullGrowthMember, fullGrowthSnap } from "./src/lib/song-progress-rating.ts"; export { contentPublished } from "./src/lib/content-publication.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { rosterRequest, fullGrowthMember, fullGrowthSnap, contentPublished } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const data = JSON.parse(await readFile(dataPath, "utf8"));
const wasm = await readFile("src/lib/team-builder/engine/generated/team-engine.wasm");
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
let engine;
const read = (pointer) => {
  const bytes = new Uint8Array(engine.memory.buffer);
  let end = pointer;
  while (bytes[end]) end++;
  return decoder.decode(bytes.subarray(pointer, end));
};
const instance = await WebAssembly.instantiate(wasm, {
  env: { haneoka_now_ms: () => Date.now(), haneoka_progress: () => {} },
});
engine = instance.instance.exports;
function invoke(value) {
  const bytes = encoder.encode(JSON.stringify(value)),
    pointer = engine.haneoka_buffer_alloc(bytes.length + 1);
  const target = new Uint8Array(engine.memory.buffer, pointer, bytes.length + 1);
  target.set(bytes);
  target[bytes.length] = 0;
  let result = 0;
  try {
    result = engine.haneoka_context_json(pointer);
    const output = JSON.parse(read(result));
    if (output.error) throw new Error(output.error);
    return output;
  } finally {
    if (result) engine.haneoka_string_free(result);
    engine.haneoka_buffer_free(pointer, bytes.length + 1);
  }
}
const now = Date.now();
const members = Object.values(data.members)
  .filter((row) => contentPublished(row, now))
  .map((row) => fullGrowthMember(row.id));
const snaps = Object.values(data.snapshots)
  .filter((row) => contentPublished(row, now))
  .map((row) => fullGrowthSnap(row.id));
const groups = new Map();
for (const row of Object.values(data.songs).sort((a, b) => a.musicId - b.musicId)) {
  if (!contentPublished(row, now)) continue;
  const chart = row.difficulty.find((chart) => chart.difficulty === 3 && contentPublished(chart, now) && chart.file);
  if (!chart) continue;
  const key = JSON.stringify([row.bandId, row.musicType, row.bestMusicTagIds]);
  if (!groups.has(key))
    groups.set(key, { song: { songId: row.musicId, difficulty: chart.difficulty }, file: chart.file });
}
const handle = invoke({ op: "create", data, trustedScores: true }).handle;
const cases = [],
  charts = [],
  songs = {};
for (const { song, file } of groups.values()) {
  const url = new URL(file, "https://haneoka.org");
  url.searchParams.set("release", data.identity.releaseId);
  const headers = { "User-Agent": "Mozilla/5.0" };
  if (process.env.HANEOKA_CONTENT_BUILD_TOKEN)
    headers["x-haneoka-build-token"] = process.env.HANEOKA_CONTENT_BUILD_TOKEN;
  const response = await fetch(url, { headers });
  if (!response.ok || response.headers.get("x-haneoka-release-id") !== data.identity.releaseId)
    throw new Error(`Pinned chart unavailable:${song.songId}/${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 31 && bytes[1] === 139)
    bytes = new Uint8Array(
      await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
  const chart = JSON.parse(decoder.decode(bytes));
  charts.push({ song, chart });
  songs[String(song.songId)] = {
    ...data.songs[String(song.songId)],
    difficulty: data.songs[String(song.songId)].difficulty.filter((row) => row.difficulty === song.difficulty),
  };
  const started = Date.now();
  const result = invoke({
    op: "run",
    handle,
    request: rosterRequest(members, snaps, [song], 600_000),
    charts: [{ song, chart }],
  });
  const row = result.results?.[0],
    hit = row?.hits?.[0];
  if (!row?.proven || !(hit?.score?.mean > 0)) throw new Error(`Reference optimum unproven:${song.songId}`);
  cases.push({ song, score: hit.score.mean, members: hit.members, snaps: hit.snaps });
  process.stderr.write(
    JSON.stringify({ song, score: hit.score.mean, ms: Date.now() - started, cases: cases.length, total: groups.size }) +
      "\n",
  );
}
const reference = {
  schema: "haneoka-roster-rating-r1",
  server: data.identity.server,
  calculatedAt: new Date(now).toISOString(),
  identity: data.identity,
  engineRevision: createHash("sha256").update(wasm).digest("hex"),
  cases,
  charts,
  songs,
};
if (Buffer.byteLength(JSON.stringify(charts)) > 8 * 1024 * 1024)
  throw new Error("Reference charts exceed the shared cache budget");
reference.id = "r1-" + createHash("sha256").update(JSON.stringify(reference)).digest("hex").slice(0, 20);
await mkdir(new URL(".", new URL(outputPath, `file://${process.cwd()}/`)), { recursive: true });
await writeFile(outputPath, JSON.stringify(reference) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({ id: reference.id, cases: cases.length, members: members.length, snaps: snaps.length }) + "\n",
);
