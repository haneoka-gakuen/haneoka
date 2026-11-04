// L3 — GEB
// Input: 4×4 目标棋盘及取消／预算检查点。
// Output: 行列分离的 walking-distance 抽象距离表。
// Pos: [Map](../L2-2.md)；4×4 精确搜索的可采纳启发式。
// Effects/Dependencies: 本地 CPU；缓存按目标空格所在行／列，构建时定期让出 Worker。
export const WALKING_POWERS = Array.from({ length: 17 }, (_, i) => 8 ** i);
const tables = new Map<number, Map<number, number>>();

export async function walkingTable(
  goalBlankLine: number,
  checkpoint: () => Promise<void>,
): Promise<Map<number, number>> {
  const cached = tables.get(goalBlankLine);
  if (cached) return cached;
  let goal = goalBlankLine * WALKING_POWERS[16]!;
  for (let line = 0; line < 4; line++) goal += (line === goalBlankLine ? 3 : 4) * WALKING_POWERS[line * 4 + line]!;
  const distances = new Map<number, number>([[goal, 0]]),
    queue = [goal];
  for (let head = 0; head < queue.length; head++) {
    if ((head & 2047) === 0) await checkpoint();
    const state = queue[head]!,
      blank = Math.floor(state / WALKING_POWERS[16]!),
      depth = distances.get(state)! + 1;
    for (const next of [blank - 1, blank + 1]) {
      if (next < 0 || next > 3) continue;
      for (let goalLine = 0; goalLine < 4; goalLine++) {
        const from = WALKING_POWERS[next * 4 + goalLine]!,
          to = WALKING_POWERS[blank * 4 + goalLine]!;
        if (Math.floor(state / from) % 8 === 0) continue;
        const key = state + to - from + (next - blank) * WALKING_POWERS[16]!;
        if (distances.has(key)) continue;
        distances.set(key, depth);
        queue.push(key);
      }
    }
  }
  tables.set(goalBlankLine, distances);
  return distances;
}
