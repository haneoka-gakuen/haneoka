/*!
 * Greedy coverage and replacement reporting adapted from
 * stonesver/otonote@8eb58fe4, site/src/lib/preset-portfolio.mjs.
 *
 * MIT License
 * Copyright (c) 2026 OtoNote contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Candidate, EvidenceGap, TeamAssignment } from "./contracts.ts";

export interface NativePortfolioSong { songKey: string; weight: number }
export interface NativePortfolioTeam {
  id: string;
  assignment: TeamAssignment;
  /** Produced in the same source/inventory/scenario/criterion/basis generation. */
  contextFingerprint: string;
  results: readonly Candidate[];
}
export interface NativePortfolioInput {
  evaluation: "complete-native-assignment";
  contextFingerprint: string;
  songs: readonly NativePortfolioSong[];
  teams: readonly NativePortfolioTeam[];
  limit: number;
}
export interface NativePortfolioRow extends NativePortfolioSong {
  teamId: string;
  alternateTeamId: string | null;
  score: number;
  gap: number | null;
  candidate: Candidate;
}
export interface NativePortfolioResult {
  method: "greedy-native-score-coverage";
  optimality: "heuristic-provided-native-matrix";
  status: "complete" | "unavailable";
  contextFingerprint: string;
  requestedLimit: number;
  selectedIds: string[];
  weightedScore: number | null;
  steps: { teamId: string; marginalGain: number; weightedScore: number }[];
  rows: NativePortfolioRow[];
  contributions: { teamId: string; selected: boolean; recommendedSongs: number;
    singleTeamScore: number; additionalGain: number; removalLoss: number | null }[];
  gaps: EvidenceGap[];
}
const assignmentKey = (assignment: TeamAssignment) => JSON.stringify([
  assignment.memberInstanceIds, assignment.snapshotInstanceIds, assignment.leaderInstanceId,
]);
function validate(input: NativePortfolioInput) {
  if (input.evaluation !== "complete-native-assignment" ||
    !/^[a-f0-9]{64}$/u.test(input.contextFingerprint) || !Number.isInteger(input.limit) ||
    input.limit < 1 || input.limit > 15 || !Array.isArray(input.songs) || !input.songs.length ||
    input.songs.length > 1000 || !Array.isArray(input.teams) || !input.teams.length || input.teams.length > 1000)
    throw new RangeError("native-portfolio-input");
  if (input.songs.length * input.teams.length > 100000) throw new RangeError("native-portfolio-matrix-budget");
  const songKeys = new Set(input.songs.map(song => song.songKey));
  if (songKeys.size !== input.songs.length || input.songs.some(song => !song.songKey ||
    !Number.isFinite(song.weight) || song.weight <= 0)) throw new RangeError("native-portfolio-songs");
  const totalWeight = input.songs.reduce((sum, song) => sum + song.weight, 0);
  if (!Number.isFinite(totalWeight)) throw new RangeError("native-portfolio-weight-sum");
  const weights = input.songs.map(song => song.weight / totalWeight);
  if (weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new RangeError("native-portfolio-weight-normalization");
  const ids = new Set<string>(), signatures = new Map<string, string>();
  const rows = input.songs.map(() => [] as Candidate[]);
  const gaps: EvidenceGap[] = [];
  for (const team of input.teams as readonly NativePortfolioTeam[]) {
    if (typeof team.id !== "string" || !team.id || ids.has(team.id) || team.contextFingerprint !== input.contextFingerprint)
      throw new RangeError("native-portfolio-team-context");
    ids.add(team.id);
    const assignment = team.assignment;
    if (!assignment || !Array.isArray(assignment.memberInstanceIds) || !Array.isArray(assignment.snapshotInstanceIds) ||
      !Array.isArray(team.results)) throw new RangeError("native-portfolio-assignment");
    const members = assignment.memberInstanceIds as string[], photos = assignment.snapshotInstanceIds as (string | null)[];
    if (members.length !== 5 || photos.length !== 5 || members.some(id => typeof id !== "string" || !id) ||
      new Set(members).size !== 5 || !members.includes(assignment.leaderInstanceId) ||
      photos.some(id => id !== null && (typeof id !== "string" || !id)) ||
      new Set(photos.filter(id => id !== null)).size !== photos.filter(id => id !== null).length)
      throw new RangeError("native-portfolio-assignment");
    const results = new Map<string, Candidate>();
    for (const candidate of team.results) {
      if (!songKeys.has(candidate.songKey) || results.has(candidate.songKey) ||
        assignmentKey(candidate.assignment) !== assignmentKey(assignment)) throw new RangeError("native-portfolio-cell-identity");
      results.set(candidate.songKey, candidate);
    }
    for (const [songIndex, song] of input.songs.entries()) {
      const candidate = results.get(song.songKey), score = candidate?.metrics.score;
      if (!candidate || !score || score.value === null || !Number.isFinite(score.value) || score.value < 0 ||
        score.status === "unavailable" || score.gaps.length) {
        gaps.push({ code: "native-portfolio-complete-score-required", source: `${team.id}/${song.songKey}` });
        if (score) gaps.push(...score.gaps);
        continue;
      }
      // Denominators can differ by chart, but teams must use the same native
      // ledger, order criterion and basis for that chart.
      const signature = JSON.stringify([score.scoreDomain ?? null, score.skillOrderCriterion ?? "nominal-mean",
        score.basis?.kind ?? "single", score.basis?.unit ?? "play", score.basis?.denominator ?? 1]);
      if (signatures.has(song.songKey) && signatures.get(song.songKey) !== signature)
        throw new RangeError("native-portfolio-score-context");
      signatures.set(song.songKey, signature);
      rows[songIndex]!.push(candidate);
    }
  }
  return { rows, gaps, weights };
}

/** Every requested song participates. Weights describe a comparison pool;
 * they are not a server song-lottery model. Scores come from the native owner. */
export function selectNativePortfolio(input: NativePortfolioInput): NativePortfolioResult {
  const { rows, gaps, weights } = validate(input);
  const output: NativePortfolioResult = { method: "greedy-native-score-coverage", optimality: "heuristic-provided-native-matrix",
    status: gaps.length ? "unavailable" : "complete", contextFingerprint: input.contextFingerprint,
    requestedLimit: input.limit, selectedIds: [], weightedScore: null, steps: [], rows: [], contributions: [], gaps };
  if (gaps.length) return output;
  const scores = rows.map(row => row.map(candidate => candidate.metrics.score.value!));
  const average = (values: readonly number[]) => values.reduce((sum, value, index) => sum + value * weights[index]!, 0);
  const selected: number[] = [];
  let best = input.songs.map(() => 0);
  const limit = Math.min(input.limit, input.teams.length);
  while (selected.length < limit) {
    let winner = -1, gain = -Infinity;
    for (let team = 0; team < input.teams.length; team++) {
      if (selected.includes(team)) continue;
      let improvement = 0;
      for (let song = 0; song < scores.length; song++)
        improvement += (Math.max(best[song]!, scores[song]![team]!) - best[song]!) * weights[song]!;
      if (improvement > gain) { winner = team; gain = improvement; }
    }
    if (selected.length && gain <= 0) break;
    selected.push(winner); best = scores.map((row, song) => Math.max(best[song]!, row[winner]!));
  }
  // Later specialists can make an earlier generalist redundant. Removing it
  // preserves each song's exact native maximum, rather than an averaged proxy.
  for (const team of [...selected]) {
    const others = selected.filter(index => index !== team);
    if (others.length && scores.every((row, song) => Math.max(...others.map(index => row[index]!)) === best[song]))
      selected.splice(selected.indexOf(team), 1);
  }
  let previous = input.songs.map(() => 0);
  for (const team of selected) {
    const values = scores.map((row, song) => Math.max(previous[song]!, row[team]!));
    output.steps.push({ teamId: input.teams[team]!.id,
      marginalGain: average(values.map((value, song) => value - previous[song]!)), weightedScore: average(values) });
    previous = values;
  }
  output.selectedIds = selected.map(index => input.teams[index]!.id);
  output.weightedScore = average(best);
  output.rows = input.songs.map((song, index) => {
    const ranked = [...selected].sort((a, b) => scores[index]![b]! - scores[index]![a]! || a - b);
    const winner = ranked[0]!, alternate = ranked[1];
    return { ...song, teamId: input.teams[winner]!.id,
      alternateTeamId: alternate === undefined ? null : input.teams[alternate]!.id,
      score: best[index]!, gap: alternate === undefined ? null : best[index]! - scores[index]![alternate]!,
      candidate: rows[index]![winner]! };
  });
  output.contributions = input.teams.map((team, index) => {
    const without = selected.filter(value => value !== index);
    return { teamId: team.id, selected: selected.includes(index),
      recommendedSongs: output.rows.filter(row => row.teamId === team.id).length,
      singleTeamScore: average(scores.map(row => row[index]!)),
      additionalGain: average(scores.map((row, song) => Math.max(0, row[index]! - best[song]!))),
      removalLoss: selected.includes(index) && without.length
        ? average(scores.map((row, song) => best[song]! - Math.max(...without.map(value => row[value]!)))) : null };
  });
  return output;
}

/** A real team replacement can hurt individual songs even when the weighted
 * total improves; keep those rows visible in the result. */
export function compareNativePortfolioReplacement(input: NativePortfolioInput, selectedIds: readonly string[],
  beforeId: string, afterId: string) {
  const { rows, gaps, weights } = validate(input);
  if (gaps.length) return { status: "unavailable" as const, gaps, rows: [], weightedDelta: null,
    improvedSongs: 0, worsenedSongs: 0 };
  const indices = new Map(input.teams.map((team, index) => [team.id, index]));
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length || !selectedIds.includes(beforeId) ||
    !indices.has(afterId) || selectedIds.some(id => !indices.has(id))) throw new RangeError("native-portfolio-replacement");
  const before = selectedIds.map(id => indices.get(id)!);
  const after = [...new Set(selectedIds.map(id => indices.get(id === beforeId ? afterId : id)!))];
  const result = input.songs.map((song, songIndex) => {
    const best = (teams: readonly number[]) => teams.reduce((winner, team) =>
      rows[songIndex]![team]!.metrics.score.value! > rows[songIndex]![winner]!.metrics.score.value! ? team : winner);
    const oldValue = rows[songIndex]![best(before)]!, newValue = rows[songIndex]![best(after)]!;
    return { ...song, before: oldValue.metrics.score.value!, after: newValue.metrics.score.value!,
      delta: newValue.metrics.score.value! - oldValue.metrics.score.value!, beforeCandidate: oldValue, afterCandidate: newValue };
  });
  return { status: "complete" as const, gaps: [], rows: result,
    weightedDelta: result.reduce((sum, row, index) => sum + row.delta * weights[index]!, 0),
    improvedSongs: result.filter(row => row.delta > 0).length, worsenedSongs: result.filter(row => row.delta < 0).length };
}
