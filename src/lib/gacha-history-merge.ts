// L3 — GEB
// Input: Portable histories, owner-scoped account records and published card-prize identities.
// Output: Lossless multiset unions and account groups supported by stable identity or repeated card draws.
// Pos: [Map](L2-2.md); history identity reconciliation shared by browser and maintenance commands.
// Effects/Dependencies: Pure calculations; no network, credentials or game calls.
import type { HistoryExecution, HistoryRegion, HistorySnapshot } from "@haneoka/game-data-exporter/gacha-history";

export interface HistoryAccountRecord {
  key: string;
  ownerId?: string;
  aliases?: readonly string[];
  histories: readonly HistorySnapshot[];
}
export type HistoryMatchCards = Partial<Record<HistoryRegion, readonly string[]>>;
const COSTS = ["freeGems", "paidGems", "tickets"] as const;
const prizeIds = (row: HistoryExecution) => row.prizes.map((prize) => prize.prizeId).sort();
const convertedIds = (row: HistoryExecution) =>
  row.prizes
    .map((prize) => `${prize.prizeId}:${prize.converted}`)
    .sort()
    .join(",");
const core = (row: HistoryExecution) => JSON.stringify([row.poolId, row.executedAt, prizeIds(row)]);

/** Missing product/cost metadata is enriched without collapsing repeated identical draws. */
function mergeBatches(newer: readonly HistoryExecution[], older: readonly HistoryExecution[]): HistoryExecution[] {
  const out = [...newer],
    available = new Map<string, number[]>();
  const identity = (row: HistoryExecution) =>
    row.executedAt === null
      ? JSON.stringify([row.poolId, row.productId, ...COSTS.map((key) => row[key]), convertedIds(row)])
      : core(row);
  for (let i = 0; i < newer.length; i++) {
    const key = identity(newer[i]!);
    const list = available.get(key) ?? [];
    list.push(i);
    available.set(key, list);
  }
  const used = new Set<number>();
  for (const row of older) {
    const indexes = available.get(identity(row)) ?? [];
    const compatible = indexes.filter(
      (index) =>
        !used.has(index) &&
        (out[index]!.productId === null || row.productId === null || out[index]!.productId === row.productId) &&
        COSTS.every((key) => out[index]![key] === null || row[key] === null || out[index]![key] === row[key]),
    );
    const index = compatible.find((index) => convertedIds(out[index]!) === convertedIds(row)) ?? compatible[0];
    if (index === undefined) {
      out.push(row);
      continue;
    }
    used.add(index);
    const current = out[index]!;
    out[index] = {
      ...current,
      productId: current.productId ?? row.productId,
      freeGems: current.freeGems ?? row.freeGems,
      paidGems: current.paidGems ?? row.paidGems,
      tickets: current.tickets ?? row.tickets,
    };
  }
  return out;
}

export function mergeHistoryCollection(
  stored: readonly HistorySnapshot[],
  incoming: HistorySnapshot,
): HistorySnapshot[] {
  const snapshots = [...stored, incoming].sort((a, b) => Date.parse(b.queriedAt) - Date.parse(a.queriedAt));
  const server = incoming.source.server;
  const identities = new Set(snapshots.flatMap((value) => (value.source.accountKey ? [value.source.accountKey] : [])));
  if (identities.size > 1 || snapshots.some((value) => value.source.server !== server))
    throw new Error("history_import_invalid");
  const accountKey = identities.values().next().value;
  const accountState = snapshots.reduce<HistorySnapshot["accountState"]>(
    (latest, value) =>
      value.accountState && (!latest || Date.parse(value.accountState.collectedAt) > Date.parse(latest.collectedAt))
        ? value.accountState
        : latest,
    undefined,
  );
  const kinds = new Map<string, HistorySnapshot>();
  const empty = snapshots.find((value) => !value.batches.length);
  for (const snapshot of snapshots) {
    if (!snapshot.batches.length && snapshots.some((value) => value.batches.length)) continue;
    const previous = kinds.get(snapshot.historyKind);
    if (previous) {
      const batches = mergeBatches(previous.batches, snapshot.batches);
      kinds.set(snapshot.historyKind, {
        ...previous,
        batches,
        coverage: { ...previous.coverage, scope: "local-collected" },
      });
    } else {
      const header = empty && Date.parse(empty.queriedAt) > Date.parse(snapshot.queriedAt) ? empty : snapshot;
      const source = { ...header.source };
      if (accountKey) source.accountKey = accountKey;
      else delete source.accountKey;
      kinds.set(snapshot.historyKind, {
        ...header,
        source,
        historyKind: snapshot.historyKind,
        batches: snapshot.batches,
        ...(accountState ? { accountState } : {}),
      });
    }
  }
  return [...kinds.values()]
    .map((value) => (accountState ? { ...value, accountState } : value))
    .sort((a, b) =>
      a.historyKind === "execution" && b.historyKind !== "execution"
        ? -1
        : b.historyKind === "execution" && a.historyKind !== "execution"
          ? 1
          : Date.parse(b.queriedAt) - Date.parse(a.queriedAt),
    );
}

export function mergeAccountHistories(records: readonly HistoryAccountRecord[], canonical: string): HistorySnapshot[] {
  let out: HistorySnapshot[] = [];
  for (const record of records)
    for (const history of record.histories)
      out = mergeHistoryCollection(out, { ...history, source: { ...history.source, accountKey: canonical } });
  return out;
}

/** Card metadata excludes deterministic item draws from identity evidence. */
export function historyMatchCards(catalogs: Record<string, { prizes?: unknown } | undefined>): HistoryMatchCards {
  const cards = (server: string) =>
    Object.entries((catalogs[server]?.prizes ?? {}) as Record<string, { resourceType?: number }>)
      .filter(([, value]) => value.resourceType === 2 || value.resourceType === 3)
      .map(([id]) => id);
  const intl = cards("intl");
  return { jp: cards("jp"), "global-hmt": intl, "global-en": intl, "global-kr": intl };
}

/** No association is inferred from a shared website owner or server alone. */
export function matchingHistoryGroups(
  records: readonly HistoryAccountRecord[],
  cardIds: HistoryMatchCards,
): string[][] {
  const parent = records.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
  const join = (a: number, b: number) => {
    parent[root(a)] = root(b);
  };
  const known = new Map<string, number>();
  const cards = new Map(Object.entries(cardIds).map(([region, ids]) => [region, new Set(ids)]));
  const index = new Map<string, Array<{ record: number; batch: HistoryExecution; ids: string[] }>>();
  const counts = records.map(() => 0);
  const pairs = new Map<
    string,
    {
      a: number;
      b: number;
      matches: Set<string>;
      multi: Set<string>;
      times: Set<number>;
      days: Set<number>;
      cards: Set<string>;
    }
  >();
  for (const [i, record] of records.entries()) {
    const seen = new Set<string>();
    for (const history of record.histories) {
      const scope = `${record.ownerId ?? ""}\0${history.source.server}\0`;
      for (const key of new Set([
        record.key,
        ...(record.aliases ?? []),
        ...(history.source.accountKey ? [history.source.accountKey] : []),
      ])) {
        const identity = scope + key;
        if (known.has(identity)) join(i, known.get(identity)!);
        else known.set(identity, i);
      }
      const eligible = cards.get(history.source.server);
      if (!eligible?.size) continue;
      for (const batch of history.batches) {
        if (batch.executedAt === null || batch.executedAt <= 0) continue;
        const ids = batch.prizes.filter((prize) => eligible.has(prize.prizeId)).map((prize) => prize.prizeId);
        if (!ids.length) continue;
        const signature = scope + history.historyKind + "\0" + core(batch);
        if (seen.has(signature)) continue;
        seen.add(signature);
        counts[i] = counts[i]! + 1;
        const previous = index.get(signature) ?? [];
        for (const other of previous) {
          if (
            other.record === i ||
            (other.batch.productId !== null && batch.productId !== null && other.batch.productId !== batch.productId)
          )
            continue;
          const key = `${other.record}:${i}`;
          let match = pairs.get(key);
          if (!match) {
            match = {
              a: other.record,
              b: i,
              matches: new Set(),
              multi: new Set(),
              times: new Set(),
              days: new Set(),
              cards: new Set(),
            };
            pairs.set(key, match);
          }
          match.matches.add(signature);
          match.times.add(batch.executedAt);
          match.days.add(Math.floor(batch.executedAt / 86400));
          for (const id of ids) match.cards.add(id);
          if (ids.length >= 3) match.multi.add(signature);
        }
        previous.push({ record: i, batch, ids });
        index.set(signature, previous);
      }
    }
  }
  for (const match of pairs.values()) {
    const multi = match.multi.size >= 3 && match.times.size >= 3 && match.cards.size >= 5;
    const single =
      match.matches.size >= 20 &&
      match.days.size >= 5 &&
      match.cards.size >= 8 &&
      match.matches.size / Math.min(counts[match.a]!, counts[match.b]!) >= 0.25;
    if (multi || single) join(match.a, match.b);
  }
  const groups = new Map<number, string[]>();
  records.forEach((record, i) => {
    const key = root(i),
      values = groups.get(key) ?? [];
    values.push(record.key);
    groups.set(key, values);
  });
  return [...groups.values()].map((values) => [...new Set(values)]).filter((values) => values.length > 1);
}

/** Remote canonical identities supersede old local merge directions. */
export function resolveHistoryAccountKey(
  key: string,
  local: readonly { key: string; aliases?: readonly string[] | undefined }[],
  cloud: readonly { accountKey: string; aliases?: readonly string[] | undefined }[],
  matches: ReadonlyMap<string, string>,
): string {
  const aliases = new Map<string, string>();
  for (const row of local) for (const alias of row.aliases ?? []) aliases.set(alias, row.key);
  for (const row of cloud) for (const alias of row.aliases ?? []) aliases.set(alias, row.accountKey);
  for (const [alias, target] of matches) if (!aliases.has(alias)) aliases.set(alias, target);
  for (const row of cloud) aliases.delete(row.accountKey);
  const seen = new Set<string>();
  while (aliases.has(key) && !seen.has(key)) {
    seen.add(key);
    key = aliases.get(key)!;
  }
  return key;
}
