import {
  createHaneokaClient,
  type HaneokaLocale,
  type HaneokaPage,
  type HaneokaReleaseIdentity,
} from "../../../packages/api-client/src/haneoka";
import type { EmbedFetcher } from "../../../packages/embed-core/src/types";
import { readBytes } from "../../../packages/embed-core/src/io";
import { importSs } from "../../../packages/chart-editor/src/formats/ss";
import { resolveLocalizedText } from "../localized-text";
import { AUDIO_LIMITS } from "./audio";

export interface PublicSongSourceOptions {
  apiBase?: string;
  fetcher?: EmbedFetcher;
}
export interface PublicCreationSong {
  musicId: number;
  musicTitle: unknown;
  bandName: unknown;
  musicUrl: string;
  jacketUrl?: string;
  difficulty: { difficultyName: string; file: string; displayLevel?: number }[];
}
function song(value: unknown): PublicCreationSong {
  if (!value || typeof value !== "object") throw new Error("invalid_song");
  const row = value as PublicCreationSong;
  if (
    !Number.isSafeInteger(row.musicId) ||
    typeof row.musicUrl !== "string" ||
    !Array.isArray(row.difficulty) ||
    row.difficulty.some((entry) => !entry || typeof entry.difficultyName !== "string" || typeof entry.file !== "string")
  )
    throw new Error("invalid_song");
  return row;
}

/** URL identities follow the public server/release contract, including runtime audio. */
export function pinnedPublicUrl(
  path: string,
  identity: HaneokaReleaseIdentity,
  options: PublicSongSourceOptions = {},
): string {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.server) ||
    !/^r-[a-f0-9]{20}$/u.test(identity.releaseId) ||
    !identity.sourceId
  )
    throw new Error("invalid_release");
  const base = new URL(options.apiBase ?? "https://haneoka.org/api/v1/"),
    url = new URL(path, base);
  const server = encodeURIComponent(identity.server),
    apiPath = `${base.pathname.replace(/\/?$/u, "/")}servers/${server}/`;
  if (
    url.origin !== base.origin ||
    !(
      url.pathname.startsWith(`/assets/${server}/`) ||
      url.pathname.startsWith(`/runtime/${server}/`) ||
      url.pathname.startsWith(apiPath)
    )
  )
    throw new Error("resource_source_mismatch", { cause: { origin: url.origin, path: url.pathname } });
  url.searchParams.set("release", identity.releaseId);
  return url.href;
}
export function createPinnedPublicFetcher(
  identity: HaneokaReleaseIdentity,
  options: PublicSongSourceOptions = {},
): EmbedFetcher {
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    if (/^(blob|data):/u.test(request.url)) return fetcher(request);
    const response = await fetcher(
      new Request(pinnedPublicUrl(request.url, identity, options), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
    if (
      response.ok &&
      (response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
        response.headers.get("x-haneoka-source-id") !== identity.sourceId)
    ) {
      await response.body?.cancel();
      throw new Error("resource_release_mismatch");
    }
    return response;
  };
}
async function bytes(response: Response, signal: AbortSignal, maxBytes: number) {
  return readBytes(response, { signal, maxBytes, locale: "en", fetcher: fetch, progress: () => {} });
}
function client(options: PublicSongSourceOptions, identity?: HaneokaReleaseIdentity) {
  const transport = identity ? createPinnedPublicFetcher(identity, options) : (options.fetcher ?? fetch);
  return createHaneokaClient({
    baseUrl: options.apiBase ?? "https://haneoka.org/api/v1/",
    transport: async (request) => {
      const response = await transport(request);
      const data = await readBytes(
        response,
        { signal: request.signal, maxBytes: 8 * 1024 * 1024, locale: "en", fetcher: transport, progress: () => {} },
        false,
      );
      return new Response(data, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

/** First page observes current; further pages and chosen assets reuse that exact snapshot. */
export async function listPublicCreationSongs(
  options: PublicSongSourceOptions & {
    server: string;
    locale: HaneokaLocale;
    signal: AbortSignal;
    limit?: number;
    cursor?: string;
    identity?: HaneokaReleaseIdentity;
  },
): Promise<HaneokaPage<PublicCreationSong>> {
  if (options.identity && options.identity.server !== options.server) throw new Error("resource_source_mismatch");
  return client(options, options.identity).page("songs", {
    server: options.server,
    locale: options.locale,
    signal: options.signal,
    limit: options.limit ?? 20,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.identity ? { release: options.identity.releaseId } : {}),
    decode: song,
  });
}

export async function loadPublicCreationSong(
  options: PublicSongSourceOptions & {
    identity: HaneokaReleaseIdentity;
    songId: string;
    difficulty: string;
    locale: HaneokaLocale;
    signal: AbortSignal;
  },
) {
  const { identity, signal } = options;
  const metadata = await client(options, identity).entity("songs", options.songId, {
    server: identity.server,
    release: identity.releaseId,
    locale: options.locale,
    signal,
    decode: song,
  });
  const difficulty = metadata.difficulty.find((entry) => entry.difficultyName === options.difficulty);
  if (!difficulty) throw new Error("song_difficulty_missing");
  const fetcher = createPinnedPublicFetcher(identity, options);
  const sourceUrl = pinnedPublicUrl(difficulty.file, identity, options),
    audioUrl = pinnedPublicUrl(metadata.musicUrl, identity, options);
  const sourceBytes = await bytes(await fetcher(new Request(sourceUrl, { signal })), signal, 2 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes),
    imported = importSs(text);
  const audioResponse = await fetcher(new Request(audioUrl, { signal }));
  const audioBytes = await bytes(audioResponse, signal, AUDIO_LIMITS.bytes);
  signal.throwIfAborted();
  const fileName = decodeURIComponent(new URL(audioUrl).pathname.split("/").at(-1) ?? "audio");
  const audio = new File([audioBytes], fileName, {
    type: audioResponse.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg",
  });
  imported.project.meta.title = resolveLocalizedText(metadata.musicTitle, options.locale).text;
  imported.project.meta.artist = resolveLocalizedText(metadata.bandName, options.locale).text;
  imported.project.meta.difficulty = options.difficulty;
  imported.project.meta.level = String(difficulty.displayLevel ?? "");
  imported.project.extensions.haneoka = {
    server: identity.server,
    releaseId: identity.releaseId,
    sourceId: identity.sourceId,
    songId: options.songId,
    difficulty: options.difficulty,
    sourceUrl,
    audioUrl,
  };
  return {
    identity,
    metadata,
    project: imported.project,
    warnings: imported.warnings,
    audio,
    source: { name: decodeURIComponent(new URL(sourceUrl).pathname.split("/").at(-1) ?? "chart.ss.json"), text },
  };
}
