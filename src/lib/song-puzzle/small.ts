// L3 — GEB
// Input: 已校验的 3×3 棋盘、目标、时限与取消回调。
// Output: 双向逐层搜索得到的最短移动序列。
// Pos: [Map](../L2-2.md)；小棋盘精确求解。
// Effects/Dependencies: 本地 CPU；数值状态键，逐层扩展较小前沿并定期让出 Worker。
import { neighbors, type PuzzlePosition } from "./model";
import type { SolveProgress, SolveResult } from "./solver";

export async function solveSmallPuzzle(
  position: PuzzlePosition,
  budgetMs: number,
  progress: (value: SolveProgress) => void,
  cancelled: () => boolean,
): Promise<SolveResult> {
  const start = performance.now(),
    deadline = start + budgetMs,
    powers = Array.from({ length: 9 }, (_, i) => 9 ** i),
    encode = (board: number[]) => board.reduce((key, tile, i) => key + tile * powers[i]!, 0),
    initial = encode(position.tiles),
    goal = encode(position.goal),
    adjacent = Array.from({ length: 9 }, (_, i) => neighbors(i, 3));
  interface Link {
    parent: number;
    tile: number;
    blank: number;
  }
  const forward = new Map<number, Link>([[initial, { parent: -1, tile: 0, blank: position.tiles.indexOf(0) }]]),
    backward = new Map<number, Link>([[goal, { parent: -1, tile: 0, blank: position.goal.indexOf(0) }]]);
  let front = [initial],
    back = [goal],
    nodes = 0,
    bound = 0;
  const result = (status: SolveResult["status"], path: number[] = []): SolveResult => ({
    status,
    path,
    nodes,
    bound,
    elapsedMs: performance.now() - start,
  });
  if (initial === goal) return result("optimal");
  while (front.length && back.length) {
    if (cancelled()) return result("cancelled");
    if (performance.now() >= deadline) return result("budget");
    const expandingForward = front.length <= back.length,
      own = expandingForward ? forward : backward,
      other = expandingForward ? backward : forward,
      layer: number[] = [];
    bound++;
    for (const state of expandingForward ? front : back) {
      if ((++nodes & 1023) === 0) {
        progress({ nodes, bound, elapsedMs: performance.now() - start });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (cancelled()) return result("cancelled");
        if (performance.now() >= deadline) return result("budget");
      }
      const blank = own.get(state)!.blank;
      for (const index of adjacent[blank]!) {
        const tile = Math.floor(state / powers[index]!) % 9,
          next = state + tile * (powers[blank]! - powers[index]!);
        if (own.has(next)) continue;
        own.set(next, { parent: state, tile, blank: index });
        if (other.has(next)) {
          const prefix: number[] = [],
            suffix: number[] = [];
          for (let key = next; forward.get(key)!.parent !== -1; key = forward.get(key)!.parent)
            prefix.push(forward.get(key)!.tile);
          for (let key = next; backward.get(key)!.parent !== -1; key = backward.get(key)!.parent)
            suffix.push(backward.get(key)!.tile);
          const path = [...prefix.reverse(), ...suffix];
          bound = path.length;
          return result("optimal", path);
        }
        layer.push(next);
      }
    }
    if (expandingForward) front = layer;
    else back = layer;
  }
  return result("unsolvable");
}
