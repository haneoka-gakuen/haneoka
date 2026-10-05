import { buildChart, parseScore, OUR_NOTES_BUNDLED_NOTE_ATLASES } from "@haneoka/cassiopeia-plugin-our-notes";
import { LANE_COUNT, type ChartDocument } from "@haneoka/cassiopeia";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";
import { serializeSs } from "../../../packages/chart-editor/src/formats/ss";
import { getExportDiagnostics } from "../../../packages/chart-editor/src/formats/diagnostics";
import { TempoMap } from "../../../packages/chart-editor/src/timing";
import type { Project } from "../../../packages/chart-editor/src/model";
import type { ChartEmbedHandle, ChartSkin, ChartPlaybackOptions } from "../../../packages/embed-cassiopeia/src/types";
import type { HaneokaReleaseIdentity } from "../../../packages/api-client/src/haneoka";
import type { CreationAudio } from "./audio";
import { createPinnedPublicFetcher, pinnedPublicUrl, type PublicSongSourceOptions } from "./public-songs";
import { authoredSpanOverlaps } from "../../../packages/chart-editor/src/creation/span";

/** This opt-in target uses the actual OurNotes converter, including guide overlap, crit and slide endpoints. */
export function compileOurNotesCreation(project: Project) {
  assertValidProject(project);
  if (project.meta.source && !["ss", "authored"].includes(project.meta.source))
    throw new Error("our_notes_source_mismatch");
  const ss = serializeSs(project),
    chart = buildChart(parseScore(ss));
  const ids = new Set(chart.notes.map((note) => note.id));
  if (
    !Number.isFinite(chart.durationMs) ||
    chart.notes.some(
      (note) => !Number.isFinite(note.timeMs) || !Number.isFinite(note.pos) || !Number.isFinite(note.size),
    ) ||
    ids.size !== chart.notes.length ||
    chart.lines.some((line) => line.noteIds.some((id) => !ids.has(id)))
  )
    throw new Error("our_notes_invalid_runtime");
  const outside = chart.notes.find((note) => note.judged && !authoredSpanOverlaps(note.pos, note.size, LANE_COUNT));
  if (outside)
    throw new Error("our_notes_judged_note_outside_stage", {
      cause: { id: outside.id, tick: outside.tick, lane: outside.pos, size: outside.size },
    });
  // Musical time stays in the kernel; media zero is represented by the host offset.
  const tempo = new TempoMap(project.tempos, { resolution: project.resolution });
  chart.timeScaleChanges = project.timeScales
    .map((event) => ({ timeMs: tempo.tickToSeconds(event.tick) * 1000, scale: event.scale }))
    .sort((a, b) => a.timeMs - b.timeMs);
  return { ss, chart, bgmOffsetMs: project.audioOffset * 1000, warnings: getExportDiagnostics(project, "ss") };
}

export interface NativeCreationPreviewOptions extends PublicSongSourceOptions, ChartPlaybackOptions {
  identity: HaneokaReleaseIdentity;
  locale?: string;
  skin?: ChartSkin;
  signal?: AbortSignal;
  labels: { player: string; pause: string; loading: string };
  onEvent?: import("../../../packages/embed-cassiopeia/src/types").MountChartOptions["onEvent"];
}

/** Reuse the same OurNotes asset factory and Vue/Three host as the public player. Load only on demand. */
export async function mountOurNotesCreationPreview(
  container: HTMLElement,
  project: Project,
  audio: CreationAudio,
  options: NativeCreationPreviewOptions,
): Promise<ChartEmbedHandle> {
  const compiled = compileOurNotesCreation(project);
  options.signal?.throwIfAborted();
  const [{ mountChart }, { haneokaChartTheme }] = await Promise.all([
    import("../../../packages/embed-cassiopeia/src/index"),
    import("../../../packages/embed-cassiopeia/src/haneoka"),
    import("../../../packages/embed-cassiopeia/src/style.css"),
  ]);
  options.signal?.throwIfAborted();
  const apiBase = options.apiBase ?? "https://haneoka.org/api/v1/",
    assetBase = new URL("/", apiBase).href;
  const packagedTextures = new Set(Object.values(OUR_NOTES_BUNDLED_NOTE_ATLASES).map((atlas) => atlas.textureUrl));
  const pinnedFetcher = createPinnedPublicFetcher(options.identity, options);
  const transport = options.fetcher ?? fetch;
  const url = URL.createObjectURL(audio.file);
  const document = {
    chart: {
      ...compiled.chart,
      durationMs: Math.max(compiled.chart.durationMs, audio.analysis.duration * 1000 - compiled.bgmOffsetMs),
    } as ChartDocument,
    audio: url,
    bgmOffsetMs: compiled.bgmOffsetMs,
  };
  let handle: ChartEmbedHandle | undefined;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      URL.revokeObjectURL(url);
    }
  };
  try {
    handle = mountChart(container, {
      document,
      server: options.identity.server,
      locale: options.locale ?? "en",
      assetsBase: assetBase,
      theme: haneokaChartTheme({ apiBase, publicBase: assetBase, server: options.identity.server }),
      fetcher: (request) =>
        packagedTextures.has(request.url)
          ? transport(new Request(request, { credentials: "omit", referrerPolicy: "no-referrer" }))
          : pinnedFetcher(request),
      resolveResource: (key) =>
        /^(blob|data):/u.test(key) || packagedTextures.has(key) ? key : pinnedPublicUrl(key, options.identity, options),
      mode: options.mode ?? "watch",
      skin: options.skin ?? { currentQuality: 2 },
      settings: options.settings ?? {},
      volume: options.volume ?? 1,
      rate: options.rate ?? 1,
      loop: options.loop ?? false,
      noteSoundEnabled: options.noteSoundEnabled ?? false,
      noteSoundVolume: options.noteSoundVolume ?? 1,
      labels: options.labels,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      maxBytes: 32 * 1024 * 1024,
      loadTimeoutMs: 30000,
    });

    await handle.ready;
    options.signal?.throwIfAborted();
  } catch (error) {
    try {
      await handle?.dispose();
    } finally {
      release();
    }
    throw error;
  }
  const active = handle!;
  const releaseOnAbort = () => {
    active.cancel();
    release();
  };
  options.signal?.addEventListener("abort", releaseOnAbort, { once: true });
  if (options.signal?.aborted) releaseOnAbort();
  return {
    ...active,
    get ready() {
      return active.ready;
    },
    get snapshot() {
      return active.snapshot;
    },
    cancel() {
      options.signal?.removeEventListener("abort", releaseOnAbort);
      active.cancel();
      release();
    },
    async dispose() {
      options.signal?.removeEventListener("abort", releaseOnAbort);
      try {
        await active.dispose();
      } finally {
        release();
      }
    },
  };
}
