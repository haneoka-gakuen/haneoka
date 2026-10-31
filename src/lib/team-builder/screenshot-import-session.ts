import type { TeamBuilderData } from "./data";
import { practiceRanges, type InventoryV1 } from "./inventory";
import { createRecognitionClient, normalizeRecognitionResult, type RecognitionTransport } from "./recognition-client";
import { localRecognitionTransport } from "./screenshot-recognition/client";
import { videoFrames } from "./screenshot-video";
import { previewScreenshotImportBatch, applyConfirmedScreenshotImport,
  type ScreenshotRecognitionResult, type ScreenshotReviewContext, type ScreenshotSelection } from "./screenshot-import";
import type { ScreenshotImportDialogState } from "../../lit/shared/team-screenshot-import";

type Selection = ScreenshotSelection & { image: number };
export interface ScreenshotImportSessionOptions {
  inventory: InventoryV1;
  data: TeamBuilderData;
  context: ScreenshotReviewContext;
  onState: (state: ScreenshotImportDialogState) => void;
  onUploadProgress?: (loaded: number, total: number) => void;
  transport?: RecognitionTransport;
  /** Allows a deterministic lifecycle test; runtime uses an abortable 1s wait. */
  wait?: (signal: AbortSignal) => Promise<void>;
  crops?: (file: Blob, result: ScreenshotRecognitionResult, signal: AbortSignal) => Promise<Record<string, string>>;
  revoke?: (url: string) => void;
}

const waitForPoll = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
  signal.addEventListener("abort", abort, { once: true });
});

/** Bounded local crops in the kernel's EXIF-normalized coordinate space. */
export async function createScreenshotCrops(file: Blob, result: ScreenshotRecognitionResult, signal: AbortSignal) {
  signal.throwIfAborted();
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  const crops: Record<string, string> = {};
  try {
    signal.throwIfAborted();
    if (image.width !== result.image.width || image.height !== result.image.height) throw new RangeError("recognition-image-coordinate-mismatch");
    for (const [index, row] of result.observations.entries()) {
      signal.throwIfAborted();
      const [x, y, width, height] = row.bbox;
      const scale = Math.min(1, 320 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("recognition-crop-canvas");
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("recognition-crop-image")), "image/png"));
      signal.throwIfAborted(); crops[String(index)] = URL.createObjectURL(blob);
    }
    return crops;
  } catch (error) { Object.values(crops).forEach(url => URL.revokeObjectURL(url)); throw error; }
  finally { image.close(); }
}

/** One account/source-bound review. The parent routes state to its modal and
 * existing header loading reporter; merge returns a value for InventoryStore
 * edit/CAS. This controller never saves before that explicit confirmation.
 */
export function createScreenshotImportSession(options: ScreenshotImportSessionOptions) {
  const inventory = structuredClone(options.inventory), context = { ...options.context }, data = options.data;
  const client = createRecognitionClient({ ...context, ownerId: context.ownerId || "local" }, options.transport ?? localRecognitionTransport);
  const revoke = options.revoke ?? URL.revokeObjectURL.bind(URL);
  let state: ScreenshotImportDialogState = { phase: "select", confirmations: [], crops: {}, error: null, canConfirm: false };
  let controller: AbortController | null = null, closed = false;
  let results: ScreenshotRecognitionResult[] = [], selections: Selection[] = [];
  const jobs = new Set<string>();
  const emit = () => { if (!closed) options.onState(state); };
  const cleanupCrops = () => { Object.values(state.crops).forEach(revoke); state = { ...state, crops: {} }; };
  // Keep IDs while POST is in flight: an early DELETE can race job creation.
  // The settled upload path sends DELETE again before releasing its IDs.
  const cleanupJobs = async (settled = false) => Promise.allSettled([...jobs].map(async id => {
    await client.cancel(id); if (settled) jobs.delete(id);
  }));
  const refreshCanConfirm = () => {
    state.canConfirm = false;
    if (!state.preview || !state.confirmations.some(choice => choice.include)) return;
    try {
      applyConfirmedScreenshotImport(state.preview, inventory, data, context, state.confirmations, state.existingValues);
      state.canConfirm = true;
    } catch {
      // Conflicting supplied levels remain in review until a concrete choice.
    }
  };
  const review = () => {
    const preview = previewScreenshotImportBatch(inventory, data, context, results, selections);
    const confirmations = preview.cards.map(card => {
      const previous = state.confirmations.find(choice => choice.key === card.key);
      const legal = practiceRanges(data, card.kind, card.cardId, inventory[card.kind].find(entry => entry.cardId === card.cardId)).level ?? [];
      return previous ? { ...previous, level: previous.level === "keep" && card.existingInstanceId !== null ? "keep" as const : typeof previous.level === "number" &&
        (previous.levelSource === "manual" ? legal : card.observedLevels).includes(previous.level) ? previous.level : undefined }
        : { key: card.key, include: card.observedLevels.length <= 1 };
    });
    state = { ...state, phase: "review", preview, results: [...results], confirmations,
      canConfirm: false, error: null }; refreshCanConfirm(); emit();
  };
  return {
    state: () => state,
    async files(files: readonly Blob[]) {
      if (closed || controller) throw new Error("recognition-session-busy");
      if (!files.length || files.length > 8 || files.some(file => !file.size || file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)))
        throw new RangeError("recognition-image-format-or-size");
      const run = new AbortController(); controller = run;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; run.abort(); }, 180_000);
      cleanupCrops(); results = []; selections = [];
      state = { phase: "processing", confirmations: [], crops: {}, error: null, canConfirm: false }; emit();
      try {
        // Sequential jobs stay below the private endpoint's active-job limit.
        for (const file of files) {
          run.signal.throwIfAborted();
          const id = crypto.randomUUID(); jobs.add(id);
          let job = await client.submit(file, run.signal, id, options.onUploadProgress);
          while (job.state === "queued" || job.state === "processing") {
            state = { ...state, phase: job.state }; emit();
            await (options.wait ?? waitForPoll)(run.signal);
            job = await client.poll(id, run.signal);
          }
          run.signal.throwIfAborted();
          if (job.state !== "ready") throw new Error(job.error?.code ?? "recognition-failed");
          const normalized = normalizeRecognitionResult(job);
          if (normalized.length !== 1) throw new RangeError("recognition-job-image-count");
          const result = normalized[0]!, image = results.length;
          // Validate boxes and catalogue IDs before decoding or making crop URLs.
          previewScreenshotImportBatch(inventory, data, context, [result], []);
          const crops = await (options.crops ?? createScreenshotCrops)(file, result, run.signal);
          if (run.signal.aborted || closed) { Object.values(crops).forEach(revoke); run.signal.throwIfAborted(); throw new Error("recognition-session-closed"); }
          state = { ...state, crops: { ...state.crops, ...Object.fromEntries(Object.entries(crops).map(([index, url]) => [`${image}:${index}`, url])) } };
          results.push(result);
          for (const [observation, row] of result.observations.entries())
            selections.push({ image, observation, cardId: row.cardId !== null &&
              (row.kind === "members" ? data.members : data.snapshots)[String(row.cardId)] ? row.cardId : null });
          await client.cancel(id); jobs.delete(id);
        }
        run.signal.throwIfAborted();
        review();
      } catch (error) {
        cleanupCrops(); results = []; selections = [];
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
        if (!closed) { state = { phase: run.signal.aborted && !timedOut ? "select" : "failed", confirmations: [], crops: {}, error: timedOut ? "image-timeout" : run.signal.aborted ? null : code ?? "recognition-failed", canConfirm: false }; emit(); }
      } finally {
        clearTimeout(timer);
        await cleanupJobs(true); if (controller === run) controller = null;
      }
    },
    /** A screen recording scrolled through the Box: every frame is
     * recognized, each card is kept once (from the frame it first appears in)
     * and its level is the reading most frames agree on. */
    async video(file: Blob, onFrame?: (done: number, total: number) => void) {
      if (closed || controller) throw new Error("recognition-session-busy");
      const run = new AbortController(); controller = run;
      cleanupCrops(); results = []; selections = [];
      state = { phase: "processing", confirmations: [], crops: {}, error: null, canConfirm: false }; emit();
      const seen = new Map<string, { frames: number; best: number; levels: Map<number, number>; observation: ScreenshotRecognitionResult["observations"][number] }>();
      try {
        for await (const { frame, index, total } of videoFrames(file, run.signal)) {
          onFrame?.(index, total);
          const id = crypto.randomUUID(); jobs.add(id);
          const job = await client.submit(frame, run.signal, id);
          await client.cancel(id); jobs.delete(id);
          if (job.state !== "ready") continue;
          const result = normalizeRecognitionResult(job)[0];
          if (!result) continue;
          previewScreenshotImportBatch(inventory, data, context, [result], []);
          const fresh: ScreenshotRecognitionResult["observations"] = [];
          for (const row of result.observations) {
            if (row.cardId === null || !(row.kind === "members" ? data.members : data.snapshots)[String(row.cardId)]) continue;
            const key = `${row.kind}:${row.cardId}`;
            let entry = seen.get(key);
            if (!entry) {
              entry = { frames: 0, best: 0, levels: new Map(), observation: { ...row, level: { ...row.level } } };
              seen.set(key, entry);
              fresh.push(entry.observation);
            }
            entry.frames++;
            entry.best = Math.max(entry.best, row.candidates[0]?.score ?? 0);
            if (row.level.value !== null) entry.levels.set(row.level.value, (entry.levels.get(row.level.value) ?? 0) + 1);
          }
          if (!fresh.length) continue;
          const kept = { ...result, observations: fresh };
          const crops = await (options.crops ?? createScreenshotCrops)(frame, kept, run.signal);
          const image = results.length;
          state = { ...state, crops: { ...state.crops, ...Object.fromEntries(Object.entries(crops).map(([i, url]) => [`${image}:${i}`, url])) } };
          results.push(kept);
        }
        run.signal.throwIfAborted();
        // A real card is seen in two frames and clearly matched in one of
        // them; a row caught mid-scroll can pass the per-frame threshold once.
        const keep = new Set([...seen.values()].filter((entry) => entry.frames >= 2 && entry.best >= 0.8).map((entry) => entry.observation));
        const crops: Record<string, string> = {};
        const kept: ScreenshotRecognitionResult[] = [];
        results.forEach((result, image) => {
          const rows = result.observations.filter((row, index) => {
            const url = state.crops[`${image}:${index}`];
            if (keep.has(row)) return true;
            if (url) revoke(url);
            return false;
          });
          if (!rows.length) return;
          const at = kept.length;
          let next = 0;
          result.observations.forEach((row, index) => {
            if (!keep.has(row)) return;
            crops[`${at}:${next}`] = state.crops[`${image}:${index}`]!;
            selections.push({ image: at, observation: next++, cardId: row.cardId });
          });
          kept.push({ ...result, observations: rows });
        });
        results = kept;
        state = { ...state, crops };
        for (const { levels, observation } of seen.values()) {
          const [first, second] = [...levels.entries()].sort((a, b) => b[1] - a[1]);
          // A single frame's reading can catch a row mid-scroll; two must agree.
          observation.level = first && first[1] >= 2 && (!second || first[1] > second[1])
            ? { value: first[0], reason: "majority" }
            : { value: null, reason: "unread-or-disagreeing" };
        }
        review();
      } catch (error) {
        cleanupCrops(); results = []; selections = [];
        const code = error instanceof Error ? (error as Error & { code?: string }).code ?? (error instanceof RangeError ? error.message : undefined) : undefined;
        if (!closed) { state = { phase: run.signal.aborted ? "select" : "failed", confirmations: [], crops: {}, error: run.signal.aborted ? null : code ?? "recognition-failed", canConfirm: false }; emit(); }
      } finally {
        await cleanupJobs(true); if (controller === run) controller = null;
      }
    },
    correct(image: number, observation: number, cardId: number | null) {
      if (closed || state.phase !== "review" || !results[image]?.observations[observation]) throw new RangeError("recognition-review-selection");
      const next = selections.filter(value => value.image !== image || value.observation !== observation);
      next.push({ image, observation, cardId });
      previewScreenshotImportBatch(inventory, data, context, results, next);
      selections = next; review();
    },
    include(key: string, include: boolean) {
      if (closed || state.phase !== "review" || !state.preview?.cards.some(card => card.key === key)) throw new RangeError("recognition-review-selection");
      state = { ...state, confirmations: state.confirmations.map(choice => choice.key === key ? { ...choice, include } : choice) };
      refreshCanConfirm(); emit();
    },
    existingValues(existingValues: "keep" | "overwrite" | "updates") {
      if (closed || state.phase !== "review" || !state.preview) throw new RangeError("recognition-review-selection");
      const existing = new Set(state.preview.cards.filter(card => card.existingInstanceId !== null).map(card => card.key));
      state = { ...state, existingValues, confirmations: state.confirmations.map(choice => existing.has(choice.key)
        ? { ...choice, level: undefined, levelSource: undefined } : choice) };
      refreshCanConfirm(); emit();
    },
    level(key: string, level: number | "keep" | undefined, source: "observed" | "manual" = "observed") {
      const proposal = state.preview?.cards.find(card => card.key === key);
      if (closed || state.phase !== "review" || !proposal) throw new RangeError("recognition-review-level");
      const legal = source === "manual" ? practiceRanges(data, proposal.kind, proposal.cardId,
        inventory[proposal.kind].find(entry => entry.cardId === proposal.cardId)).level ?? [] : proposal.observedLevels;
      if (level === "keep" ? proposal.existingInstanceId === null : level !== undefined && !legal.includes(level)) throw new RangeError("recognition-review-level");
      state = { ...state, confirmations: state.confirmations.map(choice => choice.key === key ? { ...choice, level, levelSource: typeof level === "number" ? source : undefined } : choice) }; refreshCanConfirm(); emit();
    },
    merge(current: InventoryV1, currentData: TeamBuilderData, currentContext: ScreenshotReviewContext) {
      if (closed || state.phase !== "review" || !state.preview || !state.canConfirm) throw new RangeError("recognition-review-required");
      return applyConfirmedScreenshotImport(state.preview, current, currentData, currentContext, state.confirmations, state.existingValues);
    },
    /** Parent calls on close, account/source/revision change, and disconnection. */
    async close() {
      closed = true; controller?.abort(); cleanupCrops(); results = []; selections = [];
      state = { phase: "select", confirmations: [], crops: {}, error: null, canConfirm: false };
      await cleanupJobs();
    },
    async cancel() { controller?.abort(); await cleanupJobs(); },
  };
}
