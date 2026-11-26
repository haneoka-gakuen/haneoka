import type { EmbedLoader } from "@haneoka/embed-core";
import type { AdvStory } from "@haneoka/vega/engine";

const mediaTypes: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
};

function audioExtension(url: string): string | undefined {
  return /\.([a-z0-9]+)$/iu.exec(new URL(url).pathname)?.[1]?.toLowerCase();
}

/** Materialize playback URLs through the bounded host transport. */
export function createPlaybackUrls(loader: EmbedLoader<AdvStory>, signal: AbortSignal, timeoutMs: number) {
  const pending = new Map<string, Promise<string>>();
  const resolvedKeys = new Map<string, Promise<string>>();
  const sources = new Map<string, Promise<string>>();
  const references = new Map<string, string>();
  const referenceKeys = new Map<string, string>();
  const namespace = crypto.randomUUID();
  let preparation: Promise<void> | undefined;
  const owned = new Set<string>();
  const sourceFor = (key: string): Promise<string> => {
    let value = sources.get(key);
    if (!value) {
      value = loader.resourceUrl(key, { signal });
      sources.set(key, value);
    }
    return value;
  };
  const resolve = (key: string): Promise<string> => {
    let keyed = resolvedKeys.get(key);
    if (keyed) return keyed;
    keyed = (async () => {
      signal.throwIfAborted();
      const source = await sourceFor(key);
      if (!/^(?:https?:\/\/|blob:)/iu.test(source)) return source;
      let result = pending.get(source);
      if (!result) {
        result = (async () => {
          const file = await loader.resourceBlob(source, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          });
          signal.throwIfAborted();
          const type = file.type.split(";", 1)[0];
          const extension =
            (type === "audio/x-wav" ? "wav" : undefined) ??
            Object.keys(mediaTypes).find((key) => mediaTypes[key] === type) ??
            audioExtension(source);
          const blob = file.type ? file : new Blob([file], { type: mediaTypes[extension ?? ""] ?? "" });
          const url = URL.createObjectURL(blob);
          owned.add(url);
          // Howler selects its decoder from the canonical playback URL suffix.
          return extension ? `${url}#audio.${extension}` : url;
        })();
        pending.set(source, result);
      }
      return result;
    })();
    resolvedKeys.set(key, keyed);
    return keyed;
  };
  return {
    resolve,
    async reference(key: string): Promise<string> {
      const source = await sourceFor(key);
      const extension = audioExtension(source);
      if (!/^https?:\/\//iu.test(source) || !extension) return resolve(key);
      let value = references.get(source);
      if (!value) {
        value = `embed-playback://${namespace}/${references.size}.${extension}`;
        references.set(source, value);
        referenceKeys.set(value, key);
      }
      return value;
    },
    async read(url: URL, consumerSignal: AbortSignal): Promise<Uint8Array> {
      consumerSignal.throwIfAborted();
      const key = referenceKeys.get(url.href);
      if (!key || !preparation) throw new TypeError("Unknown embed playback resource");
      // Encoded audio waits here while theme, fonts and models can initialize.
      await new Promise<void>((resolveRead, rejectRead) => {
        const abort = () => rejectRead(consumerSignal.reason);
        consumerSignal.addEventListener("abort", abort, { once: true });
        preparation!.then(resolveRead, rejectRead).finally(() => consumerSignal.removeEventListener("abort", abort));
      });
      consumerSignal.throwIfAborted();
      return loader.resourceBytes(await resolve(key), {
        signal: AbortSignal.any([signal, consumerSignal, AbortSignal.timeout(timeoutMs)]),
      });
    },
    prepare(keys: Iterable<string>): Promise<void> {
      if (preparation) return preparation;
      const queue = [...new Set(keys)];
      let cursor = 0;
      let failed = false;
      let failure: unknown;
      const worker = async (): Promise<void> => {
        try {
          while (!failed && cursor < queue.length) {
            signal.throwIfAborted();
            await resolve(queue[cursor++]!);
          }
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      };
      // Only these four workers launch remote audio IO.
      preparation = Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker)).then(() => {
        signal.throwIfAborted();
        if (failed) throw failure;
      });
      return preparation;
    },
    dispose(): void {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
      pending.clear();
      resolvedKeys.clear();
      sources.clear();
      references.clear();
      referenceKeys.clear();
    },
  };
}
