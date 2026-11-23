const archiveOrigin = "https://model-archive.invalid";
const jsonDecoder = new TextDecoder();
const archiveLimit = 128 * 1024 * 1024;

const contentTypes: Record<string, string> = {
  avif: "image/avif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  png: "image/png",
  webp: "image/webp",
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid Cubism model ${name}`);
  }
  return value as Record<string, unknown>;
}

function path(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Cubism model is missing ${name}`);
  return value;
}

const archiveUrl = (name: string) => new URL(name.split("/").map(encodeURIComponent).join("/"), archiveOrigin);

async function unpackModel(bytes: Uint8Array, src: string) {
  const { unzipSync } = await import("fflate");
  let size = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      if (++count > 4096 || (size += file.originalSize) > archiveLimit) {
        throw new RangeError("Cubism ZIP exceeds the unpacked size or file count limit");
      }
      return (
        !file.name.startsWith("__MACOSX/") &&
        !file.name.endsWith("/") &&
        !file.name.split("/").some((part) => ["", ".", "..", "__proto__"].includes(part)) &&
        !file.name.includes("\\")
      );
    },
  });
  const names = Object.keys(files);
  const models = names.filter((name) => /(?:\.model3|(?:^|\/)model3?)\.json$/iu.test(name));
  const zipName = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "").replace(/\.zip$/iu, "");
  const match = models.filter((name) => name.split("/").pop() === `${zipName}.model3.json`);
  const name = models.length === 1 ? models[0] : match.length === 1 ? match[0] : undefined;
  if (!name) {
    throw new TypeError(
      models.length ? "Cubism ZIP contains multiple model descriptors" : "Cubism ZIP is missing a .model3.json",
    );
  }
  return { files, name, base: archiveUrl(name) };
}

type ReadModelAsset = (url: string, signal: AbortSignal) => Promise<Uint8Array>;
type ResolveModelAsset = (reference: string, base: URL) => string | Promise<string>;
const motionName = (file: string) =>
  file
    .split("/")
    .pop()!
    .replace(/\.motion3\.json$/iu, "");

export function createModelAssets() {
  const urls = new Set<string>();
  const publish = (body: BlobPart, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    urls.add(url);
    return `${url}#/${encodeURIComponent(name.split("/").pop()!)}`;
  };
  return {
    async load(
      src: string,
      read: ReadModelAsset,
      signal: AbortSignal,
      resolveRemote: ResolveModelAsset = (reference, base) => new URL(reference, base).href,
    ) {
      const bytes = await read(src, signal);
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const archive = isZip ? await unpackModel(bytes, src) : undefined;
      signal.throwIfAborted();
      const base = archive?.base ?? new URL(src);
      const manifest = record(
        JSON.parse(jsonDecoder.decode(archive ? archive.files[archive.name] : bytes)),
        "descriptor",
      );
      const refs = record(manifest.FileReferences, "FileReferences (Cubism 3)");
      if (!Array.isArray(refs.Textures) || !refs.Textures.length) {
        throw new TypeError("Cubism model is missing FileReferences.Textures");
      }
      const missing = new Set<string>();
      const embedded = new Map<string, string>();
      const resolve = async (reference: string): Promise<string> => {
        signal.throwIfAborted();
        if (!archive) return resolveRemote(reference, base);
        const target = new URL(reference, base);
        const name = decodeURIComponent(target.pathname.slice(1));
        const file = Object.hasOwn(archive.files, name) ? archive.files[name] : undefined;
        if (target.origin !== archiveOrigin || !file) {
          missing.add(reference);
          return reference;
        }
        const cached = embedded.get(name);
        if (cached) return cached;
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const url = publish(new Uint8Array(file), name, contentTypes[ext] ?? "");
        embedded.set(name, url);
        return url;
      };
      const resolved = {
        ...refs,
        Moc: await resolve(path(refs.Moc, "FileReferences.Moc")),
        Textures: await Promise.all(refs.Textures.map((value, index) => resolve(path(value, `Textures[${index}]`)))),
      } as Record<string, unknown>;
      for (const key of ["Physics", "Pose", "UserData", "DisplayInfo"]) {
        if (refs[key]) resolved[key] = await resolve(path(refs[key], key));
      }
      const resolveEntries = (entries: unknown, name: string) => {
        if (!Array.isArray(entries)) throw new TypeError(`Invalid Cubism model ${name}`);
        return Promise.all(
          entries.map(async (value): Promise<Record<string, unknown> & { File: string }> => {
            const entry = record(value, name);
            return {
              ...entry,
              File: await resolve(path(entry.File, `${name}.File`)),
              ...(entry.Sound ? { Sound: await resolve(path(entry.Sound, `${name}.Sound`)) } : {}),
            };
          }),
        );
      };
      const motions = new Set<string>();
      if (refs.Motions) {
        const groups = await Promise.all(
          Object.entries(record(refs.Motions, "Motions")).map(
            async ([name, entries]) => [name, await resolveEntries(entries, name)] as const,
          ),
        );
        resolved.Motions = Object.fromEntries(groups);
        for (const [, entries] of groups) {
          for (const entry of entries) motions.add(motionName(entry.File));
        }
      }
      const expressions: string[] = [];
      if (refs.Expressions) {
        const entries = await resolveEntries(refs.Expressions, "Expressions");
        resolved.Expressions = entries;
        for (const entry of entries) if (typeof entry.Name === "string") expressions.push(entry.Name);
      }
      if (missing.size) throw new Error(`Cubism ZIP is missing: ${[...missing].join(", ")}`);
      signal.throwIfAborted();
      return {
        url: publish(
          JSON.stringify({ ...manifest, FileReferences: resolved }),
          "model.model3.json",
          "application/json",
        ),
        motions: [...motions],
        expressions,
      };
    },
    owns(url: string) {
      return url.startsWith("blob:") && urls.has(url.split("#", 1)[0]!);
    },
    dispose() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
