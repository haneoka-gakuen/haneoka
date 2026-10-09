import { neighbors, solvable, validPosition, type PuzzlePosition } from "./model";
export interface SolveProgress {
  nodes: number;
  bound: number;
  elapsedMs: number;
}
export interface SolveResult extends SolveProgress {
  status: "optimal" | "budget" | "cancelled" | "unsolvable" | "invalid";
  path: number[];
}
/** Unit-cost IDA*: only admissible nonblank Manhattan, exact path-cycle pruning. */
export async function solvePuzzle(
  position: PuzzlePosition,
  budgetMs: number,
  progress: (value: SolveProgress) => void,
  cancelled: () => boolean,
): Promise<SolveResult> {
  const start = performance.now();
  let nodes = 0,
    bound = 0;
  const result = (status: SolveResult["status"], path: number[] = []): SolveResult => ({
    status,
    path,
    nodes,
    bound,
    elapsedMs: performance.now() - start,
  });
  if (!validPosition(position)) return result("invalid");
  if (!solvable(position)) return result("unsolvable");
  const size = position.size,
    blankTile = 0;
  const board = [...position.tiles],
    target = new Map(position.goal.map((tile, index) => [tile, index]));
  const distance = (tile: number, index: number) =>
    Math.abs(Math.floor(index / size) - Math.floor(target.get(tile)! / size)) +
    Math.abs((index % size) - (target.get(tile)! % size));
  const heuristic = board.reduce((sum, tile, index) => sum + (tile === blankTile ? 0 : distance(tile, index)), 0);
  bound = heuristic;
  const duration = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.max(100, Math.min(120000, budgetMs)) : 15000;
  const deadline = start + duration;
  let stopped: "budget" | "cancelled" | undefined,
    answer: number[] | undefined,
    exceeded = Infinity;
  const path: number[] = [],
    onPath = new Set<string>([board.join(",")]);
  interface Frame {
    blank: number;
    previous: number;
    g: number;
    h: number;
    entered: boolean;
    choices: number[];
    cursor: number;
    key: string;
    undo?: { index: number; blank: number; tile: number };
  }
  function* visit(): Generator<void> {
    const frames: Frame[] = [
      {
        blank: board.indexOf(blankTile),
        previous: -1,
        g: 0,
        h: heuristic,
        entered: false,
        choices: [],
        cursor: 0,
        key: board.join(","),
      },
    ];
    const pop = () => {
      const frame = frames.pop()!;
      if (frame.undo) {
        board[frame.undo.index] = frame.undo.tile;
        board[frame.undo.blank] = blankTile;
        onPath.delete(frame.key);
        path.pop();
      }
    };
    while (frames.length) {
      if (cancelled()) {
        stopped = "cancelled";
        return;
      }
      if (performance.now() >= deadline || nodes >= 5000000) {
        stopped = "budget";
        return;
      }
      const frame = frames.at(-1)!;
      if (!frame.entered) {
        const f = frame.g + frame.h;
        if (f > bound) {
          exceeded = Math.min(exceeded, f);
          pop();
          continue;
        }
        nodes++;
        frame.entered = true;
        if (frame.h === 0) {
          answer = [...path];
          return;
        }
        frame.choices = neighbors(frame.blank, size)
          .filter((index) => index !== frame.previous)
          .sort(
            (a, b) =>
              distance(board[a]!, frame.blank) -
              distance(board[a]!, a) -
              distance(board[b]!, frame.blank) +
              distance(board[b]!, b),
          );
        if (nodes % 2048 === 0) yield;
      }
      if (frame.cursor >= frame.choices.length) {
        pop();
        continue;
      }
      const index = frame.choices[frame.cursor++]!,
        tile = board[index]!;
      const childH = frame.h - distance(tile, index) + distance(tile, frame.blank);
      [board[frame.blank], board[index]] = [tile, blankTile];
      const key = board.join(",");
      if (onPath.has(key)) {
        [board[index], board[frame.blank]] = [tile, blankTile];
        continue;
      }
      onPath.add(key);
      path.push(tile);
      frames.push({
        blank: index,
        previous: frame.blank,
        g: frame.g + 1,
        h: childH,
        entered: false,
        choices: [],
        cursor: 0,
        key,
        undo: { index, blank: frame.blank, tile },
      });
    }
  }
  while (true) {
    exceeded = Infinity;
    for (const _ of visit()) {
      progress({ nodes, bound, elapsedMs: performance.now() - start });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (answer) return result("optimal", answer);
    if (stopped) return result(stopped);
    if (!Number.isFinite(exceeded)) return result("budget");
    bound = exceeded;
    progress({ nodes, bound, elapsedMs: performance.now() - start });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
