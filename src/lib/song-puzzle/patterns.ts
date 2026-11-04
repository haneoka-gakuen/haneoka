// L3 — GEB
// Input: 4×4 目标空格与有界异步检查点。
// Output: 三组互斥五块的加性模式数据库。
// Pos: [Map](../L2-2.md)；精确搜索的模式下界。
// Effects/Dependencies: Worker 内计算并缓存；零成本空格移动压缩为可达分量，临时状态表逐组释放。
import { neighbors } from "./model";

export interface PuzzlePatterns {
  goals: number[][];
  distances: Uint8Array[];
}
const adjacent = Array.from({ length: 16 }, (_, i) => neighbors(i, 4).reduce((mask, index) => mask | (1 << index), 0));
const cache = new Map<number, PuzzlePatterns>();
const first = (mask: number) => 31 - Math.clz32(mask & -mask);

function reachable(free: number, start: number): number {
  let region = 1 << start,
    previous = 0;
  while (region !== previous) {
    previous = region;
    region |= (((region & 0x7777) << 1) | ((region & 0xeeee) >>> 1) | (region << 4) | (region >>> 4)) & free;
  }
  return region;
}

export async function puzzlePatterns(goalBlank: number, checkpoint: () => Promise<void>): Promise<PuzzlePatterns> {
  const existing = cache.get(goalBlank);
  if (existing) return existing;
  const positions = Array.from({ length: 16 }, (_, i) => i).filter((i) => i !== goalBlank),
    goals = [positions.slice(0, 5), positions.slice(5, 10), positions.slice(10)],
    distances: Uint8Array[] = [];
  for (const goal of goals) {
    const visited = new Uint8Array(1 << 24).fill(255),
      distance = new Uint8Array(1 << 20).fill(255),
      queue: number[] = [],
      root = goal.reduce((key, pos, i) => key | (pos << (i * 4)), 0),
      occupied = goal.reduce((mask, pos) => mask | (1 << pos), 0);
    let free = 0xffff ^ occupied;
    while (free) {
      const blank = first(free),
        region = reachable(0xffff ^ occupied, blank),
        state = root | (blank << 20);
      free &= ~region;
      visited[state] = 0;
      distance[root] = 0;
      queue.push(state);
    }
    for (let head = 0; head < queue.length; head++) {
      if ((head & 2047) === 0) await checkpoint();
      const state = queue[head]!,
        pattern = state & 0xfffff,
        cost = visited[state]! + 1;
      let occupied = 0;
      for (let i = 0; i < 5; i++) occupied |= 1 << ((pattern >>> (i * 4)) & 15);
      const region = reachable(0xffff ^ occupied, state >>> 20);
      for (let i = 0; i < 5; i++) {
        const shift = i * 4,
          position = (pattern >>> shift) & 15;
        let choices = adjacent[position]! & region;
        while (choices) {
          const next = first(choices);
          choices &= choices - 1;
          const moved = pattern ^ ((position ^ next) << shift),
            free = 0xffff ^ occupied ^ (1 << position) ^ (1 << next),
            blank = first(reachable(free, position)),
            key = moved | (blank << 20);
          if (visited[key] !== 255) continue;
          visited[key] = cost;
          if (distance[moved]! > cost) distance[moved] = cost;
          queue.push(key);
        }
      }
    }
    distances.push(distance);
  }
  const result = { goals, distances };
  if (cache.size >= 2) cache.delete(cache.keys().next().value!);
  cache.set(goalBlank, result);
  return result;
}
