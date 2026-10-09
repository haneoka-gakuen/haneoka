/** Bounded, isolated synthetic benchmark. No inventory/account access and no production search limits. */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const source = option("--source", "current");
const name = option("--case", "gekiso-small");
const budget = Number(option("--budget-ms", "5000"));
if (!Number.isFinite(budget) || budget < 100 || budget > 120000)
  throw new Error("Benchmark budget must be 100..120000 ms");
const root = path.resolve(source === "current" ? "." : source);
const directory = path.resolve(".local-dev/performance");
await mkdir(directory, { recursive: true });
const label = source === "current" ? "current" : "baseline";
const stem = `${label}-${name}-${budget}`;
const outfile = path.join(directory, `${stem}.mjs`);
const imported = (file) => JSON.stringify(path.join(root, file).replaceAll("\\", "/"));
const fixtures = JSON.stringify(path.resolve("tests/team-builder/performance-fixtures.ts").replaceAll("\\", "/"));
const code = `
import { fixture } from ${imported("tests/team-builder/pt-recommendation.test.ts")};
import { ChartCache, runEngine } from ${imported("src/lib/team-builder/engine/api.ts")};
import { performanceFixture } from ${fixtures};
const { master, request, charts, config } = performanceFixture(fixture(), ${JSON.stringify(name)});
request.timeLimitMs = ${budget};
const initial = process.memoryUsage();
const began = performance.now();
let firstExactMs = null, exactCandidates = 0, largestObservedHeap = initial.heapUsed;
globalThis.__benchmarkExact = () => {
  firstExactMs ??= performance.now() - began;
  exactCandidates++;
  if (exactCandidates % 16 === 1) {
    largestObservedHeap = Math.max(largestObservedHeap, process.memoryUsage().heapUsed);
    console.log(JSON.stringify({ progress: true, firstExactMs, exactCandidates, elapsedMs: performance.now() - began,
      largestObservedHeapBytes: largestObservedHeap, maximumResidentBytes: process.resourceUsage().maxRSS * 1024 }));
  }
};
const result = await runEngine(master, new ChartCache(master, async (_, ref) => charts(ref)), request);
const elapsedMs = performance.now() - began;
largestObservedHeap = Math.max(largestObservedHeap, process.memoryUsage().heapUsed);
const report = {
  source: ${JSON.stringify(label)}, case: ${JSON.stringify(name)}, budgetMs: ${budget}, config,
  elapsedMs, firstExactMs, exactCandidates,
  heapStartBytes: initial.heapUsed, largestObservedHeapBytes: largestObservedHeap,
  maximumResidentBytes: process.resourceUsage().maxRSS * 1024,
  proven: result.results.length === config.songs && result.results.every((r) => r.proven),
  songs: result.results.map((r) => ({ song: r.song, proven: r.proven, bound: r.bound, stats: r.stats,
    key: r.hits[0]?.key ?? null, mean: r.hits[0]?.event?.mean ?? null, observations: r.hits[0]?.event?.orders ?? null,
    members: r.hits[0]?.members ?? null, snaps: r.hits[0]?.snaps ?? null })),
};
console.log(JSON.stringify(report));
`;
const bundled = await build({
  stdin: { contents: code, resolveDir: process.cwd(), sourcefile: `benchmark-${stem}.ts`, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
  metafile: true,
  plugins: [
    {
      name: "observe-completed-gekiso-candidates",
      setup(builder) {
        builder.onLoad({ filter: /gekiso-reward-objective\.ts$/ }, async ({ path: file }) => {
          let contents = await readFile(file, "utf8");
          const marker = "key: settlement.mean,";
          if (!contents.includes(marker))
            throw new Error("Benchmark exact telemetry marker moved: review instrumentation before comparing");
          contents = contents.replace(marker, "key: (globalThis.__benchmarkExact?.(), settlement.mean),");
          return { contents, loader: "ts", resolveDir: path.dirname(file) };
        });
      },
    },
  ],
});
const sourceHash = createHash("sha256");
for (const file of Object.keys(bundled.metafile.inputs)
  .filter((file) => !file.startsWith("benchmark-"))
  .sort()) {
  sourceHash.update(file);
  sourceHash.update(await readFile(file));
}
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--max-old-space-size=256", outfile], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    timedOut = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, budget + 15000);
  child.on("error", reject);
  child.on("close", (code) => {
    clearTimeout(timer);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (timedOut)
      resolve({
        ...(lines.length ? JSON.parse(lines.at(-1)) : {}),
        case: name,
        source: label,
        budgetMs: budget,
        proven: false,
        hardTimeout: true,
      });
    else if (code !== 0) reject(new Error(stderr || `benchmark exited ${code}`));
    else resolve(JSON.parse(lines.at(-1)));
  });
});
result.sourceHash = sourceHash.digest("hex");
result.bundleHash = createHash("sha256")
  .update(await readFile(outfile))
  .digest("hex");
result.nodeVersion = process.version;
result.instrumentation =
  "Gekisou firstExactMs includes seed search; exactCandidates counts completed Gekisou exact calls only. Search stats are returned by the actual engine. Heap is sampled; maxRSS is process-wide.";
await writeFile(path.join(directory, `${stem}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
