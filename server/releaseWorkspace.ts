import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ReleaseWorkspace {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isReleasePointer(value: unknown, server: string): value is ReleasePointer {
  return (
    isRecord(value) &&
    value.schema === "haneoka-resource-pointer-v1" &&
    value.server === server &&
    typeof value.releaseId === "string" &&
    /^r-[a-f0-9]{20}$/.test(value.releaseId)
  );
}

function isReleaseManifestIdentity(
  value: unknown,
  server: string,
  releaseId: string,
): value is ReleaseManifestIdentity {
  return (
    isRecord(value) &&
    value.schema === "haneoka-resource-release-v1" &&
    value.server === server &&
    value.releaseId === releaseId
  );
}

export function normalizeServerId(value = "jp-cbt"): string {
  const server = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(server)) {
    throw new Error(`Invalid server id: ${value}`);
  }
  return server;
}

export function releaseWorkspace(
  server = "jp-cbt",
  root = PROJECT_ROOT,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<ReleaseWorkspace> {
  const id = normalizeServerId(server);
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
    if (!fs.existsSync(pointerFile)) {
      throw new Error(`No local release is selected: ${pointerFile}`);
    }

    const pointer = readJsonFile(pointerFile);
    if (!isReleasePointer(pointer, id)) {
      throw new Error(`Invalid local release pointer: ${pointerFile}`);
    }
    releaseId = pointer.releaseId;
    releaseRoot = path.join(serverRoot, "releases", releaseId);
  }

  const manifest = path.join(releaseRoot, "release.json");
  if (!buildRoot && !fs.existsSync(manifest)) {
    throw new Error(`Release manifest is missing: ${manifest}`);
  }
  if (!buildRoot) {
    const value = readJsonFile(manifest);
    if (!isReleaseManifestIdentity(value, id, releaseId)) {
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

export function localReleaseFile(workspace: ReleaseWorkspace, publicPath: string): string | null {
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
    if (prefix.startsWith("/assets/") && !["Assets", "Packages"].includes(relative[0] ?? "")) {
      return null;
    }

    const file = path.resolve(root, ...relative);
    if (file === root || !file.startsWith(root + path.sep)) return null;

    // Resolve each segment with an exact spelling check. APFS is commonly
    // case-insensitive, but Unity addresses and the release API are not.
    let current = root;
    try {
      for (const segment of relative) {
        if (!fs.statSync(current).isDirectory() || !fs.readdirSync(current).includes(segment)) {
          return null;
        }
        current = path.join(current, segment);
      }
      return fs.statSync(current).isFile() ? current : null;
    } catch {
      return null;
    }
  }
  return null;
}
