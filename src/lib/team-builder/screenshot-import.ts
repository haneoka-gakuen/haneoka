import type { TeamBuilderData } from "./data.ts";
import {
  addInventoryEntries, updateInventoryEntries, upgradeInventory, validateInventory,
  type InventoryV1, type InventoryKind,
} from "./inventory.ts";

export interface ScreenshotRecognitionContext { server: string; releaseId: string; sourceId: string; referenceId: string }
export interface ScreenshotObservation {
  bbox: [number, number, number, number];
  kind: InventoryKind;
  cardId: number | null;
  candidates: { cardId: number; variant: string; score: number; evidence: unknown }[];
  level: { value: number | null; reason: string; evidence?: unknown };
}
export interface ScreenshotRecognitionResult {
  schema: "haneoka-card-recognition-result-v1";
  context: ScreenshotRecognitionContext;
  algorithmVersion: string;
  image: { width: number; height: number; sha256: string };
  status: "candidates" | "no-reliable-grid";
  observations: ScreenshotObservation[];
}
export interface ScreenshotReviewContext { ownerId: string | null; revision: number; server: string; releaseId: string; sourceId: string }
export interface ScreenshotSelection { observation: number; cardId: number | null }
export interface ScreenshotCardProposal {
  key: string;
  kind: InventoryKind;
  cardId: number;
  observations: { image: number; index: number }[];
  existingInstanceId: string | null;
  existingLevel: number | null;
  observedLevels: number[];
  /** Real screenshot imports never supply unseen practice presets. */
  defaultPractice: Readonly<Record<string, number>> | null;
}
export interface ScreenshotImportPreview {
  context: ScreenshotReviewContext;
  original: InventoryV1;
  recognitions: ScreenshotRecognitionResult[];
  cards: ScreenshotCardProposal[];
  rejectedObservations: number[];
}
export interface ScreenshotCardConfirmation {
  key: string;
  include: boolean;
  /** Omitted follows the bulk default; "keep" preserves the saved level explicitly. */
  level?: number | "keep";
  levelSource?: "observed" | "manual";
}

export function screenshotLevelDefault(card: ScreenshotCardProposal, existingValues: "keep" | "overwrite" | "updates" = "keep") {
  if (card.existingInstanceId !== null && (existingValues === "keep" || !card.observedLevels.length))
    return { value: card.existingLevel, source: "saved" as const };
  if (card.observedLevels.length > 1) return { value: null, source: "conflict" as const };
  if (existingValues === "updates" && card.existingInstanceId !== null && card.existingLevel !== null && card.observedLevels.length === 1 && card.observedLevels[0]! < card.existingLevel)
    return { value: card.existingLevel, source: "saved" as const };
  if (card.observedLevels.length === 1) return { value: card.observedLevels[0]!, source: "observed" as const };
  return { value: null, source: "unknown" as const };
}

const int = (value: unknown, low = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= 0x7fffffff;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};
function sameContext(context: ScreenshotReviewContext, data: TeamBuilderData) {
  return context.server === data.identity.server && context.releaseId === data.identity.releaseId && context.sourceId === data.identity.sourceId;
}

/** Review is a pure proposal; it never calls InventoryStore or writes an account.
 * Crop aliases and repeated screenshots converge on (server, kind, cardId).
 * A rejected card may be manually chosen from the current catalogue.
 */
export function previewScreenshotImport(
  current: InventoryV1, data: TeamBuilderData, context: ScreenshotReviewContext,
  recognition: ScreenshotRecognitionResult, selections: readonly ScreenshotSelection[],
): ScreenshotImportPreview {
  if (!sameContext(context, data) || !validateInventory(current, data).valid || !int(context.revision))
    throw new RangeError("screenshot-review-context");
  const source = recognition.context;
  if (
    recognition.schema !== "haneoka-card-recognition-result-v1" || !["candidates", "no-reliable-grid"].includes(recognition.status) ||
    source.server !== context.server || source.releaseId !== context.releaseId || source.sourceId !== context.sourceId ||
    !/^[a-f0-9]{64}$/u.test(source.referenceId) || !/^[a-f0-9]{64}$/u.test(recognition.image.sha256) ||
    !int(recognition.image.width, 128) || !int(recognition.image.height, 128) ||
    recognition.image.width > 4096 || recognition.image.height > 4096 || recognition.image.width * recognition.image.height > 16000000 ||
    recognition.observations.length > 100
  ) throw new RangeError("screenshot-result-context");
  const choices = new Map<number, number | null>();
  for (const selection of selections) {
    if (!int(selection.observation) || selection.observation >= recognition.observations.length || choices.has(selection.observation))
      throw new RangeError("screenshot-selection");
    choices.set(selection.observation, selection.cardId);
  }
  const cards = new Map<string, ScreenshotCardProposal>(), rejected: number[] = [];
  for (const [index, observation] of recognition.observations.entries()) {
    const [x, y, width, height] = observation.bbox;
    if (
      !["members", "snapshots"].includes(observation.kind) || observation.bbox.length !== 4 ||
      !int(x) || !int(y) || !int(width, 1) || !int(height, 1) ||
      x + width > recognition.image.width || y + height > recognition.image.height ||
      observation.candidates.length > 5 || observation.candidates.some(candidate => !int(candidate.cardId, 1) || !Number.isFinite(candidate.score)) ||
      (observation.level.value !== null && !int(observation.level.value, 1))
    ) throw new RangeError("screenshot-observation");
    const chosen = choices.get(index) ?? null;
    const catalog = observation.kind === "members" ? data.members : data.snapshots;
    if (chosen === null) { rejected.push(index); continue; }
    if (!int(chosen, 1) || !catalog[String(chosen)]) throw new RangeError("screenshot-card-not-in-catalog");
    const key = `${context.server}:${observation.kind}:${chosen}`;
    let proposal = cards.get(key);
    if (!proposal) {
      const owned = current[observation.kind].find(entry => entry.cardId === chosen);
      proposal = { key, kind: observation.kind, cardId: chosen, observations: [],
        existingInstanceId: owned?.instanceId ?? null, existingLevel: owned?.level ?? null, observedLevels: [],
        defaultPractice: null };
      cards.set(key, proposal);
    }
    proposal.observations.push({ image: 0, index });
    if (observation.level.value !== null && !proposal.observedLevels.includes(observation.level.value))
      proposal.observedLevels.push(observation.level.value);
  }
  return { context: { ...context }, original: structuredClone(current), recognitions: [structuredClone(recognition)],
    cards: [...cards.values()], rejectedObservations: rejected };
}

export function previewScreenshotImportBatch(
  current: InventoryV1, data: TeamBuilderData, context: ScreenshotReviewContext,
  recognitions: readonly ScreenshotRecognitionResult[],
  selections: readonly (ScreenshotSelection & { image: number })[],
): ScreenshotImportPreview {
  if (!recognitions.length || recognitions.length > 8 || selections.some(selection => !int(selection.image) || selection.image >= recognitions.length))
    throw new RangeError("screenshot-batch");
  const cards = new Map<string, ScreenshotCardProposal>(), rejected: number[] = [];
  for (const [image, recognition] of recognitions.entries()) {
    const preview = previewScreenshotImport(current, data, context, recognition, selections.filter(selection => selection.image === image));
    for (const proposal of preview.cards) {
      const previous = cards.get(proposal.key);
      const observations = proposal.observations.map(value => ({ ...value, image }));
      if (previous) {
        previous.observations.push(...observations);
        previous.observedLevels = [...new Set([...previous.observedLevels, ...proposal.observedLevels])];
      } else cards.set(proposal.key, { ...proposal, observations });
    }
    rejected.push(...preview.rejectedObservations.map(index => image * 100 + index));
  }
  return { context: { ...context }, original: structuredClone(current), recognitions: recognitions.map(value => structuredClone(value)),
    cards: [...cards.values()], rejectedObservations: rejected };
}

/** Only explicit confirmation creates/changes owned cards. Unseen fields stay unknown;
 * a confirmed observed/manual level is applied without inferring other practice.
 * Existing cards retain unseen practice and all flags/player maps. A changed
 * account/revision/source or inventory requires review again.
 */
export function applyConfirmedScreenshotImport(
  preview: ScreenshotImportPreview, current: InventoryV1, data: TeamBuilderData,
  context: ScreenshotReviewContext, confirmations: readonly ScreenshotCardConfirmation[],
  existingValues: "keep" | "overwrite" | "updates" = "keep",
): InventoryV1 {
  if (!sameContext(context, data) || canonical(context) !== canonical(preview.context) ||
      canonical(current) !== canonical(preview.original) || !validateInventory(current, data).valid)
    throw new RangeError("screenshot-review-stale");
  const seen = new Set<string>();
  const accepted = confirmations.filter(confirmation => {
    if (seen.has(confirmation.key) || !preview.cards.some(card => card.key === confirmation.key))
      throw new RangeError("screenshot-confirmation");
    seen.add(confirmation.key);
    return confirmation.include;
  });
  if (!accepted.length) return current;
  let next: InventoryV1 = upgradeInventory(current);
  for (const confirmation of accepted) {
    const card = preview.cards.find(value => value.key === confirmation.key)!;
    if (screenshotLevelDefault(card, existingValues).source === "conflict" && confirmation.level === undefined)
      throw new RangeError("screenshot-level-conflict-confirmation-required");
    if (confirmation.level === "keep" && card.existingInstanceId === null)
      throw new RangeError("screenshot-level-evidence-required");
    if (confirmation.level !== undefined && confirmation.level !== "keep" && (!int(confirmation.level, 1) ||
        (confirmation.levelSource !== "manual" && !card.observedLevels.includes(confirmation.level))))
      throw new RangeError("screenshot-level-evidence-required");
    next = addInventoryEntries(next, card.kind, [{ cardId: card.cardId }], data);
    const level = confirmation.level === "keep" ? undefined : confirmation.level ??
      ((!card.existingInstanceId || existingValues === "overwrite") && card.observedLevels.length === 1 ? card.observedLevels[0] : undefined);
    if (level !== undefined) {
      const entry = next[card.kind].find(value => value.cardId === card.cardId)!;
      next = updateInventoryEntries(next, card.kind, [entry.instanceId], { level });
    }
  }
  const checked = validateInventory(next, data);
  if (!checked.valid) throw new RangeError(`screenshot-practice-review:${checked.issues[0]?.path}`);
  return canonical(next) === canonical(upgradeInventory(current)) ? current : next;
}
