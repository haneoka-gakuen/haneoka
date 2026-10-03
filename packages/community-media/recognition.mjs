import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL("./recognition/", import.meta.url));
const KERNEL_FILE =
  process.env.RECOGNITION_KERNEL_FILE ||
  fileURLToPath(new URL("../../scripts/recognize/card_inventory.py", import.meta.url));
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ACTIVE = new Set(["receiving", "queued", "processing"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const JOB_TTL_MS = 10 * 60 * 1000;

export async function createRecognitionService({
  root,
  enqueue,
  canEnqueue,
  clock = Date.now,
  commandTimeoutMs = 120_000,
}) {
  commandTimeoutMs =
    Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs >= 100 ? Math.min(120_000, commandTimeoutMs) : 120_000;
  root = resolve(root);
  const jobRoot = join(root, "jobs"),
    referenceRoot = join(root, "references"),
    featureRoot = join(root, "features");
  // A container restart has no job identity continuity; all user input/results are discarded.
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  await mkdir(referenceRoot, { recursive: true, mode: 0o700 });
  await mkdir(featureRoot, { recursive: true, mode: 0o700 });
  const jobs = new Map(),
    references = new Map(),
    installations = new Set();
  for (const entry of await readdir(referenceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !HASH.test(entry.name)) {
      await rm(join(referenceRoot, entry.name), { recursive: true, force: true });
      continue;
    }
    try {
      const installed = JSON.parse(await readFile(join(referenceRoot, entry.name, ".installed.json"), "utf8"));
      references.set(entry.name, {
        ...installed,
        directory: join(referenceRoot, entry.name),
        touched: clock(),
        users: 0,
      });
    } catch {
      await rm(join(referenceRoot, entry.name), { recursive: true, force: true });
    }
  }
  let shuttingDown = false,
    sweepRunning = false;
  const timer = setInterval(() => {
    void sweep().catch(() => {});
  }, 30_000);
  timer.unref();

  const sourceFeatureKey = (context) =>
    createHash("sha256").update(`${context.server}:${context.sourceId}`).digest("hex");
  const featureDirectory = (context) => join(featureRoot, sourceFeatureKey(context));
  const matchContext = (a, b) => ["server", "releaseId", "sourceId"].every((k) => a[k] === b[k]);
  const publicJob = (job) => ({
    job: {
      id: job.id,
      state: job.state === "receiving" ? "queued" : job.state,
      progress: job.state === "ready" ? 1 : job.state === "processing" ? 0.25 : 0,
      expiresAt: job.expiresAt,
      context: { ...job.context, referenceId: job.referenceId },
      ...(job.state === "ready" && job.result ? { result: job.result } : {}),
      ...(job.state === "failed" && job.error ? { error: job.error } : {}),
    },
  });

  async function route(request, response, segments) {
    if (segments[0] !== "recognition") return false;
    const owner = String(request.headers["x-recognition-owner"] || "");
    const context = {
      server: String(request.headers["x-recognition-server"] || ""),
      releaseId: String(request.headers["x-recognition-release"] || ""),
      sourceId: String(request.headers["x-recognition-source"] || ""),
    };
    if (!HASH.test(owner) || !Object.values(context).every((v) => PIN.test(v))) {
      sendError(response, 400, "invalid_context", "Invalid recognition context");
      return true;
    }
    if (segments.length === 3 && segments[1] === "references" && HASH.test(segments[2])) {
      const id = segments[2],
        reference = references.get(id);
      if (request.method === "GET") {
        if (!reference || !matchContext(context, reference.context))
          sendError(response, 404, "reference_missing", "Reference not cached");
        else {
          reference.touched = clock();
          sendJson(response, 200, { referenceId: id });
        }
      } else if (request.method === "PUT") {
        if (reference) {
          request.resume();
          if (!matchContext(context, reference.context))
            sendError(response, 409, "reference_changed", "Reference context changed");
          else sendJson(response, 200, { referenceId: id });
        } else await installReference(request, response, id, context);
      } else sendError(response, 405, "method_not_allowed", "Method not allowed");
      return true;
    }
    if (segments.length !== 3 || segments[1] !== "jobs" || !UUID.test(segments[2])) {
      sendError(response, 404, "not_found", "Recognition endpoint not found");
      return true;
    }
    const id = segments[2];
    let job = jobs.get(id);
    if (job && job.expiresAt <= clock()) {
      await removeJob(job);
      job = undefined;
    }
    if (job?.controller.signal.aborted) {
      sendError(response, 404, "job_not_found", "Recognition job not found");
      return true;
    }
    if (job && (job.owner !== owner || !matchContext(job.context, context))) {
      sendError(response, 404, "job_not_found", "Recognition job not found");
      return true;
    }
    if (request.method === "POST") await createJob(request, response, id, owner, context, job);
    else if (!job) sendError(response, 404, "job_not_found", "Recognition job not found");
    else if (request.method === "GET") sendJson(response, 200, publicJob(job));
    else if (request.method === "DELETE") {
      await removeJob(job);
      response.writeHead(204, { "cache-control": "private, no-store" }).end();
    } else sendError(response, 405, "method_not_allowed", "Method not allowed");
    return true;
  }

  async function installReference(request, response, id, context) {
    if (shuttingDown || installations.has(id) || installations.size >= 1) {
      sendError(response, 503, "reference_busy", "Reference preparation is busy");
      return;
    }
    installations.add(id);
    let temp;
    try {
      await evictReferences(context);
      if (references.size >= 2) throw failure("reference_busy");
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw failure("reference_busy");
      temp = await mkdtemp(join(referenceRoot, "install-"));
      const archive = join(temp, "bundle.zip"),
        directory = join(temp, "verified");
      const controller = new AbortController(),
        deadline = setTimeout(() => controller.abort(), 60_000);
      try {
        await receive(request, archive, MAX_REFERENCE_BYTES, id, controller.signal);
      } finally {
        clearTimeout(deadline);
      }
      const output = await python(
        "reference_bundle.py",
        ["--archive", archive, "--directory", directory, "--reference-id", id],
        undefined,
        30_000,
      );
      const info = JSON.parse(output);
      if (!matchContext(info.context, context)) throw failure("reference_changed");
      if ([...references.values()].reduce((n, v) => n + v.bytes, 0) + info.bytes > 256 * 1024 * 1024)
        throw failure("reference_budget");
      const destination = join(referenceRoot, id);
      await rename(directory, destination);
      references.set(id, { ...info, directory: destination, touched: clock(), users: 0 });
      await pruneFeatureSources();
      sendJson(response, 201, { referenceId: id });
    } catch (error) {
      sendError(
        response,
        error.code === "reference_busy" ? 503 : 422,
        error.code || "reference_invalid",
        "Reference preparation failed",
      );
    } finally {
      installations.delete(id);
      if (temp) await rm(temp, { recursive: true, force: true });
      await pruneFeatureSources();
    }
  }

  async function createJob(request, response, id, owner, context, existing) {
    const referenceId = String(request.headers["x-recognition-reference"] || ""),
      imageSha = String(request.headers["x-image-sha256"] || "");
    const mime = String(request.headers["content-type"] || "").split(";")[0];
    const kind = request.headers["x-recognition-kind"];
    let crop = null;
    try {
      const header = request.headers["x-recognition-crop"];
      if (header) {
        if (typeof header !== "string" || header.length > 200) throw failure("invalid_crop");
        const parsed = JSON.parse(header);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 4 ||
          !["x", "y", "width", "height"].every(
            (key) => Number.isSafeInteger(parsed[key]) && parsed[key] >= 0 && parsed[key] <= 4096,
          ) ||
          parsed.width < 16 ||
          parsed.height < 16
        )
          throw failure("invalid_crop");
        crop = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
      }
      if (kind && (!crop || !["members", "snapshots"].includes(kind))) throw failure("invalid_crop");
    } catch {
      sendError(response, 422, "invalid_crop", "Choose a valid screenshot crop");
      return;
    }

    if (!HASH.test(referenceId) || !HASH.test(imageSha) || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
      sendError(response, 415, "unsupported_screenshot", "Use a static screenshot");
      return;
    }
    if (existing) {
      request.resume();
      if (
        existing.imageSha !== imageSha ||
        existing.referenceId !== referenceId ||
        existing.mime !== mime ||
        JSON.stringify(existing.crop) !== JSON.stringify(crop) ||
        existing.kind !== kind
      )
        sendError(response, 409, "idempotency_conflict", "Job identity already used for another input");
      else sendJson(response, 202, publicJob(existing));
      return;
    }
    const reference = references.get(referenceId);
    if (!reference || !matchContext(context, reference.context)) {
      sendError(response, 409, "reference_missing", "Reference is unavailable");
      return;
    }
    const active = [...jobs.values()].filter((j) => ACTIVE.has(j.state));
    if (shuttingDown || active.length >= 4 || active.filter((j) => j.owner === owner).length >= 2 || !canEnqueue()) {
      sendError(response, 503, "recognition_busy", "Recognition is busy");
      return;
    }
    for (const old of jobs.values()) {
      if (jobs.size < 32) break;
      if (!ACTIVE.has(old.state)) await removeJob(old);
    }
    const controller = new AbortController();
    const job = {
      id,
      owner,
      context,
      referenceId,
      imageSha,
      mime,
      crop,
      kind,
      state: "receiving",
      expiresAt: clock() + JOB_TTL_MS,
      controller,
      workDir: join(jobRoot, id),
      reference,
    };
    job.execute = () => execute(job);
    jobs.set(id, job);
    reference.users++;
    reference.touched = clock();
    const deadline = setTimeout(() => controller.abort(), 60_000);
    try {
      await mkdir(job.workDir, { mode: 0o700 });
      const path = join(job.workDir, "screenshot.bin");
      await receive(request, path, MAX_IMAGE_BYTES, imageSha, controller.signal);
      const image = JSON.parse(
        await python("image_probe.py", ["--image", path, "--mime", mime], controller.signal, 10_000),
      );
      if (crop && (crop.x + crop.width > image.width || crop.y + crop.height > image.height))
        throw failure("invalid_crop");
      controller.signal.throwIfAborted();
      job.imagePath = path;
      job.state = "queued";
      enqueue(job);
      sendJson(response, 202, publicJob(job));
    } catch (error) {
      await removeJob(job);
      sendError(response, 422, error.code || "invalid_screenshot", "Screenshot upload failed");
    } finally {
      clearTimeout(deadline);
    }
  }

  async function execute(job) {
    if (job.controller.signal.aborted || jobs.get(job.id) !== job) return;
    job.state = "processing";
    let terminalState = "failed";
    try {
      const requestPath = join(job.workDir, "request.json"),
        outputPath = join(job.workDir, "result.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        requestPath,
        JSON.stringify({
          schema: "haneoka-card-recognition-request-v1",
          identity: job.context,
          images: [
            {
              id: job.id,
              path: "screenshot.bin",
              sha256: job.imageSha,
              ...(job.crop ? { crop: job.crop } : {}),
              ...(job.kind ? { kind: job.kind } : {}),
            },
          ],
        }),
      );
      await python(
        KERNEL_FILE,
        [
          "--request",
          requestPath,
          "--job-root",
          job.workDir,
          "--reference-index",
          join(job.reference.directory, "index.json"),
          "--reference-root",
          job.reference.directory,
          "--cache-root",
          featureDirectory(job.context),
          "--output",
          outputPath,
        ],
        job.controller.signal,
        commandTimeoutMs,
      );
      job.controller.signal.throwIfAborted();
      if ((await stat(outputPath)).size > MAX_RESULT_BYTES) throw failure("result_budget");
      const result = JSON.parse(await readFile(outputPath, "utf8"));
      const manifest = JSON.parse(await readFile(join(job.reference.directory, "index.json"), "utf8"));
      await trimFeatures(featureDirectory(job.context));
      job.result = validateResult(result, job, manifest);
      terminalState = "ready";
    } catch (error) {
      if (!job.controller.signal.aborted) {
        job.error = { code: error.code || "recognition_failed", message: "Screenshot recognition failed" };
      }
    } finally {
      await rm(job.workDir, { recursive: true, force: true });
      if (job.reference) await trimFeatures(featureDirectory(job.context)).catch(() => {});
      releaseReference(job);
      if (!job.controller.signal.aborted && jobs.get(job.id) === job) job.state = terminalState;
    }
  }
  function releaseReference(job) {
    if (job.reference) {
      job.reference.users--;
      job.reference.touched = clock();
      job.reference = undefined;
    }
  }
  async function removeJob(job) {
    job.controller.abort();
    job.state = "cancelled";
    if (job.completion) await job.completion;
    await rm(job.workDir, { recursive: true, force: true });
    releaseReference(job);
    job.result = undefined;
    if (jobs.get(job.id) === job) jobs.delete(job.id);
  }
  async function evictReferences() {
    const cold = [...references.entries()].filter(([, r]) => !r.users).sort((a, b) => a[1].touched - b[1].touched);
    for (const [id, reference] of cold) {
      if (references.size < 2 && clock() - reference.touched < 60 * 60 * 1000) break;
      await rm(reference.directory, { recursive: true, force: true });
      references.delete(id);
    }
  }
  async function pruneFeatureSources() {
    const keep = new Set([...references.values()].map((r) => sourceFeatureKey(r.context)));
    for (const name of await readdir(featureRoot))
      if (!keep.has(name)) await rm(join(featureRoot, name), { recursive: true, force: true });
  }
  async function sweep() {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      for (const job of jobs.values()) if (job.expiresAt <= clock()) await removeJob(job);
    } finally {
      sweepRunning = false;
    }
  }
  async function close() {
    shuttingDown = true;
    clearInterval(timer);
    await Promise.all([...jobs.values()].map(removeJob));
  }
  return { route, close, sweep };
}

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}
async function receive(request, path, limit, expectedHash, signal) {
  const hash = createHash("sha256");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _, callback) {
      bytes += chunk.length;
      if (bytes > limit) callback(failure("upload_budget"));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  await pipeline(request, counter, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
  if (!bytes || hash.digest("hex") !== expectedHash) throw failure("input_checksum");
}
async function python(script, args, signal, timeout) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "prlimit",
      [
        "--as=1610612736",
        `--cpu=${Math.ceil(timeout / 1000) + 5}`,
        "--",
        "python3",
        script.startsWith("/") ? script : join(SCRIPT_DIR, script),
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
      },
    );
    let output = "",
      settled = false,
      expired = false,
      killTimer;
    const terminate = () => {
      expired = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const timer = setTimeout(terminate, timeout);
    timer.unref();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
      error ? rejectPromise(error) : resolvePromise(output);
    };
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-4096);
    });
    child.stderr.resume();
    child.once("error", () => finish(failure("kernel_unavailable")));
    child.once("close", (code) =>
      finish(
        code === 0 && !expired && !signal?.aborted
          ? undefined
          : failure(expired ? "recognition_timeout" : "kernel_failed"),
      ),
    );
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
  });
}
function validateResult(result, job, manifest) {
  if (
    result.schema !== "haneoka-card-recognition-result-v1" ||
    !["server", "releaseId", "sourceId"].every((key) => result.identity?.[key] === job.context[key])
  )
    throw failure("result_identity");
  const image = result.images?.[0],
    width = image?.size?.[0],
    height = image?.size?.[1];
  if (
    result.images?.length !== 1 ||
    image?.id !== job.id ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 128 ||
    height < 128 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 8_000_000 ||
    image.sha256 !== job.imageSha
  )
    throw failure("result_image");
  if (!Array.isArray(result.observations) || result.observations.length > 100) throw failure("result_budget");
  const keys = new Set(manifest.references.map((card) => `${card.kind}:${card.cardId}`));
  const variants = new Set(
    manifest.references.map((card) => `${card.kind}:${card.cardId}:${card.variant || "thumbnail"}`),
  );
  const hiddenFields = () =>
    Object.fromEntries(
      ["training", "awakening", "liveSkillLevel", "gekisoSkillLevel"].map((key) => [
        key,
        { value: null, status: "unknown" },
      ]),
    );
  const observations = result.observations.map((row, index) => {
    const box = row.bbox;
    if (
      row.imageId !== job.id ||
      !["members", "snapshots"].includes(row.kind) ||
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      box[2] < 1 ||
      box[3] < 1 ||
      box[0] + box[2] > width ||
      box[1] + box[3] > height
    )
      throw failure("result_bbox");
    if (!Array.isArray(row.candidates) || row.candidates.length > 5) throw failure("result_candidates");
    const candidates = row.candidates.map((card) => {
      if (
        !keys.has(`${row.kind}:${card.cardId}`) ||
        !variants.has(`${row.kind}:${card.cardId}:${card.variant}`) ||
        !Number.isFinite(card.score)
      )
        throw failure("result_card");
      const evidence = {};
      for (const key of ["inliers", "coverage", "alignedSimilarity", "medianReprojectionError"])
        if (Number.isFinite(card[key])) evidence[key] = card[key];
      return { cardId: card.cardId, variant: card.variant, score: card.score, ...evidence };
    });
    if (row.cardId !== null && !candidates.some((card) => card.cardId === row.cardId)) throw failure("result_card");
    const level = row.fields?.level?.value;
    if (
      level !== null &&
      (!Number.isSafeInteger(level) || !manifest.levelReader?.allowedLevels?.[row.kind]?.includes(level))
    )
      throw failure("result_level");
    return {
      id: `${job.id}:${index + 1}`,
      imageId: job.id,
      bbox: box,
      kind: row.kind,
      cardId: row.cardId,
      status: row.cardId === null ? "needs_confirmation" : "recognized",
      candidates,
      fields: {
        ...hiddenFields(),
        level: {
          value: level,
          status: level === null ? "unknown" : "recognized",
          reason: String(row.fields?.level?.reason || "unknown")
            .replace(/[^A-Za-z0-9_.-]/g, "")
            .slice(0, 100),
        },
      },
    };
  });
  // Derive unique entities from validated observations; unsupported practice never comes from model output.
  const grouped = new Map();
  for (const row of observations) {
    if (row.cardId === null) continue;
    const key = `${row.kind}:${row.cardId}`;
    const entity = grouped.get(key) || {
      key: { server: job.context.server, kind: row.kind, cardId: row.cardId },
      observationIds: [],
      levels: new Set(),
      fields: hiddenFields(),
    };
    entity.observationIds.push(row.id);
    if (row.fields.level.value !== null) entity.levels.add(row.fields.level.value);
    grouped.set(key, entity);
  }
  const entities = [...grouped.values()].map(({ levels, ...row }) => {
    const candidates = [...levels].sort((a, b) => a - b);
    return {
      ...row,
      fields: {
        ...row.fields,
        level: {
          value: candidates.length === 1 ? candidates[0] : null,
          status: candidates.length === 1 ? "recognized" : candidates.length > 1 ? "conflict" : "unknown",
          candidates,
        },
      },
    };
  });
  return {
    schema: result.schema,
    identity: job.context,
    referenceId: job.referenceId,
    images: [
      {
        id: job.id,
        sha256: job.imageSha,
        size: [width, height],
        observationIds: observations.map((row) => row.id),
        status: observations.length ? "processed" : "needs_crop",
        coordinateSpace: "exif_normalized_original",
      },
    ],
    observations,
    entities,
    warnings: observations.length ? [] : [{ imageId: job.id, code: "no_reliable_grid" }],
    engine: {
      algorithm: String(result.engine?.algorithm || "")
        .replace(/[^A-Za-z0-9_.-]/g, "")
        .slice(0, 100),
      scoreMeaning: "geometric evidence/similarity, not probability",
    },
    stats: { observations: observations.length, uniqueEntities: entities.length, inventoryWrites: 0 },
  };
}

async function trimFeatures(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !/^[0-9a-f]{64}\.npz$/.test(entry.name)) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const info = await stat(path);
    files.push({ path, size: info.size, mtime: info.mtimeMs });
  }
  let bytes = files.reduce((n, f) => n + f.size, 0);
  for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
    if (bytes <= 128 * 1024 * 1024) break;
    await rm(file.path, { force: true });
    bytes -= file.size;
  }
}
