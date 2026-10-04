import { canvasToPngBlob } from "../canvas-capture";
import {
  prepareCommunityStampDraft, communityStampComposerHref, type CommunityStampForumTarget,
} from "../community-stamp-draft";
import { copyStampText, type StampLayer } from "./layers";
import { drawStamp, loadStampFont } from "./render";
import { STAMP_CANVAS_SIZE, type StampSize } from "./sizes";

/** An unresolved target is retried by the authenticated composer, never treated as the general board. */
async function defaultForumTarget(): Promise<CommunityStampForumTarget> {
  const target: CommunityStampForumTarget = { purpose: "stamp", forumId: null };
  try {
    const response = await fetch("/api/v1/community/forums?purpose=stamp", {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return target;
    const result = await response.json() as { forums?: unknown };
    if (!Array.isArray(result.forums) || result.forums.length !== 1) return target;
    const forum = result.forums[0];
    if (forum?.defaultPurpose === "stamp" && forum.enabled === true && forum.capabilities?.canRead === true &&
      typeof forum.id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(forum.id))
      target.forumId = forum.id;
  } catch {
    // Preserve the PNG; login, connectivity and board permissions are resolved in the composer.
  }
  return target;
}

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
  const png = await canvasToPngBlob(canvas);
  const id = await prepareCommunityStampDraft(png, fileName, await defaultForumTarget());
  return communityStampComposerHref(locale, id);
}
