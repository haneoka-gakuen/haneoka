import type { ChartNote } from "@haneoka/cassiopeia";
import { NoteDirection, NoteOperateType, interpolateNoteLine } from "@haneoka/cassiopeia";
import type { OurNotesAssetManifest, RenderDirection, RenderNoteKind } from "@haneoka/cassiopeia-plugin-our-notes";
import type { ChartCanvasSkin } from "@haneoka/cassiopeia-ui-vue/overview";
import type { HaneokaReleaseIdentity } from "../../../packages/api-client/src/haneoka";
import type { EmbedLoader } from "../../../packages/embed-core/src/types";
import type { ChartSkin } from "../../../packages/embed-cassiopeia/src/types";
import { createPinnedPublicFetcher, pinnedPublicUrl, type PublicSongSourceOptions } from "./public-songs";

export {
  createChartCanvasRibbonStyle,
  drawChartCanvasLanePlane,
  drawChartCanvasRibbon,
} from "@haneoka/cassiopeia-ui-vue/overview";
export { interpolateNoteLine };

export interface OurNotesCreationCanvasSkinOptions extends PublicSongSourceOptions {
  signal?: AbortSignal;
  skin?: ChartSkin;
  locale?: string;
  /** Per selected resource decoded byte budget. */
  maxBytes?: number;
}

export interface OurNotesCreationCanvasSkin {
  readonly identity: HaneokaReleaseIdentity;
  readonly assets: OurNotesAssetManifest;
  readonly skin: ChartCanvasSkin;
  dispose(): Promise<void>;
}

/** Load one native flat-note atlas; its Blob URL and decoded canvas skin share this lease. */
export async function loadOurNotesCreationCanvasSkin(
  identity: HaneokaReleaseIdentity,
  options: OurNotesCreationCanvasSkinOptions = {},
): Promise<OurNotesCreationCanvasSkin> {
  // Validate the pin before starting network or image work.
  pinnedPublicUrl(`/assets/${identity.server}/`, identity, options);
  const controller = new AbortController();
  let loader: EmbedLoader<never> | undefined;
  let skin: ChartCanvasSkin | undefined;
  let imageUrl: string | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposed) return disposal ?? Promise.resolve();
    disposed = true;
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    skin?.dispose();
    skin = undefined;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
    return (disposal = loader?.dispose() ?? Promise.resolve());
  };
  const abort = () => {
    controller.abort(options.signal?.reason);
    void dispose();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const [{ createEmbedLoader }, { haneokaChartTheme }, { OUR_NOTES_BUNDLED_NOTE_ATLASES }, { loadChartCanvasSkin }] =
      await Promise.all([
        import("../../../packages/embed-core/src/index"),
        import("../../../packages/embed-cassiopeia/src/haneoka"),
        import("@haneoka/cassiopeia-plugin-our-notes"),
        import("@haneoka/cassiopeia-ui-vue/overview"),
      ]);
    controller.signal.throwIfAborted();
    const apiBase = options.apiBase ?? "https://haneoka.org/api/v1/";
    const publicBase = new URL("/", apiBase).href;
    const packaged = new Set(Object.values(OUR_NOTES_BUNDLED_NOTE_ATLASES).map((atlas) => atlas.textureUrl));
    const pinnedFetcher = createPinnedPublicFetcher(identity, options);
    const transport = options.fetcher ?? fetch;
    loader = createEmbedLoader<never>({
      source: {
        assetsBase: publicBase,
        load: () => {
          throw new Error("Canvas skin has no chart document");
        },
      },
      server: identity.server,
      locale: options.locale ?? "en",
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
      fetcher: (request) => (packaged.has(request.url) ? transport(request) : pinnedFetcher(request)),
      resolveResource: (key) => (packaged.has(key) ? key : pinnedPublicUrl(key, identity, options)),
    });
    const assets = await haneokaChartTheme({ apiBase, publicBase, server: identity.server })({
      loader,
      signal: controller.signal,
      skin: options.skin ?? { currentQuality: 2 },
    });
    controller.signal.throwIfAborted();
    const bytes = await loader.resourceBytes(assets.noteAtlas.textureUrl, { signal: controller.signal });
    controller.signal.throwIfAborted();
    imageUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const pending = loadChartCanvasSkin({ ...assets, noteAtlas: { ...assets.noteAtlas, textureUrl: imageUrl } });
    // Image decoding has no AbortSignal port; dispose a result that arrives after cancellation.
    void pending.then(
      (late) => {
        if (disposed) late.dispose();
      },
      () => {},
    );
    skin = await Promise.race([pending, cancelled]);
    controller.signal.throwIfAborted();
    return { identity: { ...identity }, assets, skin, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}

/** Same native operation mapping as drawDetailedChartOverview; critical stays data, not guessed tint. */
export function ourNotesCreationCanvasNoteAppearance(note: Pick<ChartNote, "operateType" | "direction" | "critical">): {
  kind: RenderNoteKind;
  direction: RenderDirection;
  critical: boolean;
} {
  const direction =
    note.direction === NoteDirection.Left ? "left" : note.direction === NoteDirection.Right ? "right" : "up";
  let kind: RenderNoteKind;
  switch (note.operateType) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      kind = direction === "left" ? "flick-left" : direction === "right" ? "flick-right" : "flick";
      break;
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.HiddenSlideBegin:
      kind = "slide-start";
      break;
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.HiddenSlideEnd:
      kind = "slide-end";
      break;
    case NoteOperateType.SlideConnection:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.Combo:
      kind = "slide-node";
      break;
    case NoteOperateType.Trace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      kind = "trace";
      break;
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideEnd:
      kind = "guide";
      break;
    default:
      kind = "tap";
  }
  return { kind, direction, critical: note.critical };
}
