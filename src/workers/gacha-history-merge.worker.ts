// Private worker for [history reconciliation](../lib/gacha-history-reconcile.ts).
import { matchingHistoryGroups, type HistoryAccountRecord, type HistoryMatchCards } from "../lib/gacha-history-merge";
self.onmessage = (event: MessageEvent<{ records: HistoryAccountRecord[]; cards: HistoryMatchCards }>) => {
  try {
    const { records, cards } = event.data;
    const groups = matchingHistoryGroups(records, cards).map((keys) => ({ keys }));
    self.postMessage({ groups });
  } catch {
    self.postMessage({ error: "history_merge_failed" });
  }
};
