// L3 — GEB
// Input: 已校验的棋盘、搜索预算、进度／取消回调及可选合法上界路径。
// Output: 已证最短解或预算／取消状态。
// Pos: [Map](../L2-2.md)；IDA* 精确搜索与可采纳的组合下界。
// Effects/Dependencies: 本地 CPU；4 阶用双 Uint32 状态、Walking Distance 与按需 5-5-5 模式库。
import { neighbors, solvable, validPosition, type PuzzlePosition } from "./model";
import { walkingTable, WALKING_POWERS } from "./walking";
import { puzzlePatterns, type PuzzlePatterns } from "./patterns";
import type { SolveProgress, SolveResult } from "./solver";
/** Unit-cost IDA*: Manhattan + minimum-removal linear conflict, exact keys and bounded transpositions. */
export async function solveExactPuzzle(
  position: PuzzlePosition,
  budgetMs: number,
  progress: (value: SolveProgress) => void,
  cancelled: () => boolean,
  incumbent?: number[],
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
  const duration = Number.isFinite(budgetMs) ? Math.max(1, Math.min(120000, budgetMs)) : 15000,
    deadline = start + duration;
  let rowWalking: Map<number, number> | undefined, columnWalking: Map<number, number> | undefined;
  let patterns: PuzzlePatterns | undefined;
  const patternGroups = new Int8Array(cells).fill(-1),
    patternShifts = new Uint8Array(cells),
    rootPatterns = new Uint32Array(3);
  const preparePatterns = async () => {
    patterns = await puzzlePatterns(position.goal.indexOf(0), async () => {
      if (cancelled()) throw new Error("cancelled");
      if (performance.now() >= deadline) throw new Error("budget");
      if (performance.now() - lastYield >= 16) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    });
    patterns.goals.forEach((group, g) =>
      group.forEach((cell, i) => {
        const tile = position.goal[cell]!;
        patternGroups[tile] = g;
        patternShifts[tile] = i * 4;
        rootPatterns[g] |= board.indexOf(tile) << (i * 4);
      }),
    );
  };
  const prepareWalking = async () => {
    const checkpoint = async () => {
      if (cancelled()) throw new Error("cancelled");
      if (performance.now() >= deadline) throw new Error("budget");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    try {
      rowWalking = await walkingTable(goalRows[0]!, checkpoint);
      columnWalking = await walkingTable(goalColumns[0]!, checkpoint);
    } catch (error) {
      if (error instanceof Error && (error.message === "cancelled" || error.message === "budget"))
        return error.message as "cancelled" | "budget";
      throw error;
    }
  };
  let rootRowKey = size === 4 ? cellRows[board.indexOf(0)]! * WALKING_POWERS[16]! : 0,
    rootColumnKey = size === 4 ? cellColumns[board.indexOf(0)]! * WALKING_POWERS[16]! : 0;
  if (size === 4)
    for (let index = 0; index < cells; index++) {
      const tile = board[index]!;
      if (!tile) continue;
      rootRowKey += WALKING_POWERS[cellRows[index]! * 4 + goalRows[tile]!]!;
      rootColumnKey += WALKING_POWERS[cellColumns[index]! * 4 + goalColumns[tile]!]!;
    }
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
    packed = size === 4,
    rootKey = packed ? 0n : board.reduce((key, tile, index) => key | (tileCodes[tile]! << shifts[index]!), 0n),
    rootLow = packed ? board.slice(0, 8).reduce((key, tile, index) => key | (tile << (index * 4)), 0) >>> 0 : 0,
    rootHigh = packed ? board.slice(8).reduce((key, tile, index) => key | (tile << (index * 4)), 0) >>> 0 : 0;
  bound = Math.max(heuristic, (rowWalking?.get(rootRowKey) ?? 0) + (columnWalking?.get(rootColumnKey) ?? 0));
  let stopped: "budget" | "cancelled" | undefined,
    answer: number[] | undefined,
    exceeded = Infinity;
  const path: number[] = [],
    onPath = new Set<bigint>([rootKey]),
    transpositions = new Map<bigint, number>(),
    tableLow = new Uint32Array(packed ? 262144 : 0),
    tableHigh = new Uint32Array(tableLow.length),
    tableDepth = new Uint8Array(tableLow.length);
  interface Frame {
    blank: number;
    previous: number;
    g: number;
    h: number;
    entered: boolean;
    choices: number[];
    cursor: number;
    key: bigint;
    low: number;
    high: number;
    rowKey: number;
    columnKey: number;
    p0: number;
    p1: number;
    p2: number;
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
        low: rootLow,
        high: rootHigh,
        rowKey: rootRowKey,
        columnKey: rootColumnKey,
        p0: rootPatterns[0]!,
        p1: rootPatterns[1]!,
        p2: rootPatterns[2]!,
      },
    ];
    const pop = () => {
      const frame = frames.pop()!;
      if (frame.undo) {
        board[frame.undo.index] = frame.undo.tile;
        board[frame.undo.blank] = blankTile;
        if (!packed) onPath.delete(frame.key);
        path.pop();
      }
    };
    let ticks = 0;
    while (frames.length) {
      if ((++ticks & 2047) === 0 && cancelled()) {
        stopped = "cancelled";
        return;
      }
      if ((ticks & 2047) === 0 && performance.now() >= deadline) {
        stopped = "budget";
        return;
      }
      const frame = frames.at(-1)!;
      if (!frame.entered) {
        const f =
          frame.g +
          Math.max(
            frame.h,
            (rowWalking?.get(frame.rowKey) ?? 0) + (columnWalking?.get(frame.columnKey) ?? 0),
            patterns
              ? patterns.distances[0]![frame.p0]! +
                  patterns.distances[1]![frame.p1]! +
                  patterns.distances[2]![frame.p2]!
              : 0,
          );
        if (f > bound) {
          exceeded = Math.min(exceeded, f);
          pop();
          continue;
        }
        if (packed) {
          const hash =
              Math.imul(frame.low ^ (frame.low >>> 16), 0x9e3779b1) ^
              Math.imul(frame.high ^ (frame.high >>> 16), 0x85ebca6b),
            slot = (hash ^ (hash >>> 16)) & (tableDepth.length - 1),
            previous = tableDepth[slot]!;
          if (previous && tableLow[slot] === frame.low && tableHigh[slot] === frame.high && previous <= frame.g + 1) {
            pop();
            continue;
          }
          tableLow[slot] = frame.low;
          tableHigh[slot] = frame.high;
          tableDepth[slot] = frame.g + 1;
        } else {
          const previous = transpositions.get(frame.key);
          if (previous !== undefined && previous <= frame.g) {
            pop();
            continue;
          }
          if (transpositions.size < 100000 || previous !== undefined) transpositions.set(frame.key, frame.g);
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
      const key = packed
        ? 0n
        : frame.key ^ (tileCodes[tile]! << shifts[frame.blank]!) ^ (tileCodes[tile]! << shifts[index]!);
      if (!packed && onPath.has(key)) continue;
      let low = frame.low,
        high = frame.high;
      if (packed) {
        if (frame.blank < 8) low ^= tile << (frame.blank * 4);
        else high ^= tile << ((frame.blank - 8) * 4);
        if (index < 8) low ^= tile << (index * 4);
        else high ^= tile << ((index - 8) * 4);
      }
      // Only these unique lines can change their eligible tile ordering.
      const previousConflict = affectedConflict(frame.blank, index);
      [board[frame.blank], board[index]] = [tile, blankTile];
      const childH =
        frame.h -
        distance(tile, index) +
        distance(tile, frame.blank) +
        affectedConflict(frame.blank, index) -
        previousConflict;
      const row = cellRows[frame.blank]!,
        nextRow = cellRows[index]!,
        column = cellColumns[frame.blank]!,
        nextColumn = cellColumns[index]!;
      const rowKey =
        size === 4 && row !== nextRow
          ? frame.rowKey +
            WALKING_POWERS[row * 4 + goalRows[tile]!]! -
            WALKING_POWERS[nextRow * 4 + goalRows[tile]!]! +
            (nextRow - row) * WALKING_POWERS[16]!
          : frame.rowKey;
      const columnKey =
        size === 4 && column !== nextColumn
          ? frame.columnKey +
            WALKING_POWERS[column * 4 + goalColumns[tile]!]! -
            WALKING_POWERS[nextColumn * 4 + goalColumns[tile]!]! +
            (nextColumn - column) * WALKING_POWERS[16]!
          : frame.columnKey;
      let p0 = frame.p0,
        p1 = frame.p1,
        p2 = frame.p2;
      if (patterns) {
        const change = (frame.blank ^ index) << patternShifts[tile]!;
        if (patternGroups[tile] === 0) p0 ^= change;
        else if (patternGroups[tile] === 1) p1 ^= change;
        else p2 ^= change;
      }
      if (!packed) onPath.add(key);
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
        low: low >>> 0,
        high: high >>> 0,
        rowKey,
        columnKey,
        p0,
        p1,
        p2,
        undo: { index, blank: frame.blank, tile },
      });
    }
  }
  let lastYield = performance.now();
  while (true) {
    if (incumbent && bound >= incumbent.length) return result("optimal", incumbent);
    if (size === 4 && !rowWalking && nodes >= 4096) {
      const stopped = await prepareWalking();
      if (stopped) return result(stopped);
      bound = Math.max(bound, rowWalking!.get(rootRowKey)! + columnWalking!.get(rootColumnKey)!);
    }
    if (
      size === 4 &&
      !patterns &&
      nodes >= 100000 &&
      performance.now() - start >= 250 &&
      deadline - performance.now() >= 800
    ) {
      try {
        await preparePatterns();
      } catch (error) {
        if (error instanceof Error && (error.message === "cancelled" || error.message === "budget"))
          return result(error.message);
        throw error;
      }
      bound = Math.max(
        bound,
        patterns!.distances.reduce((sum, table, i) => sum + table[rootPatterns[i]!]!, 0),
      );
    }
    transpositions.clear();
    tableDepth.fill(0);
    exceeded = Infinity;
    for (const _ of visit()) {
      progress({ nodes, bound, elapsedMs: performance.now() - start });
      if (performance.now() - lastYield >= 16) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    if (answer) return result("optimal", answer);
    if (stopped) return result(stopped);
    if (!Number.isFinite(exceeded)) return result("budget");
    bound = exceeded;
    progress({ nodes, bound, elapsedMs: performance.now() - start });
  }
}
