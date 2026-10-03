import { canvasToPngBlob } from "../canvas-capture";
import { prepareCommunityStampDraft, communityStampComposerHref } from "../community-stamp-draft";
import { copyStampText, type StampLayer } from "./layers";
import { drawStamp, loadStampFont } from "./render";
import { STAMP_CANVAS_SIZE, type StampSize } from "./sizes";

/** Capture the composition before fonts or storage yield to subsequent edits. */
export async function prepareStampCommunityPost(
  image: HTMLImageElement,
  layers: readonly StampLayer[],
  fallback: string,
  sourceSize: StampSize,
  locale: string,
  fileName: string,
): Promise<string> {
  const snapshot = layers.map((layer) => ({
    ...layer,
    image: layer.image ? { ...layer.image } : undefined,
    settings: copyStampText(layer.settings),
  }));
  const size = { ...sourceSize };
  await Promise.all(snapshot.filter((layer) => !layer.image).map((layer) => loadStampFont(layer.settings, fallback)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = STAMP_CANVAS_SIZE;
  drawStamp(canvas, image, snapshot, fallback, undefined, undefined, size);
  const id = await prepareCommunityStampDraft(await canvasToPngBlob(canvas), fileName);
  return communityStampComposerHref(locale, id);
}
