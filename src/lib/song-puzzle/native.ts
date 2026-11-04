// L3 — GEB
// Input: 原作歌曲 ID 与 3–8 阶棋盘。
// Output: 与原作种子、随机数和移动顺序一致的固定开局。
// Pos: [Map](../L2-2.md)；原生华容道关卡生成。
// Effects/Dependencies: 纯计算；原生实现坐标与来源见本目录 README。
import { goalBoard, type PuzzlePosition } from "./model";

function seededRandom(seed: number): () => number {
  const state = new Int32Array(56),
    maximum = 2147483647;
  let previous = 161803398 - Math.abs(seed | 0),
    next = 1;
  state[55] = previous;
  for (let i = 1; i < 55; i++) {
    const index = (21 * i) % 55;
    state[index] = next;
    next = previous - next;
    if (next < 0) next += maximum;
    previous = state[index]!;
  }
  for (let pass = 0; pass < 4; pass++)
    for (let i = 1; i < 56; i++) {
      state[i] -= state[1 + ((i + 30) % 55)]!;
      if (state[i]! < 0) state[i] += maximum;
    }
  let first = 0,
    second = 21;
  return () => {
    if (++first === 56) first = 1;
    if (++second === 56) second = 1;
    let value = state[first]! - state[second]!;
    if (value === maximum) value--;
    if (value < 0) value += maximum;
    state[first] = value;
    return value * (1 / maximum);
  };
}

export function nativePuzzle(songId: number, size: number): PuzzlePosition {
  const goal = goalBoard(size),
    tiles = [...goal],
    random = seededRandom(songId);
  let blank = tiles.length - 1;
  for (let move = 0; move < size * size * 11; move++) {
    const choices: number[] = [];
    // Unity's up/down/left/right vectors are applied to a downward-growing board Y.
    if (blank < size * (size - 1)) choices.push(blank + size);
    if (blank >= size) choices.push(blank - size);
    if (blank % size) choices.push(blank - 1);
    if (blank % size < size - 1) choices.push(blank + 1);
    const next = choices[Math.floor(random() * choices.length)]!;
    [tiles[blank], tiles[next]] = [tiles[next]!, 0];
    blank = next;
  }
  return { size, goal, tiles };
}
