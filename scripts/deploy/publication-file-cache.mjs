// L3 — GEB
// Input: Publication manifest bytes, source root and stable local file identities.
// Output: Body digests reused only within one explicitly enabled GitHub job and manifest.
// Pos: [Map](../L2.md); local publication digest receipts.
// Effects/Dependencies: Reads publication files; stores SHA and bigint stat metadata only under RUNNER_TEMP.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "haneoka-local-publication-file-cache-v1";
const STAT_FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"];
const digest = (body) => createHash("sha256").update(body).digest("hex");
const identityStat = (stat) => Object.fromEntries(STAT_FIELDS.map((key) => [key, stat[key].toString()]));
const sameStat = (left, right) => STAT_FIELDS.every((key) => left?.[key] === right?.[key]);

export function createPublicationFileCache({ root, env = process.env }) {
  root = path.resolve(root);
  let directory;
  const scope = { root, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB };
  if (
    env.HANEOKA_LOCAL_PUBLICATION_CACHE === "1" &&
    env.GITHUB_ACTIONS === "true" &&
    /^[1-9][0-9]*$/u.test(scope.runId || "") &&
    /^[1-9][0-9]*$/u.test(scope.runAttempt || "") &&
    scope.job &&
    path.isAbsolute(env.RUNNER_TEMP || "")
  ) {
    try {
      scope.realRoot = fs.realpathSync(root);
      directory = path.join(fs.realpathSync(env.RUNNER_TEMP), "haneoka-publication-file-cache");
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory()) throw new Error("Local cache directory is not a plain directory");
      fs.chmodSync(directory, 0o700);
    } catch {
      directory = undefined;
    }
  }
  const observed = new Map();
  let current;
  const counts = { hits: 0, hashedFiles: 0, hashedBytes: 0, seededFiles: 0 };

  function record(relative) {
    const file = path.join(root, relative);
    if (!directory) {
      const body = fs.readFileSync(file);
      counts.hashedFiles++;
      counts.hashedBytes += body.length;
      return { path: relative, bytes: body.length, sha256: digest(body) };
    }
    const expected = current?.records.get(relative),
      cached = current?.entries.get(relative);
    if (expected && cached) {
      const stat = identityStat(fs.statSync(file, { bigint: true }));
      if (sameStat(stat, cached.stat)) {
        counts.hits++;
        return { path: relative, bytes: cached.bytes, sha256: cached.sha256 };
      }
    }
    const descriptor = fs.openSync(file, "r");
    let value, stable;
    try {
      const before = identityStat(fs.fstatSync(descriptor, { bigint: true }));
      const body = fs.readFileSync(descriptor);
      value = { path: relative, bytes: body.length, sha256: digest(body) };
      const after = identityStat(fs.fstatSync(descriptor, { bigint: true }));
      const selected = identityStat(fs.statSync(file, { bigint: true }));
      if (sameStat(before, after) && sameStat(after, selected)) stable = after;
    } finally {
      fs.closeSync(descriptor);
    }
    counts.hashedFiles++;
    counts.hashedBytes += value.bytes;
    if (stable) {
      const entry = { ...value, stat: stable };
      observed.set(relative, entry);
      if (expected && expected.sha256 === value.sha256 && expected.bytes === value.bytes)
        current.entries.set(relative, entry);
      else current?.entries.delete(relative);
    } else {
      observed.delete(relative);
      current?.entries.delete(relative);
    }
    return value;
  }

  function bind(manifestBody, records, load = true) {
    if (!directory) return;
    const identity = { ...scope, manifestSha256: digest(manifestBody) };
    const file = path.join(directory, `${digest(JSON.stringify(identity))}.json`);
    current = { identity, file, records: new Map(records.map((record) => [record.path, record])), entries: new Map() };
    observed.clear();
    if (!load) return;
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return;
      const cached = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (cached.schema !== SCHEMA || JSON.stringify(cached.identity) !== JSON.stringify(identity)) return;
      for (const entry of cached.entries) {
        const expected = current.records.get(entry.path);
        if (
          expected &&
          entry.sha256 === expected.sha256 &&
          entry.bytes === expected.bytes &&
          entry.stat?.size === String(entry.bytes) &&
          STAT_FIELDS.every((key) => typeof entry.stat?.[key] === "string" && /^[0-9]+$/u.test(entry.stat[key]))
        )
          current.entries.set(entry.path, entry);
      }
    } catch {
      current.entries.clear();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function save() {
    if (!directory || !current) return;
    const temporary = `${current.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ schema: SCHEMA, identity: current.identity, entries: [...current.entries.values()] }),
        { flag: "wx", mode: 0o600 },
      );
      fs.renameSync(temporary, current.file);
    } catch {
      /* A missing receipt leaves the next command on its full digest path. */
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* Cache cleanup does not change file verification. */
      }
    }
  }

  function seal(manifestBody, records) {
    if (!directory) return;
    const prepared = new Map(observed);
    bind(manifestBody, records, false);
    for (const record of records) {
      const entry = prepared.get(record.path);
      if (entry?.sha256 === record.sha256 && entry.bytes === record.bytes) current.entries.set(record.path, entry);
    }
    counts.seededFiles += current.entries.size;
    save();
  }

  return { record, bind, save, seal, statistics: () => ({ enabled: !!directory, ...counts }) };
}
