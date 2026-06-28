import { NoteOperateType, NoteSimulateJudgement, NoteSimulateJudgement as S } from "./enums.js";

export function jdf(j: NoteSimulateJudgement): number {
  switch (j) {
    case S.Just:
      return 230;
    case S.Perfect:
      return 100;
    case S.Great:
      return 80;
    case S.Good:
      return 50;
    default:
      return 0; // Bad, Miss, None, Wait, Pass
  }
}

const TEN_TYPE = new Set<NoteOperateType>([
  NoteOperateType.SlideConnection,
  NoteOperateType.Trace,
  NoteOperateType.SlideBeginTrace,
  NoteOperateType.SlideEndTrace,
  NoteOperateType.SlideConnectionTrace,
  NoteOperateType.GuideBeginTrace,
  NoteOperateType.GuideEndTrace,
  NoteOperateType.Combo,
]);

export function ndfWeight(op: NoteOperateType): number {
  return TEN_TYPE.has(op) ? 0.1 : 1.0;
}

// Combo score bonus: tiers 10..100 @0.01, 110..500 @0.005, cumulative cap 0.30.
export function comboBonus(combo: number): number {
  const a = Math.max(0, Math.min(Math.floor(combo / 10), 10));
  const b = Math.max(0, Math.min(Math.floor((combo - 100) / 10), 40));
  return Math.min(0.01 * a + 0.005 * b, 0.3);
}

export function noteContribution(j: NoteSimulateJudgement, op: NoteOperateType, combo: number): number {
  return (jdf(j) / 100) * ndfWeight(op) * (1 + comboBonus(combo));
}

// 全 Perfect 全连基准（每 note judgeFactor=1，combo 递增 1..N）。
export function perfectCeiling(ops: NoteOperateType[]): number {
  let w = 0;
  for (let i = 0; i < ops.length; i++) w += ndfWeight(ops[i]) * (1 + comboBonus(i + 1));
  return w;
}

export function normalizedScore(contributionSum: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.round((1_000_000 * contributionSum) / ceiling);
}
