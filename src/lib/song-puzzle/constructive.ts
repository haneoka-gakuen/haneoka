// L3 — GEB
// Input: 已校验可解的棋盘、总剩余时限、进度及取消回调。
// Output: 分层归位的合法移动序列，或取消／预算状态；不宣称最短。
// Pos: [Map](../L2-2.md)；大棋盘分层归位、成对边界放置和 3×3 双向搜索。
// Effects/Dependencies: 本地 CPU 和有界抽象状态队列；定期让出 Worker，支持任意目标空格。
import { neighbors, type PuzzlePosition } from "./model";
import type { SolveProgress, SolveResult } from "./solver";

class SearchStopped extends Error {
  constructor(readonly status: "budget" | "cancelled") {
    super(status);
  }
}

/** Parberry-style row/column reduction, with abstract routing instead of fixed move macros. */
export async function constructSolution(
  position: PuzzlePosition,
  budgetMs: number,
  progress: (value: SolveProgress) => void,
  cancelled: () => boolean,
): Promise<SolveResult> {
  const start = performance.now(),
    deadline = start + budgetMs,
    size = position.size,
    cells = size * size,
    board = [...position.tiles],
    target = [...position.goal],
    adjacent = Array.from({ length: cells }, (_, i) => neighbors(i, size)),
    positions = new Uint8Array(cells),
    locked = new Uint8Array(cells),
    shifts = Array.from({ length: cells }, (_, i) => BigInt(i * Math.ceil(Math.log2(cells))));
  for (let i = 0; i < cells; i++) positions[board[i]] = i;
  const ranks = new Map(position.goal.map((tile, index) => [tile, index]));
  const bound = board.reduce(
    (sum, tile, index) =>
      tile
        ? sum +
          Math.abs(Math.floor(index / size) - Math.floor(ranks.get(tile)! / size)) +
          Math.abs((index % size) - (ranks.get(tile)! % size))
        : sum,
    0,
  );
  let nodes = 0,
    lastYield = start,
    blank = positions[0],
    key = board.reduce((value, tile, index) => value | (BigInt(tile) << shifts[index]), 0n);
  const path: number[] = [],
    states: bigint[] = [key],
    seen = new Map<bigint, number>([[key, 0]]);
  const result = (status: SolveResult["status"], answer: number[] = []): SolveResult => ({
    status,
    path: answer,
    nodes,
    bound,
    elapsedMs: performance.now() - start,
  });
  const checkpoint = async () => {
    if (cancelled()) throw new SearchStopped("cancelled");
    if (performance.now() >= deadline) throw new SearchStopped("budget");
    progress({ nodes, bound, elapsedMs: performance.now() - start });
    if (performance.now() - lastYield >= 16) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  };
  const move = (index: number) => {
    const tile = board[index];
    key ^= (BigInt(tile) << shifts[index]) ^ (BigInt(tile) << shifts[blank]);
    board[blank] = tile;
    board[index] = 0;
    positions[tile] = blank;
    positions[0] = index;
    blank = index;
    const previous = seen.get(key);
    if (previous !== undefined) {
      for (let i = previous + 1; i < states.length; i++) seen.delete(states[i]);
      states.length = previous + 1;
      path.length = previous;
    } else {
      path.push(tile);
      states.push(key);
      seen.set(key, path.length);
    }
  };
  // Move the goal blank to the corner, then undo this goal-only path after solving.
  const restore: number[] = [];
  let goalBlank = target.indexOf(0);
  while (goalBlank !== cells - 1) {
    const next = goalBlank % size < size - 1 ? goalBlank + 1 : goalBlank + size;
    restore.push(target[next]);
    [target[goalBlank], target[next]] = [target[next], 0];
    goalBlank = next;
  }
  const parents = new Int32Array(cells * cells * cells),
    queue = new Uint32Array(parents.length);
  const place = async (destinations: number[]) => {
    const first = target[destinations[0]],
      second = destinations.length === 2 ? target[destinations[1]] : undefined;
    if (positions[first] === destinations[0] && (second === undefined || positions[second] === destinations[1])) {
      for (const cell of destinations) locked[cell] = 1;
      return;
    }
    await checkpoint();
    const pair = second !== undefined,
      encode = (a: number, b: number, z: number) => (pair ? (a * cells + b) * cells + z : a * cells + z),
      root = encode(positions[first], pair ? positions[second!] : 0, blank);
    parents.fill(-1, 0, pair ? parents.length : cells * cells);
    parents[root] = root;
    queue[0] = root;
    let head = 0,
      tail = 1,
      found = -1;
    while (head < tail) {
      const state = queue[head++],
        z = state % cells,
        q = Math.floor(state / cells),
        a = pair ? Math.floor(q / cells) : q,
        b = pair ? q % cells : 0;
      if ((++nodes & 4095) === 0) await checkpoint();
      if (a === destinations[0] && (!pair || b === destinations[1])) {
        found = state;
        break;
      }
      for (const next of adjacent[z]) {
        if (locked[next]) continue;
        const nextKey = encode(next === a ? z : a, pair && next === b ? z : b, next);
        if (parents[nextKey] !== -1) continue;
        parents[nextKey] = state;
        queue[tail++] = nextKey;
      }
    }
    if (found < 0) throw new Error("No layer placement path");
    const route: number[] = [];
    for (let state = found; state !== root; state = parents[state]) route.push(state % cells);
    for (const next of route.reverse()) move(next);
    for (const cell of destinations) locked[cell] = 1;
  };
  try {
    for (let layer = 0; layer < size - 3; layer++) {
      for (let col = layer; col < size - 2; col++) await place([layer * size + col]);
      await place([layer * size + size - 2, layer * size + size - 1]);
      for (let row = layer + 1; row < size - 2; row++) await place([row * size + layer]);
      await place([(size - 2) * size + layer, (size - 1) * size + layer]);
    }
    const remaining = Array.from({ length: 9 }, (_, i) => (size - 3 + Math.floor(i / 3)) * size + size - 3 + (i % 3)),
      goalTiles = remaining.map((index) => target[index]),
      codes = new Map(goalTiles.map((tile, index) => [tile, tile === 0 ? 0 : index + 1])),
      powers = Array.from({ length: 9 }, (_, i) => 9 ** i),
      initial = remaining.reduce((value, index, i) => value + codes.get(board[index])! * powers[i], 0),
      goal = goalTiles.reduce((value, tile, i) => value + codes.get(tile)! * powers[i], 0);
    if (initial !== goal) {
      interface Link {
        parent: number;
        tile: number;
        blank: number;
      }
      const forward = new Map<number, Link>([[initial, { parent: -1, tile: 0, blank: remaining.indexOf(blank) }]]),
        backward = new Map<number, Link>([[goal, { parent: -1, tile: 0, blank: 8 }]]),
        localAdjacent = Array.from({ length: 9 }, (_, i) => neighbors(i, 3));
      let front = [initial],
        back = [goal],
        meeting: number | undefined;
      while (front.length && back.length && meeting === undefined) {
        const expandingForward = front.length <= back.length,
          own = expandingForward ? forward : backward,
          other = expandingForward ? backward : forward,
          nextLayer: number[] = [];
        for (const state of expandingForward ? front : back) {
          if ((++nodes & 4095) === 0) await checkpoint();
          const z = own.get(state)!.blank;
          for (const next of localAdjacent[z]) {
            const tile = Math.floor(state / powers[next]) % 9,
              nextKey = state + tile * (powers[z] - powers[next]);
            if (own.has(nextKey)) continue;
            own.set(nextKey, { parent: state, tile, blank: next });
            nextLayer.push(nextKey);
            if (other.has(nextKey)) {
              meeting = nextKey;
              break;
            }
          }
          if (meeting !== undefined) break;
        }
        if (expandingForward) front = nextLayer;
        else back = nextLayer;
      }
      if (meeting === undefined) throw new Error("No final puzzle path");
      const prefix: number[] = [],
        suffix: number[] = [];
      for (let state = meeting; forward.get(state)!.parent !== -1; state = forward.get(state)!.parent)
        prefix.push(forward.get(state)!.tile);
      for (let state = meeting; backward.get(state)!.parent !== -1; state = backward.get(state)!.parent)
        suffix.push(backward.get(state)!.tile);
      for (const tile of [...prefix.reverse(), ...suffix]) move(positions[goalTiles[tile - 1]]);
    }
    for (const tile of restore.reverse()) move(positions[tile]);
    await checkpoint();
    return result(path.length === bound ? "optimal" : "found", path);
  } catch (error) {
    if (error instanceof SearchStopped) return result(error.status);
    throw error;
  }
}
