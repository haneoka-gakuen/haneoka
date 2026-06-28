import { NoteSimulateJudgement, NoteSimulateJudgement as S } from "./enums.js";

export const LIFE_BASE = 1000;
export const LIFE_DANGER = 300;

export function lifeDamage(j: NoteSimulateJudgement): number {
  if (j === S.Bad) return 50;
  if (j === S.Miss) return 100;
  return 0;
}

export function realMaxLife(internalMax: number): number {
  return internalMax * 2;
}

export class LifeState {
  life: number;
  readonly internalMax: number;

  constructor(initial: number = LIFE_BASE, internalMax: number = LIFE_BASE) {
    this.life = initial;
    this.internalMax = internalMax;
  }

  // Spec: MaxLife = min(InternalMax, RealMax), RealMax = 2×InternalMax → always InternalMax.
  // No healing/skills in scope, so this upper clamp never binds; if healing is added later,
  // cap against realMaxLife(internalMax) instead.
  get maxLife(): number {
    return Math.min(this.internalMax, realMaxLife(this.internalMax));
  }

  get isAlive(): boolean {
    return this.life > 0;
  }

  get scoreFactor(): number {
    return this.life > 0 ? 1.0 : 0.3;
  }

  applyJudgement(j: NoteSimulateJudgement): void {
    this.life = Math.max(0, Math.min(this.maxLife, this.life - lifeDamage(j)));
  }
}
