/** Build-time coordination of T62 snapshots under the loader's existing pin. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { StaticCatalogRelease } from "../lib/static-catalog-source";
import { captureStaticBuildFile, staticBuildJson } from "./static-input-store";

const run = promisify(execFile);
const pending = new Map<string, Promise<string | undefined>>();
const MAX_BYTES = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, canonical(value) + "\n");
  await rename(temporary, file);
}

export function calendarGeneratedPublicRoot(): string {
  return path.resolve(process.env.CALENDAR_GENERATED_PUBLIC_ROOT || "data/calendar/generated-public");
}

/** Called once per server/pin in the same Astro process that chose current. */
export async function prepareCalendarLives(
  server: string,
  release: StaticCatalogRelease,
  value: unknown,
): Promise<string | undefined> {
  if (
    release.server !== server ||
    !/^[a-z0-9-]{1,40}$/u.test(server) ||
    !/^r-[a-f0-9]{20}$/u.test(release.releaseId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(release.sourceId)
  )
    throw new Error("Calendar build pin invalid");
  if (!object(value)) return undefined;
  const catalog = object(value.entries) ? { entries: value.entries } : { entries: value };
  const catalogBytes = canonical(catalog) + "\n";
  if (Buffer.byteLength(catalogBytes) > MAX_BYTES) throw new Error("Calendar input exceeds byte budget");
  const sha = createHash("sha256").update(catalogBytes).digest("hex");
  const month = process.env.CALENDAR_LIVES_MONTH;
  if (month && !/^\d{4}-\d{2}$/u.test(month)) throw new Error("Invalid calendar month override");
  const key = `${server}:${release.releaseId}:${release.sourceId}:${sha}:${month || "current-JST"}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const prepare = async () => {
    const root = path.resolve(process.env.CALENDAR_DATA_ROOT || "data/calendar");
    const directory = path.join(root, server, release.releaseId);
    const input = path.join(directory, "catalog-input.json");
    const output = path.join(directory, "calendar-lives.json");
    await atomicJson(input, { schema: "haneoka-calendar-catalog-input-v1", pin: release, realLives: catalog });
    const args = [
      "scripts/build/calendar_lives.py",
      "--server",
      server,
      "--release",
      release.releaseId,
      "--source",
      release.sourceId,
      "--catalog-input",
      input,
      "--output",
      output,
      "--cache-root",
      path.join(root, "bandori-fans"),
      "--asset-root",
      path.join(calendarGeneratedPublicRoot(), "images/calendar-lives"),
    ];
    if (month) args.push("--month", month);
    await run(process.env.CALENDAR_PYTHON || "python3", args, {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: path.resolve("scripts") },
      timeout: 180_000,
      maxBuffer: 32 * 1024,
    });
    const bytes = await readFile(output);
    if (bytes.byteLength > MAX_BYTES) throw new Error("Calendar snapshot exceeds byte budget");
    const doc: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !object(doc) ||
      doc.schema !== "haneoka-calendar-lives-v1" ||
      !object(doc.pin) ||
      doc.pin.server !== server ||
      doc.pin.releaseId !== release.releaseId ||
      doc.pin.sourceId !== release.sourceId ||
      doc.pin.realLivesSha256 !== sha
    )
      throw new Error("Calendar generated snapshot differs from selected current pin");
    // One index per server/pin; finalize copies only these declared mirrored images.
    const assetManifest = path.join(root, "asset-manifests", `${server}-${release.releaseId}.json`);
    await atomicJson(assetManifest, {
      schema: "haneoka-calendar-static-assets-v1",
      pin: release,
      assets: Array.isArray(doc.assets) ? doc.assets : [],
    });
    captureStaticBuildFile(output, "calendar");
    captureStaticBuildFile(assetManifest, "calendar");
    for (const asset of Array.isArray(doc.assets) ? doc.assets : []) {
      if (
        !object(asset) ||
        typeof asset.path !== "string" ||
        !/^images\/calendar-lives\/[a-f0-9]{64}\.png$/u.test(asset.path)
      )
        throw new Error("Invalid calendar mirrored image");
      captureStaticBuildFile(path.join(calendarGeneratedPublicRoot(), asset.path), "calendar");
    }
    return output;
  };
  const promise = staticBuildJson(`calendar:${key}`, "calendar", async () => {
    const file = await prepare();
    return path.relative(process.cwd(), file).split(path.sep).join("/");
  }).then((file) => {
    const output = path.resolve(file);
    captureStaticBuildFile(output, "calendar");
    captureStaticBuildFile(
      path.join(
        process.env.CALENDAR_DATA_ROOT || "data/calendar",
        "asset-manifests",
        `${server}-${release.releaseId}.json`,
      ),
      "calendar",
    );
    return output;
  });
  pending.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    pending.delete(key);
    throw error;
  }
}
