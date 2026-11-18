// L3 — GEB
// Input: Current run artifacts, sealed render parts and a fixed shard plan.
// Output: A bounded takeover opportunity or fixed artifact IDs for complete locale finalization.
// Pos: [Map](L2-2.md); render runner handoff and immutable checkpoints.
// Effects/Dependencies: Reads GitHub Actions metadata; moves local sealed parts and extracts selected render archives before the existing complete verifier.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    locale: { type: "string" },
    generation: { type: "string" },
    partition: { type: "string" },
  },
});
const mode = positionals[0];
assert.ok(["candidate", "select", "unpack"].includes(mode) && positionals.length === 1);
const locale = values.locale,
  generation = values.generation,
  own = values.partition;
assert.ok(["en", "ja", "ko", "zh-CN", "zh-TW"].includes(locale));
assert.match(generation || "", /^[a-f0-9]{64}$/u);
if (own !== undefined) assert.match(own, /^[0-3]$/u);
const runId = process.env.GITHUB_RUN_ID,
  repository = process.env.GITHUB_REPOSITORY;
assert.match(runId || "", /^[1-9][0-9]*$/u);
assert.match(repository || "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const output = (key, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const selectionFile = ".output/static-render-selection.json";
const planBody = fs.readFileSync(".output/static-shard-plan.json"),
  plan = JSON.parse(planBody);
const planSha256 = createHash("sha256").update(planBody).digest("hex");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(plan.schema, "haneoka-static-shard-plan-v1");
assert.equal(plan.generation.kind, "frozen-inputs");
assert.equal(plan.generation.sha256, generation);
assert.equal(plan.source.sha, sourceSha, "Render handoff source differs");
const finalName = `static-part-${generation}-${locale}`;
const claimName = `static-finalizer-claim-${generation}-${locale}`;

function checkedArtifact(artifacts, name, run) {
  const matches = artifacts.filter((artifact) => artifact.name === name);
  assert.ok(matches.length <= 1, `Duplicate immutable artifact: ${name}`);
  if (!matches.length) return null;
  const artifact = matches[0];
  assert.ok(!artifact.expired && artifact.size_in_bytes > 0, `Unavailable immutable artifact: ${name}`);
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.match(artifact.digest || "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(String(artifact.workflow_run?.id), runId);
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id, "Artifact repository differs");
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "Artifact run head differs");
  return { id: artifact.id, name, digest: artifact.digest };
}

async function state(deadline) {
  const get = async (route) => {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline === undefined ? 5000 : deadline - Date.now();
      assert.ok(remaining > 0, "Render artifact lookup time budget reached");
      try {
        const response = await fetch(
          `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}/${route}`,
          {
            headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(Math.min(5000, remaining)),
          },
        );
        assert.ok(response.ok, `Render artifact lookup returned HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (deadline !== undefined || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  };
  const run = await get(`actions/runs/${runId}`);
  assert.equal(String(run.id), runId);
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const expectedHead =
    process.env.GITHUB_EVENT_NAME === "pull_request" ? event.pull_request.head.sha : process.env.GITHUB_SHA;
  assert.equal(run.head_sha, expectedHead, "Workflow run head differs");
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = await get(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  return { run, artifacts };
}

if (mode === "unpack") {
  const selection = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
  assert.equal(selection.runId, runId);
  assert.equal(selection.sourceSha, sourceSha);
  assert.equal(selection.planSha256, planSha256);
  assert.equal(selection.generation, generation);
  assert.equal(selection.locale, locale);
  for (const artifact of selection.artifacts) {
    const destination = `.output/static-render-parts/${artifact.partition}`;
    if (own === String(artifact.partition) && fs.existsSync(path.join(destination, "render.json"))) continue;
    assert.ok(!fs.existsSync(destination), "Render part destination already exists");
    fs.mkdirSync(destination, { recursive: true });
    const archive = path.join(".output/static-render-archives", artifact.name, "static-render-part.tar.zst");
    execFileSync("tar", ["--zstd", "--extract", "--file", archive, "--directory", destination]);
    fs.unlinkSync(archive);
  }
} else {
  if (mode === "candidate") output("ready", "false");
  const deadline = mode === "candidate" ? Date.now() + 5000 : undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { run, artifacts } = await state(deadline);
      const completed = checkedArtifact(artifacts, finalName, run);
      if (completed) {
        output("complete", "true");
        console.log(JSON.stringify({ locale, complete: true, artifactId: completed.id }));
        break;
      }
      if (mode === "candidate" && artifacts.some((artifact) => artifact.name === claimName)) break;
      const parts = [0, 1, 2, 3].map((partition) => {
        const artifact = checkedArtifact(artifacts, `static-render-${generation}-${locale}-${partition}`, run);
        return artifact && { ...artifact, partition };
      });
      if (parts.every(Boolean)) {
        fs.writeFileSync(
          selectionFile,
          JSON.stringify({ runId, sourceSha, planSha256, generation, locale, artifacts: parts }),
        );
        output("complete", "false");
        if (mode === "candidate") {
          const claim = path.join(process.env.RUNNER_TEMP, `static-finalizer-${locale}-${own}.json`);
          fs.writeFileSync(claim, JSON.stringify({ runId, sourceSha, generation, locale, partition: own }));
          output("claim_file", claim);
          output("ready", "true");
        } else {
          let local = false;
          const sealed = ".output/static-render-part";
          if (own !== undefined && fs.existsSync(path.join(sealed, "render.json"))) {
            const destination = `.output/static-render-parts/${own}`;
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            assert.ok(!fs.existsSync(destination));
            fs.renameSync(sealed, destination);
            local = true;
          }
          fs.rmSync(".output/public", { recursive: true, force: true });
          fs.rmSync(".output/static-documents", { recursive: true, force: true });
          output(
            "download_ids",
            parts
              .filter((part) => !local || part.partition !== Number(own))
              .map((part) => part.id)
              .join(","),
          );
        }
        console.log(JSON.stringify({ locale, mode, renderArtifacts: parts.length }));
        break;
      }
      assert.ok(attempt < 2, "Complete render artifact set is unavailable");
      if (deadline === undefined || deadline - Date.now() > 250)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    if (mode !== "candidate") throw error;
    console.log(JSON.stringify({ locale, takeover: false, reason: error.message }));
  }
}
