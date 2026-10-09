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
/** Unit-cost IDA*: Manhattan + minimum-removal linear conflict; exact path-cycle pruning. */
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
    cells = board.length,
    cellRows = Uint8Array.from({ length: cells }, (_, index) => Math.floor(index / size)),
    cellColumns = Uint8Array.from({ length: cells }, (_, index) => index % size),
    goalRows = new Uint8Array(cells),
    goalColumns = new Uint8Array(cells),
    distances = new Uint8Array(cells * cells),
    adjacent = Array.from({ length: cells }, (_, index) => neighbors(index, size));
  for (let index = 0; index < cells; index++) {
    const tile = position.goal[index]!;
    goalRows[tile] = cellRows[index]!;
    goalColumns[tile] = cellColumns[index]!;
    if (tile === blankTile) continue;
    for (let cell = 0; cell < cells; cell++) {
      distances[tile * cells + cell] =
        Math.abs(cellRows[cell]! - goalRows[tile]!) + Math.abs(cellColumns[cell]! - goalColumns[tile]!);
    }
  }
  const distance = (tile: number, index: number) => distances[tile * cells + index]!;
  // Tiles which never leave their goal row/column must preserve increasing goal
  // order. At least count-LIS tiles must leave and return. Row penalties charge
  // vertical moves, column penalties horizontal moves, so the axes are disjoint.
  const tails = new Uint8Array(size);
  const lineConflict = (line: number, row: boolean): number => {
    let count = 0,
      length = 0;
    for (let offset = 0; offset < size; offset++) {
      const tile = board[row ? line * size + offset : offset * size + line]!;
      if (tile === blankTile || (row ? goalRows[tile] : goalColumns[tile]) !== line) continue;
      const rank = (row ? goalColumns[tile] : goalRows[tile])!;
      count++;
      let low = 0,
        high = length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tails[middle]! < rank) low = middle + 1;
        else high = middle;
      }
      tails[low] = rank;
      if (low === length) length++;
    }
    return 2 * (count - length);
  };
  const affectedConflict = (first: number, second: number): number => {
    const firstRow = cellRows[first]!,
      secondRow = cellRows[second]!,
      firstColumn = cellColumns[first]!,
      secondColumn = cellColumns[second]!;
    return (
      lineConflict(firstRow, true) +
      (secondRow === firstRow ? 0 : lineConflict(secondRow, true)) +
      lineConflict(firstColumn, false) +
      (secondColumn === firstColumn ? 0 : lineConflict(secondColumn, false))
    );
  };
  let heuristic = board.reduce((sum, tile, index) => sum + distance(tile, index), 0);
  for (let line = 0; line < size; line++) heuristic += lineConflict(line, true) + lineConflict(line, false);
  // Full fixed-width digits are injective for every valid tile permutation.
  // Swapping a nonzero tile with zero updates exactly two digits via XOR.
  const bits = BigInt(Math.ceil(Math.log2(cells))),
    shifts = Array.from({ length: cells }, (_, index) => BigInt(index) * bits),
    tileCodes = Array.from({ length: cells }, (_, tile) => BigInt(tile)),
    rootKey = board.reduce((key, tile, index) => key | (tileCodes[tile]! << shifts[index]!), 0n);
  bound = heuristic;
  const duration = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.max(100, Math.min(120000, budgetMs)) : 15000;
  const deadline = start + duration;
  let stopped: "budget" | "cancelled" | undefined,
    answer: number[] | undefined,
    exceeded = Infinity;
  const path: number[] = [],
    onPath = new Set<bigint>([rootKey]);
  interface Frame {
    blank: number;
    previous: number;
    g: number;
    h: number;
    entered: boolean;
    choices: number[];
    cursor: number;
    key: bigint;
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
        key: rootKey,
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
        frame.choices = adjacent[frame.blank]!.filter((index) => index !== frame.previous).sort(
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
      const key = frame.key ^ (tileCodes[tile]! << shifts[frame.blank]!) ^ (tileCodes[tile]! << shifts[index]!);
      if (onPath.has(key)) continue;
      // Only these unique lines can change their eligible tile ordering.
      const previousConflict = affectedConflict(frame.blank, index);
      [board[frame.blank], board[index]] = [tile, blankTile];
      const childH =
        frame.h -
        distance(tile, index) +
        distance(tile, frame.blank) +
        affectedConflict(frame.blank, index) -
        previousConflict;
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
