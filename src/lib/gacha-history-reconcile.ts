// L3 — GEB
// Input: Owner-scoped or local-only histories and card-prize metadata.
// Output: Proven account groups and normalized history unions.
// Pos: [Map](L2-2.md); browser reconciliation transport shared by local and cloud stores.
// Effects/Dependencies: One short-lived browser worker; no HTTP or game requests.
import type { HistoryAccountRecord, HistoryMatchCards } from "./gacha-history-merge";
export interface HistoryReconciliation {
  keys: string[];
}
export async function reconcileHistories(
  records: readonly HistoryAccountRecord[],
  cards: HistoryMatchCards,
): Promise<HistoryReconciliation[]> {
  if (
    records.length < 2 ||
    !records.some((record, index) =>
      records
        .slice(index + 1)
        .some(
          (other) =>
            record.ownerId === other.ownerId &&
            record.histories[0]?.source.server === other.histories[0]?.source.server,
        ),
    )
  )
    return [];
  const worker = new Worker(new URL("../workers/gacha-history-merge.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<HistoryReconciliation[]>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ groups?: HistoryReconciliation[]; error?: string }>) => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.groups ?? []);
      };
      worker.onerror = () => reject(new Error("history_merge_failed"));
      worker.postMessage({ records, cards });
    });
  } finally {
    worker.terminate();
  }
}
