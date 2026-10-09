import { solvePuzzle } from "../lib/song-puzzle/solver";
import type { PuzzlePosition } from "../lib/song-puzzle/model";
interface Request {
  token: number;
  revision: number;
  position: PuzzlePosition;
  budgetMs: number;
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
        if (owner === epoch && performance.now() - lastProgress >= 200) {
          lastProgress = performance.now();
          self.postMessage({ token, revision, progress });
        }
      },
      () => owner !== epoch,
    );
    if (owner === epoch) self.postMessage({ token, revision, result });
  } catch {
    if (owner === epoch) self.postMessage({ token, revision, error: true });
  }
};
