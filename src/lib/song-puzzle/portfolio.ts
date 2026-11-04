// L3 — GEB
// Input: 原始棋盘、剩余预算、首条合法解与取消／改进回调。
// Output: 八种旋转／镜像分层策略中缩短后的最佳合法路径。
// Pos: [Map](../L2-2.md)；大棋盘的多策略求解与子路径改进。
// Effects/Dependencies: 本地 CPU；每次候选保持同一真实起点与目标，改进后回报完整路径。
import { constructSolution } from "./constructive";
import { shortenSolution } from "./shorten";
import type { PuzzlePosition } from "./model";

export async function improveSolution(
  position: PuzzlePosition,
  initial: number[],
  budgetMs: number,
  cancelled: () => boolean,
  improved: (path: number[]) => void,
): Promise<number[]> {
  const deadline = performance.now() + budgetMs,
    size = position.size;
  let best = await shortenSolution(position, initial, Math.min(150, budgetMs), cancelled);
  if (best.length < initial.length) improved(best);
  for (let orientation = 1; orientation < 8 && !cancelled() && performance.now() < deadline; orientation++) {
    const transform = (board: number[]) => {
      const transformed = new Array<number>(board.length);
      for (let index = 0; index < board.length; index++) {
        let row = Math.floor(index / size),
          col = index % size;
        if (orientation >= 4) col = size - 1 - col;
        for (let turn = 0; turn < orientation % 4; turn++) [row, col] = [col, size - 1 - row];
        transformed[row * size + col] = board[index]!;
      }
      return transformed;
    };
    const result = await constructSolution(
      { size, tiles: transform(position.tiles), goal: transform(position.goal) },
      Math.max(1, Math.min(300, deadline - performance.now())),
      () => {},
      cancelled,
    );
    if ((result.status !== "found" && result.status !== "optimal") || result.path.length >= best.length) continue;
    best = await shortenSolution(
      position,
      result.path,
      Math.min(150, Math.max(0, deadline - performance.now())),
      cancelled,
    );
    improved(best);
  }
  for (let pass = 0; pass < 2 && !cancelled() && performance.now() < deadline; pass++) {
    const before = best.length;
    const shorter = await shortenSolution(
      position,
      best,
      Math.min(400, Math.max(0, deadline - performance.now())),
      cancelled,
      4,
    );
    if (shorter.length < best.length) {
      best = shorter;
      improved(best);
    }
    const reversed = await shortenSolution(
      { ...position, tiles: position.goal, goal: position.tiles },
      [...best].reverse(),
      Math.min(400, Math.max(0, deadline - performance.now())),
      cancelled,
      3,
    );
    if (reversed.length < best.length) {
      best = reversed.reverse();
      improved(best);
    } else if (best.length === before) break;
  }
  return best;
}
