// L3 — GEB
// Input: Git checkout used by the static site build.
// Output: Recent Haneoka commit subjects, hashes and timestamps.
// Pos: [Map](L2-2.md); build-time source of the commit history page.
// Effects/Dependencies: Reads local Git history once per checkout head; no network requests.
import { execFileSync } from "node:child_process";

interface RepositoryCommit {
  sha: string;
  subject: string;
  date: string;
}

let cached: { head: string; entries: RepositoryCommit[] } | undefined;

export function repositoryCommits(): RepositoryCommit[] {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (cached?.head === head) return cached.entries;
  const log = execFileSync("git", ["log", "-n", "200", "-z", "--format=%H%x00%s%x00%cI", head], { encoding: "utf8" });
  const fields = log.slice(0, -1).split("\0");
  const entries: RepositoryCommit[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [sha, subject, date] = fields.slice(index, index + 3);
    entries.push({ sha, subject, date });
  }
  cached = { head, entries };
  return entries;
}
