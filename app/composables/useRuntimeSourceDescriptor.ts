import { resourceUrl, runtimeRootForServer } from "~/composables/useAssetServer";

export interface RuntimeSourceOutput {
  objectId: string | number;
  path: string;
  type: string;
}

export interface RuntimeSourceDescriptor {
  sourcePath?: string;
  outputs?: RuntimeSourceOutput[];
}

export const FIX_UI_SPRITE_ATLAS_SOURCE = "Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2";

export const runtimeOutputLogicalName = (output: RuntimeSourceOutput): string | null => {
  const filename = output.path.split("/").pop() || "";
  const extension = filename.match(/\.[^.]+$/)?.[0] || "";
  const suffix = `--${output.type}-${String(output.objectId)}${extension}`;
  if (!extension || !filename.endsWith(suffix)) return null;
  return `${filename.slice(0, -suffix.length)}${extension}`;
};

export const resolveRuntimeOutputUrl = (
  descriptor: RuntimeSourceDescriptor,
  server: string,
  logicalName: string,
  type: string,
): string => {
  const matches = (descriptor.outputs || []).filter(
    (output) => output.type === type && runtimeOutputLogicalName(output) === logicalName,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${type} output named ${logicalName} in ${descriptor.sourcePath || "source descriptor"}, found ${matches.length}`,
    );
  }
  const path = matches[0]?.path || "";
  if (!path.startsWith("runtime/")) {
    throw new Error(`Runtime output ${logicalName} has a non-canonical path: ${path || "<empty>"}`);
  }
  const canonicalUrl = `${runtimeRootForServer(server)}/${path.slice("runtime/".length)}`;
  return resourceUrl(canonicalUrl, server);
};

export const resolveRuntimeOutputUrlByType = (
  descriptor: RuntimeSourceDescriptor,
  server: string,
  type: string,
): string => {
  const matches = (descriptor.outputs || []).filter((output) => output.type === type);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${type} output in ${descriptor.sourcePath || "source descriptor"}, found ${matches.length}`,
    );
  }
  const path = matches[0]?.path || "";
  if (!path.startsWith("runtime/")) {
    throw new Error(`Runtime ${type} output has a non-canonical path: ${path || "<empty>"}`);
  }
  const canonicalUrl = `${runtimeRootForServer(server)}/${path.slice("runtime/".length)}`;
  return resourceUrl(canonicalUrl, server);
};

export const useRuntimeSourceDescriptor = (sourcePath: string) =>
  useCatalogDocument<RuntimeSourceDescriptor>(`sources/${sourcePath}`);
