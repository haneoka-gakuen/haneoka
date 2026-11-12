#!/usr/bin/env node
// L3 — GEB
// Input: sealed publication、source commit 与当前 main。
// Output: 来源资格、恢复 artifact 身份和发布上下文。
// Pos: [Map](../L2.md)；部署来源与后续提交的资格边界。
// Effects/Dependencies: 调用 Git／GitHub 只读 API；验证已部署源码、封存源码和 main 的单调祖先关系。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const workflowPath = ".github/workflows/deploy-cloudflare.yml";
const publicationTooling = new Set([
  workflowPath,
  "scripts/deploy/worker-publication.mjs",
  "scripts/deploy/publication-source.mjs",
]);
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const github = (route) => JSON.parse(execFileSync("gh", ["api", route], { encoding: "utf8" }));
const pages = (route, key) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", route], {
  encoding: "utf8",
})).flatMap((page) => page[key]);

function ignoredResourcePath(file) {
  return (file.startsWith("scripts/") && file.endsWith(".py") && file !== "scripts/build/icon_sprite.py") ||
    file === "scripts/requirements.txt" || /^\.github\/workflows\/resource-[^/]*\.yml$/u.test(file) ||
    file.startsWith(".github/actions/setup-resource-pipeline/") ||
    file === ".github/workflows/home-spot-repair.yml";
}

function ignoredNavigationPath(file) {
  if (file.startsWith("public/")) return false;
  return /(?:^|\/)(?:L1|L2|L2-2)\.md$/u.test(file) || file === "docs/geb-scope.json";
}

function ignoredSonolusPayloadPath(file) {
  return file.startsWith("packages/sonolus/scripts/") || file === ".dependencies/sonolus-our-notes";
}

export function sourceEligibility(root, sourceSha, mainSha, { allowPublicationTooling = false, activeWorkerSha = null } = {}) {
  if (![sourceSha, mainSha].every((sha) => /^[a-f0-9]{40}$/u.test(sha)))
    throw new Error("Publication source commit is invalid");
  try {
    git(root, "merge-base", "--is-ancestor", sourceSha, mainSha);
  } catch {
    throw new Error("Publication source is not an ancestor of main");
  }
  if (activeWorkerSha !== null) {
    if (!/^[a-f0-9]{40}$/u.test(activeWorkerSha)) throw new Error("Active Worker source commit is invalid");
    try { git(root, "merge-base", "--is-ancestor", activeWorkerSha, sourceSha); }
    catch { throw new Error("Publication would replace a newer or unrelated active Worker"); }
  }
  const commits = git(root, "rev-list", `${sourceSha}..${mainSha}`).split("\n").filter(Boolean);
  const ignoredPaths = new Set(), toolingPaths = new Set(), pendingPaths = new Set();
  for (const commit of commits) {
    const files = git(root, "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-m", commit)
      .split("\n").filter(Boolean);
    for (const file of files) {
      if (ignoredResourcePath(file) || ignoredNavigationPath(file) || ignoredSonolusPayloadPath(file)) ignoredPaths.add(file);
      else if (allowPublicationTooling && publicationTooling.has(file)) toolingPaths.add(file);
      else if (activeWorkerSha !== null) pendingPaths.add(file);
      else throw new Error(`Main has an unpublished deployment input: ${file}`);
    }
  }
  return {
    sourceSha, mainSha, subsequentCommitCount: commits.length,
    activeWorkerSha, ignoredPaths: [...ignoredPaths].sort(), publicationToolingPaths: [...toolingPaths].sort(),
    pendingDeploymentPaths: [...pendingPaths].sort(),
  };
}

export function resolveSealedPublication(repository, runId) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository || "") || !/^[1-9][0-9]*$/u.test(runId || ""))
    throw new Error("Select a repository and completed publication run");
  const run = github(`repos/${repository}/actions/runs/${runId}`);
  if (run.head_branch !== "main" || run.path !== workflowPath || run.status !== "completed" ||
      !["push", "workflow_dispatch"].includes(run.event) || !["success", "failure", "cancelled"].includes(run.conclusion) ||
      !/^[a-f0-9]{40}$/u.test(run.head_sha))
    throw new Error("Recovery requires a completed main deployment run");
  const jobs = pages(`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`, "jobs");
  if (!jobs.some((job) => job.name === "Build verified complete frontend / Verify and merge complete frontend" &&
      job.conclusion === "success"))
    throw new Error("The selected run has no verified complete frontend");
  const artifactName = `worker-publication-${run.head_sha}-${runId}`;
  const artifacts = pages(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, "artifacts")
    .filter((artifact) => artifact.name === artifactName && !artifact.expired);
  if (artifacts.length !== 1) throw new Error("The sealed publication artifact is unavailable");
  return { sourceSha: run.head_sha, runId, artifactName, artifactId: artifacts[0].id };
}

export function publicationSourceContext({ root, toolingRoot, sourceSha, activeWorkerSha, activeWorkerVersionId, identityMatchedVersionId }) {
  const repository = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) throw new Error("GitHub publication identity is missing");
  const recoveryRunId = process.env.HANEOKA_PUBLICATION_ARTIFACT_RUN_ID || "";
  const publisherSha = git(toolingRoot, "rev-parse", "HEAD");
  if (recoveryRunId) {
    const current = github(`repos/${repository}/actions/runs/${runId}`);
    if (current.path !== workflowPath || current.head_branch !== "main" || current.event !== "workflow_dispatch" ||
        current.status !== "in_progress" || current.head_sha !== publisherSha || process.env.GITHUB_SHA !== publisherSha)
      throw new Error("Recover a sealed publication from the current main workflow");
    assert.equal(resolveSealedPublication(repository, recoveryRunId).sourceSha, sourceSha,
      "Restored publication source differs from its original run");
  } else assert.equal(publisherSha, sourceSha, "Publication tooling differs from its source");
  const mainSha = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    cwd: root, encoding: "utf8",
  }).split(/\s/u)[0];
  try { git(root, "cat-file", "-e", `${mainSha}^{commit}`); }
  catch { git(root, "fetch", "--no-tags", "origin", mainSha); }
  try { git(root, "cat-file", "-e", `${activeWorkerSha}^{commit}`); }
  catch { git(root, "fetch", "--no-tags", "origin", activeWorkerSha); }
  return {
    ...sourceEligibility(root, sourceSha, mainSha, { allowPublicationTooling: Boolean(recoveryRunId), activeWorkerSha }),
    activeWorkerVersionId, identityMatchedVersionId, publisherSha, recoveredFromRunId: recoveryRunId || null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repository: { type: "string" }, "run-id": { type: "string" }, source: { type: "string" },
      head: { type: "string" }, "allow-publication-tooling": { type: "boolean" },
    },
  });
  if (positionals[0] === "resolve" && positionals.length === 1) {
    const result = resolveSealedPublication(values.repository || process.env.GITHUB_REPOSITORY, values["run-id"]);
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `source_sha=${result.sourceSha}\nartifact_name=${result.artifactName}\nartifact_run_id=${result.runId}\n`);
  } else if (positionals[0] === "eligible" && positionals.length === 1) {
    console.log(JSON.stringify(sourceEligibility(process.cwd(), values.source, values.head || git(process.cwd(), "rev-parse", "HEAD"), {
      allowPublicationTooling: values["allow-publication-tooling"],
    }), null, 2));
  } else throw new Error("Use resolve --run-id ID or eligible --source SHA [--head SHA]");
}
