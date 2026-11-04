// L3 — GEB
// Input: 棋盘快照、预算、速度／步数策略与进度／取消回调。
// Output: 已证最短解、可行解或明确的无解／取消／预算状态。
// Pos: [Map](../L2-2.md)；拼图求解入口与大小棋盘策略。
// Effects/Dependencies: 本地 CPU；精确搜索与完整后备解、多方向分层归位和局部精确缩短。
import { solvable, validPosition, type PuzzlePosition } from "./model";
import { constructSolution } from "./constructive";
import { solveSmallPuzzle } from "./small";
import { improveSolution } from "./portfolio";
import { solveExactPuzzle } from "./exact";
export interface SolveProgress {
  nodes: number;
  bound: number;
  elapsedMs: number;
  path?: number[];
}
export interface SolveResult extends SolveProgress {
  status: "optimal" | "found" | "budget" | "cancelled" | "unsolvable" | "invalid";
  path: number[];
}
export async function solvePuzzle(
  position: PuzzlePosition,
  budgetMs: number,
  progress: (value: SolveProgress) => void,
  cancelled: () => boolean,
  options: { quality?: "fast" | "short" } = {},
): Promise<SolveResult> {
  const start = performance.now(),
    duration = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.max(100, Math.min(120000, budgetMs)) : 15000;
  if (!validPosition(position))
    return { status: "invalid", path: [], nodes: 0, bound: 0, elapsedMs: performance.now() - start };
  if (!solvable(position))
    return { status: "unsolvable", path: [], nodes: 0, bound: 0, elapsedMs: performance.now() - start };
  if (position.tiles.every((tile, i) => tile === position.goal[i]))
    return { status: "optimal", path: [], nodes: 0, bound: 0, elapsedMs: performance.now() - start };
  if (position.size === 3) return solveSmallPuzzle(position, duration, progress, cancelled);
  const remaining = () => Math.max(0, duration - (performance.now() - start));
  if (position.size === 4) {
    const first = await constructSolution(position, Math.min(500, remaining() * 0.25), progress, cancelled);
    if (first.status !== "found" && first.status !== "optimal") return first;
    progress({ ...first, path: first.path });
    if (first.status === "optimal") return first;
    const candidate =
      options.quality === "fast"
        ? first.path
        : await improveSolution(position, first.path, Math.min(200, remaining() * 0.1), cancelled, (path) =>
            progress({ ...first, path, elapsedMs: performance.now() - start }),
          );
    if (cancelled()) return { ...first, status: "cancelled", elapsedMs: performance.now() - start };
    const exact = await solveExactPuzzle(
      position,
      options.quality === "fast" ? Math.min(500, remaining()) : remaining(),
      (value) => progress({ ...value, nodes: first.nodes + value.nodes, elapsedMs: performance.now() - start }),
      cancelled,
      candidate,
    );
    return {
      ...exact,
      path: exact.status === "optimal" ? exact.path : candidate,
      status: exact.status === "budget" ? "found" : exact.status,
      nodes: first.nodes + exact.nodes,
      elapsedMs: performance.now() - start,
    };
  }
  const exact = await solveExactPuzzle(position, Math.min(40, duration * 0.1), progress, cancelled);
  if (exact.status !== "budget" || performance.now() - start >= duration) return exact;
  const solution = await constructSolution(
    position,
    duration - (performance.now() - start),
    (value) =>
      progress({
        ...value,
        bound: Math.max(value.bound, exact.bound),
        nodes: value.nodes + exact.nodes,
        elapsedMs: performance.now() - start,
      }),
    cancelled,
  );
  const bound = Math.max(exact.bound, solution.bound);
  if (solution.status === "found" || solution.status === "optimal")
    progress({ ...solution, bound, path: solution.path, elapsedMs: performance.now() - start });
  const path =
    solution.status === "found"
      ? options.quality === "fast"
        ? solution.path
        : await improveSolution(position, solution.path, Math.min(1500, remaining()), cancelled, (path) =>
            progress({ ...solution, bound, path, elapsedMs: performance.now() - start }),
          )
      : solution.path;
  return {
    ...solution,
    path,
    bound,
    nodes: solution.nodes + exact.nodes,
    elapsedMs: performance.now() - start,
    status: cancelled()
      ? "cancelled"
      : solution.status === "found" && path.length === bound
        ? "optimal"
        : solution.status,
  };
}
