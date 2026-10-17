/** Copy only current-build calendar image manifests after Astro publicDir copying. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareCalendarStaticAssets(dataRoot = process.env.CALENDAR_DATA_ROOT || "data/calendar") {
  if (process.env.STATIC_BUILD_INPUT_MODE === "frozen") return;
  const directory = path.resolve(dataRoot, "asset-manifests");
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (/^[a-z0-9-]+-r-[a-f0-9]{20}\.json$/u.test(name)) await unlink(path.join(directory, name));
  }
}

export async function copyCalendarStaticAssets({
  dataRoot = process.env.CALENDAR_DATA_ROOT || "data/calendar",
  generatedPublicRoot = process.env.CALENDAR_GENERATED_PUBLIC_ROOT || "data/calendar/generated-public",
  outputRoot = ".output/public",
} = {}) {
  const directory = path.resolve(dataRoot, "asset-manifests");
  const declaredSourceRoot = path.resolve(generatedPublicRoot);
  const output = path.resolve(outputRoot);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  const assets = new Map();
  for (const name of names.filter((name) => /^[a-z0-9-]+-r-[a-f0-9]{20}\.json$/u.test(name))) {
    const bytes = await readFile(path.join(directory, name));
    if (bytes.length > 64 * 1024) throw new Error("Calendar mirror manifest exceeds bounds");
    const document = JSON.parse(bytes);
    if (
      document.schema !== "haneoka-calendar-static-assets-v1" ||
      !Array.isArray(document.assets) ||
      document.assets.length > 12
    )
      throw new Error("Invalid calendar mirror manifest");
    for (const asset of document.assets) {
      if (
        !/^images\/calendar-lives\/[a-f0-9]{64}\.png$/u.test(asset.path) ||
        !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
        path.basename(asset.path) !== `${asset.sha256}.png` ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 1 ||
        asset.bytes > 2 * 1024 * 1024
      )
        throw new Error("Invalid calendar mirrored image declaration");
      const previous = assets.get(asset.path);
      if (previous && (previous.sha256 !== asset.sha256 || previous.bytes !== asset.bytes))
        throw new Error("Conflicting calendar image declarations");
      assets.set(asset.path, asset);
    }
  }
  if (assets.size > 24) throw new Error("Calendar final image count exceeds build budget");
  const sourceRoot = assets.size ? await realpath(declaredSourceRoot) : declaredSourceRoot;
  for (const asset of assets.values()) {
    const source = await realpath(path.join(sourceRoot, asset.path));
    if (!source.startsWith(sourceRoot + path.sep)) throw new Error("Calendar image escapes generated root");
    const body = await readFile(source);
    if (body.length !== asset.bytes || createHash("sha256").update(body).digest("hex") !== asset.sha256)
      throw new Error("Calendar mirrored image bytes differ from manifest");
    const target = path.join(output, asset.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return assets.size;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--prepare"
)
  await prepareCalendarStaticAssets();
