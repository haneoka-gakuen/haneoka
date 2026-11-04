// L3 — GEB
// Input: 带令牌／修订号的棋盘、预算与速度／步数策略。
// Output: 进度、完整可行解与最终结果事件。
// Pos: [Map](../L2.md)；华容道求解的浏览器 Worker 入口。
// Effects/Dependencies: 本地求解并保留启发式缓存；页面取消在途任务或断开时终止。
import { solvePuzzle } from "../lib/song-puzzle/solver";
import type { PuzzlePosition } from "../lib/song-puzzle/model";
interface Request {
  token: number;
  revision: number;
  position: PuzzlePosition;
  budgetMs: number;
  quality?: "fast" | "short";
}
let epoch = 0;
self.onmessage = async ({ data }: MessageEvent<Request>) => {
  const owner = ++epoch;
  const { token, revision, position, budgetMs } = data;
  let lastProgress = 0;
  try {
    const result = await solvePuzzle(
      position,
      budgetMs,
      (progress) => {
        if (owner === epoch && (progress.path || performance.now() - lastProgress >= 200)) {
          lastProgress = performance.now();
          self.postMessage({ token, revision, progress });
        }
      },
      () => owner !== epoch,
      { quality: data.quality },
    );
    if (owner === epoch) self.postMessage({ token, revision, result });
  } catch {
    if (owner === epoch) self.postMessage({ token, revision, error: true });
  }
};
