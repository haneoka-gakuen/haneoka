import type { CubismEmbedOptions } from "./haneoka.js";

export interface HostedManifest {
  schemaVersion: number;
  release: string;
  modules: Record<string, string>;
  runtimes?: { cubism?: string };
  files: Record<string, { bytes: number; sha256: string }>;
}
interface RuntimeDescriptor {
  schemaVersion: number;
  runtimeId: string;
  module: { url: string; bytes: number; sha256: string };
  core: {
    cubismCoreUrl: { url: string; bytes: number; sha256: string };
    cubismWasmUrl?: { url: string; bytes: number; sha256: string };
    cubism2CoreUrl: { url: string; bytes: number; sha256: string };
    motionSyncCoreUrl: { url: string; bytes: number; sha256: string };
  };
}

export function hostedDistributionBase(manifestUrl: URL, release: string): URL {
  const directory = new URL("./", manifestUrl);
  return directory.pathname.endsWith(`/${release}/`) ? new URL("../", directory) : directory;
}

export async function resolveHostedCubismRuntime(
  manifest: HostedManifest,
  manifestUrl: URL,
  read: (url: string) => Promise<Uint8Array>,
): Promise<CubismEmbedOptions> {
  const { release } = manifest;
  if (manifest.schemaVersion !== 1 || !/^r-[a-f0-9]{16}$/u.test(release)) throw new TypeError("Invalid SDK manifest");
  const distributionBase = hostedDistributionBase(manifestUrl, release);
  const target = manifest.runtimes?.cubism;
  if (target !== `./${release}/runtime.json`) throw new TypeError("SDK epoch has no pinned Cubism runtime descriptor");
  const expected = manifest.files?.["runtime.json"];
  if (!expected || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/u.test(expected.sha256))
    throw new TypeError("Invalid runtime descriptor metadata");
  const bytes = await read(new URL(target, distributionBase).href);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (bytes.length !== expected.bytes || hash !== expected.sha256)
    throw new TypeError("Runtime descriptor integrity mismatch");
  const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as RuntimeDescriptor;
  if (descriptor.schemaVersion !== 1 || !descriptor.runtimeId) throw new TypeError("Invalid Cubism runtime descriptor");
  const runtimeUrl = (file: RuntimeDescriptor["module"]) => {
    if (!file || !Number.isSafeInteger(file.bytes) || !/^[a-f0-9]{64}$/u.test(file.sha256))
      throw new TypeError("Invalid runtime file metadata");
    const url = new URL(file.url, manifestUrl);
    if (url.origin !== manifestUrl.origin || !/^\/(?:Core|cubism-runtime)\//u.test(url.pathname))
      throw new TypeError("Runtime file escapes deployment origin");
    url.searchParams.set("v", file.sha256);
    return url.href;
  };
  return {
    moduleUrl: runtimeUrl(descriptor.module),
    runtime: {
      cubismCoreUrl: runtimeUrl(descriptor.core.cubismCoreUrl),
      ...(descriptor.core.cubismWasmUrl ? { cubismWasmUrl: runtimeUrl(descriptor.core.cubismWasmUrl) } : {}),
      cubism2CoreUrl: runtimeUrl(descriptor.core.cubism2CoreUrl),
      motionSyncCoreUrl: runtimeUrl(descriptor.core.motionSyncCoreUrl),
    },
  };
}
