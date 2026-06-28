import fs from "node:fs";
import path from "node:path";

export interface SonolusReleaseWorkspace {
  readonly id: string;
  readonly releaseId: string;
  readonly serverRoot: string;
  readonly releaseRoot: string;
  readonly assetsRoot: string;
  readonly runtimeRoot: string;
  readonly objectsRoot: string;
  readonly masterRoot: string;
  readonly apiRoot: string;
  readonly metadataRoot: string;
}

interface ReleasePointer {
  readonly schema: "haneoka-resource-pointer-v1";
  readonly server: string;
  readonly releaseId: string;
}

interface ReleaseManifestIdentity {
  readonly schema: "haneoka-resource-release-v1";
  readonly server: string;
  readonly releaseId: string;
}

type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

const isReleasePointer = (value: unknown, server: string): value is ReleasePointer =>
  isRecord(value) &&
  value.schema === "haneoka-resource-pointer-v1" &&
  value.server === server &&
  typeof value.releaseId === "string" &&
  /^r-[a-f0-9]{20}$/u.test(value.releaseId);

const isReleaseManifestIdentity = (
  value: unknown,
  server: string,
  releaseId: string,
): value is ReleaseManifestIdentity =>
  isRecord(value) &&
  value.schema === "haneoka-resource-release-v1" &&
  value.server === server &&
  value.releaseId === releaseId;

export const normalizeReleaseServerId = (value = "jp-cbt"): string => {
  const server = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server)) throw new Error(`Invalid server id: ${value}`);
  return server;
};

/**
 * Resolve a local immutable release without depending on the host repository's
 * data pipeline modules. Independent hosts may bypass pointers entirely with
 * RESOURCE_RELEASE_ROOT or RESOURCE_BUILD_ROOT.
 */
export function resolveSonolusReleaseWorkspace(
  server = "jp-cbt",
  root = process.cwd(),
  env: ReleaseEnvironment = process.env,
): Readonly<SonolusReleaseWorkspace> {
  const id = normalizeReleaseServerId(server);
  const serverRoot = path.join(root, "data", "servers", id);
  const buildRoot = env.RESOURCE_BUILD_ROOT ? path.resolve(env.RESOURCE_BUILD_ROOT) : null;
  const explicitReleaseRoot = env.RESOURCE_RELEASE_ROOT;
  let releaseRoot: string;
  let releaseId: string;

  if (buildRoot) {
    releaseRoot = buildRoot;
    releaseId = path.basename(buildRoot);
  } else if (explicitReleaseRoot) {
    releaseRoot = path.resolve(explicitReleaseRoot);
    releaseId = path.basename(releaseRoot);
  } else {
    const pointerFile = path.join(serverRoot, "current.json");
    if (!fs.existsSync(pointerFile)) throw new Error(`No local release is selected: ${pointerFile}`);
    const pointer = readJsonFile(pointerFile);
    if (!isReleasePointer(pointer, id)) throw new Error(`Invalid local release pointer: ${pointerFile}`);
    releaseId = pointer.releaseId;
    releaseRoot = path.join(serverRoot, "releases", releaseId);
  }

  const manifest = path.join(releaseRoot, "release.json");
  if (!buildRoot) {
    if (!fs.existsSync(manifest)) throw new Error(`Release manifest is missing: ${manifest}`);
    if (!isReleaseManifestIdentity(readJsonFile(manifest), id, releaseId)) {
      throw new Error(`Release manifest identity does not match ${releaseId}: ${manifest}`);
    }
  }

  return Object.freeze({
    id,
    releaseId,
    serverRoot,
    releaseRoot,
    assetsRoot: path.join(releaseRoot, "assets"),
    runtimeRoot: path.join(releaseRoot, "runtime"),
    objectsRoot: path.join(releaseRoot, "objects"),
    masterRoot: buildRoot ? path.join(releaseRoot, "master") : path.join(releaseRoot, "objects", "master"),
    apiRoot: path.join(releaseRoot, "api", "v1", "catalog"),
    metadataRoot: path.join(releaseRoot, "metadata"),
  });
}

export function resolveLocalReleaseFile(workspace: SonolusReleaseWorkspace, publicPath: string): string | null {
  const pathname = new URL(publicPath, "https://local.invalid").pathname;
  const encodedServer = encodeURIComponent(workspace.id);
  const roots: ReadonlyArray<readonly [prefix: string, root: string]> = [
    [`/assets/${encodedServer}/`, workspace.assetsRoot],
    [`/runtime/${encodedServer}/`, workspace.runtimeRoot],
    [`/objects/${encodedServer}/`, workspace.objectsRoot],
  ];

  for (const [prefix, root] of roots) {
    if (!pathname.startsWith(prefix)) continue;
    let relative: string[];
    try {
      relative = pathname.slice(prefix.length).split("/").map(decodeURIComponent);
    } catch {
      return null;
    }
    if (prefix.startsWith("/assets/") && !["Assets", "Packages"].includes(relative[0] ?? "")) return null;

    const file = path.resolve(root, ...relative);
    if (file === root || !file.startsWith(root + path.sep)) return null;

    let current = root;
    try {
      for (const segment of relative) {
        if (!fs.statSync(current).isDirectory() || !fs.readdirSync(current).includes(segment)) return null;
        current = path.join(current, segment);
      }
      return fs.statSync(current).isFile() ? current : null;
    } catch {
      return null;
    }
  }
  return null;
}
