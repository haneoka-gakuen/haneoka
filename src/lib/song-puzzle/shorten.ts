// L3 — GEB
// Input: 合法解路径、原始棋盘、剩余时限与取消回调。
// Output: 端点相同、以 3×3 最短子路径缩短的合法解。
// Pos: [Map](../L2-2.md)；分层解的局部路径优化。
// Effects/Dependencies: 本地 CPU；只替换完全位于同一窗口内的连续移动。
import { solveSmallPuzzle } from "./small";
import { solveExactPuzzle } from "./exact";
import type { PuzzlePosition } from "./model";

export async function shortenSolution(
  position: PuzzlePosition,
  path: number[],
  budgetMs: number,
  cancelled: () => boolean,
  window = 3,
): Promise<number[]> {
  const deadline = performance.now() + budgetMs,
    board = [...position.tiles],
    result: number[] = [],
    size = position.size;
  let cursor = 0,
    blank = board.indexOf(0);
  while (cursor < path.length) {
    if (cancelled() || performance.now() >= deadline) return [...result, ...path.slice(cursor)];
    let minRow = Math.floor(blank / size),
      maxRow = minRow,
      minCol = blank % size,
      maxCol = minCol,
      end = cursor;
    const before = [...board];
    while (end < path.length) {
      const index = board.indexOf(path[end]!),
        row = Math.floor(index / size),
        col = index % size;
      const r0 = Math.min(minRow, row),
        r1 = Math.max(maxRow, row),
        c0 = Math.min(minCol, col),
        c1 = Math.max(maxCol, col);
      if (r1 - r0 >= window || c1 - c0 >= window) break;
      minRow = r0;
      maxRow = r1;
      minCol = c0;
      maxCol = c1;
      [board[blank], board[index]] = [board[index]!, 0];
      blank = index;
      end++;
    }
    let segment = path.slice(cursor, end);
    if (segment.length > (window === 3 ? 6 : 10)) {
      const row = Math.min(minRow, size - window),
        col = Math.min(minCol, size - window),
        indices = Array.from(
          { length: window * window },
          (_, i) => (row + Math.floor(i / window)) * size + col + (i % window),
        ),
        original = indices.map((i) => before[i]!),
        target = indices.map((i) => board[i]!),
        values = [0, ...original.filter(Boolean)],
        ranks = new Map(values.map((tile, i) => [tile, i]));
      const local = {
        size: window,
        tiles: original.map((tile) => ranks.get(tile)!),
        goal: target.map((tile) => ranks.get(tile)!),
      };
      const duration = Math.min(window === 3 ? 30 : 50, Math.max(1, deadline - performance.now()));
      const exact =
        window === 3
          ? await solveSmallPuzzle(local, duration, () => {}, cancelled)
          : await solveExactPuzzle(
              local,
              duration,
              () => {},
              cancelled,
              segment.map((tile) => ranks.get(tile)!),
            );
      if (exact.status === "optimal" && exact.path.length < segment.length)
        segment = exact.path.map((tile) => values[tile]!);
    }
    result.push(...segment);
    cursor = end;
  }
  return result;
}
