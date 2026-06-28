import { NoteOperateType, NoteSimulateJudgement } from "./enums";

const TEN_PERCENT_TYPES = new Set<NoteOperateType>([
  NoteOperateType.SlideConnection,
  NoteOperateType.Trace,
  NoteOperateType.SlideBeginTrace,
  NoteOperateType.SlideEndTrace,
  NoteOperateType.SlideConnectionTrace,
  NoteOperateType.GuideBeginTrace,
  NoteOperateType.GuideEndTrace,
  NoteOperateType.Combo,
]);

export const LIFE_BASE = 1000;
export const LIFE_DANGER = 300;

export function judgementFactor(judgement: NoteSimulateJudgement): number {
  if (judgement === NoteSimulateJudgement.Just) return 2.3;
  if (judgement === NoteSimulateJudgement.Perfect) return 1;
  if (judgement === NoteSimulateJudgement.Great) return 0.8;
  if (judgement === NoteSimulateJudgement.Good) return 0.5;
  return 0;
}

export function noteWeight(type: NoteOperateType): number {
  return TEN_PERCENT_TYPES.has(type) ? 0.1 : 1;
}

/** MasterLiveComboScoreBonus: 1% per 10 to 100, then 0.5% per 10 to 500. */
export function comboBonus(combo: number): number {
  const first = Math.max(0, Math.min(Math.floor(combo / 10), 10));
  const second = Math.max(0, Math.min(Math.floor((combo - 100) / 10), 40));
  return Math.min(first * 0.01 + second * 0.005, 0.3);
}

export function contribution(judgement: NoteSimulateJudgement, type: NoteOperateType, combo: number): number {
  return judgementFactor(judgement) * noteWeight(type) * (1 + comboBonus(combo));
}

export function perfectCeiling(types: NoteOperateType[]): number {
  return types.reduce((sum, type, index) => sum + noteWeight(type) * (1 + comboBonus(index + 1)), 0);
}

export function normalizeScore(contributionSum: number, ceiling: number, life: number): number {
  if (ceiling <= 0) return 0;
  // Life reaching zero never rewrites score that has already been earned.
  void life;
  return Math.round((1_000_000 * contributionSum) / ceiling);
}

export function lifeDamage(judgement: NoteSimulateJudgement): number {
  if (judgement === NoteSimulateJudgement.Bad) return 50;
  if (judgement === NoteSimulateJudgement.Miss) return 100;
  return 0;
}

export function preservesCombo(judgement: NoteSimulateJudgement): boolean {
  return judgement >= NoteSimulateJudgement.Great || judgement === NoteSimulateJudgement.Pass;
}
