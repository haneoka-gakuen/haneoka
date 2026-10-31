// L3 — GEB
// Input: { id, server, file, kind? } 消息；同源 /runtime/{server}/card-recognition/ 参考文件。
// Output: haneoka-card-recognition-result-v1 结果与 referenceId，或错误码。
// Pos: [Map](../L2-2.md)；截图识别的本机计算线程。
// Effects/Dependencies: 每个 server 只下载并解码一次参考图；截图不离开设备。
import {
  ALGORITHM,
  glyphMasks,
  recognize,
  referenceKind,
  type CardKind,
  type LocalReference,
  type Raster,
} from "./kernel";

interface LocalDocument {
  schema: "haneoka-card-recognition-local-v1";
  kinds: Record<CardKind, { tile: [number, number]; columns: number; sheet: string; cardIds: number[] }>;
  levelReader: { glyphs: Record<string, string[]>; allowedLevels: Record<CardKind, number[]> } | null;
}

const references = new Map<string, Promise<{ reference: LocalReference; referenceId: string }>>();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function raster(blob: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}

function load(server: string) {
  let pending = references.get(server);
  if (!pending) {
    pending = (async () => {
      const base = `/runtime/${server}/card-recognition/`;
      const response = await fetch(base + "local.json");
      if (!response.ok) throw new Error("recognition_reference_unavailable");
      const bytes = await response.arrayBuffer();
      const document = JSON.parse(new TextDecoder().decode(bytes)) as LocalDocument;
      if (document.schema !== "haneoka-card-recognition-local-v1") throw new Error("recognition_reference_unavailable");
      const kinds = {} as LocalReference["kinds"];
      for (const kind of ["members", "snapshots"] as const) {
        const entry = document.kinds[kind];
        const sheet = await fetch(base + entry.sheet);
        if (!sheet.ok) throw new Error("recognition_reference_unavailable");
        kinds[kind] = referenceKind(await raster(await sheet.blob()), entry.tile, entry.columns, entry.cardIds);
      }
      const reader = document.levelReader;
      return {
        reference: {
          kinds,
          glyphs: reader ? glyphMasks(reader.glyphs) : null,
          allowedLevels: reader
            ? { members: new Set(reader.allowedLevels.members), snapshots: new Set(reader.allowedLevels.snapshots) }
            : null,
        },
        referenceId: hex(await crypto.subtle.digest("SHA-256", bytes)),
      };
    })();
    pending.catch(() => references.delete(server));
    references.set(server, pending);
  }
  return pending;
}

self.onmessage = async (
  event: MessageEvent<{ id: string; server: string; identity: Record<string, string>; file: Blob; kind?: CardKind }>,
) => {
  const { id, server, identity, file, kind } = event.data;
  try {
    const [{ reference, referenceId }, image, digest] = await Promise.all([
      load(server),
      raster(file),
      file.arrayBuffer().then((bytes) => crypto.subtle.digest("SHA-256", bytes)),
    ]);
    const observations = recognize(image, reference, { kind });
    const imageId = "image";
    self.postMessage({
      id,
      referenceId,
      result: {
        schema: "haneoka-card-recognition-result-v1",
        identity,
        referenceId,
        images: [
          {
            id: imageId,
            sha256: hex(digest),
            size: [image.width, image.height],
            coordinateSpace: "exif_normalized_original",
            observationIds: observations.map((_, index) => `${imageId}:${index + 1}`),
            status: observations.length ? "processed" : "needs_crop",
          },
        ],
        observations: observations.map((row, index) => ({
          id: `${imageId}:${index + 1}`,
          imageId,
          kind: row.kind,
          bbox: row.bbox,
          cardId: row.cardId,
          status: row.status,
          candidates: row.candidates,
          fields: { level: row.level },
        })),
        engine: { algorithm: ALGORITHM },
      },
    });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "recognition_failed",
    });
  }
};
