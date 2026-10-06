/** The live's life: commands filed in 40 ms frames and replayed with a cache of the completed frames. */
import { getFrame } from "./num";

const NOTE_DAMAGE = 0;
const SKILL_DAMAGE = 1;
const RECOVERY = 2;
const GUARD_START = 3;
const GUARD_END = 4;
const REDUCTION_START = 5;
const REDUCTION_END = 6;
const BUFFER_FRAMES = 2;

interface LifeCommand {
  timeMs: number;
  kind: number;
  value: number;
  overHeal: boolean;
  safety: boolean;
}
const nonNegative = (x: number) => (x < 0 ? 0 : x);
function reduce(damage: number, bp: number): number {
  if (bp < 1) return damage;
  if (bp >>> 4 > 0x270) return 0;
  return nonNegative(((Math.imul((10000 - bp) | 0, damage) / 10000) | 0) as number);
}

export class LifeController {
  private maxLife: number;
  currentLife: number;
  private guards: number[] = [];
  private guardCounter = 0;
  private reductions = new Map<number, number>();
  private reductionCounter = 0;
  private limits = new Map<number, number>();
  private limitCounter = 0;
  private readonly maxFrame: number;
  private commands: LifeCommand[][];
  private cachedFrame = -1;
  private cachedLife = 0;
  private cachedGuard = 0;
  private cachedReduction = 0;

  constructor(
    private readonly initialLife: number,
    private readonly damage: readonly number[],
    musicLengthMs: number,
  ) {
    this.maxLife = initialLife;
    this.currentLife = initialLife;
    this.maxFrame = (getFrame(musicLengthMs) + BUFFER_FRAMES) | 0;
    this.commands = new Array(this.maxFrame);
  }
  get maximum() {
    return this.maxLife;
  }
  private frameOf(ms: number) {
    const frame = getFrame(ms);
    return this.maxFrame <= frame ? this.maxFrame - 1 : frame;
  }
  private add(cmd: LifeCommand) {
    const frame = this.frameOf(cmd.timeMs);
    const list = (this.commands[frame] ??= []);
    let i = list.length;
    while (i >= 1 && cmd.timeMs < list[i - 1]!.timeMs) i--;
    list.splice(i, 0, cmd);
    if (frame <= this.cachedFrame) {
      this.cachedFrame = -1;
      this.cachedLife = this.cachedGuard = this.cachedReduction = 0;
    }
  }
  noteDamage(timeMs: number, judgement: number) {
    if (judgement === 0 || judgement === 7) return;
    const d = this.damage[judgement] ?? 0;
    if (d > 0) this.add({ timeMs, kind: NOTE_DAMAGE, value: d, overHeal: false, safety: false });
  }
  recovery(timeMs: number, amount: number, overHeal: boolean) {
    if (amount > 0) this.add({ timeMs, kind: RECOVERY, value: amount | 0, overHeal, safety: false });
  }
  skillDamage(timeMs: number, amount: number, safety: boolean) {
    if (amount > 0) this.add({ timeMs, kind: SKILL_DAMAGE, value: amount | 0, overHeal: false, safety });
  }
  enableReduction(timeMs: number, bp: number): number {
    const id = ++this.reductionCounter;
    this.reductions.set(id, bp | 0);
    this.add({ timeMs, kind: REDUCTION_START, value: bp | 0, overHeal: false, safety: false });
    return id;
  }
  disableReduction(timeMs: number, id: number) {
    const bp = this.reductions.get(id);
    if (bp === undefined) return;
    this.reductions.delete(id);
    this.add({ timeMs, kind: REDUCTION_END, value: bp, overHeal: false, safety: false });
  }
  addLimit(amount: number): number {
    const id = ++this.limitCounter;
    this.limits.set(id, amount | 0);
    this.updateMax();
    return id;
  }
  subtractLimit(id: number) {
    if (this.limits.delete(id)) this.updateMax();
  }
  private updateMax() {
    let sum = 0;
    for (const v of this.limits.values()) sum = (sum + v) | 0;
    this.maxLife = (this.maxLife + sum) | 0;
  }
  enableGuard(timeMs: number): number {
    const id = ++this.guardCounter;
    this.guards.push(id);
    this.add({ timeMs, kind: GUARD_START, value: 0, overHeal: false, safety: false });
    return id;
  }
  disableGuard(timeMs: number, id: number) {
    const at = this.guards.indexOf(id);
    if (at < 0) return;
    this.guards.splice(at, 1);
    this.add({ timeMs, kind: GUARD_END, value: 0, overHeal: false, safety: false });
  }
  private step(state: [number, number, number], cmd: LifeCommand) {
    let [life, guard, reduction] = state;
    switch (cmd.kind) {
      case NOTE_DAMAGE:
        if (guard < 1) life = nonNegative((life - reduce(cmd.value, reduction)) | 0);
        break;
      case SKILL_DAMAGE:
        if (guard < 1 && (life > 0 || !cmd.safety)) {
          life = (life - reduce(cmd.value, reduction)) | 0;
          life = Math.max(life, cmd.safety ? 1 : 0);
        }
        break;
      case RECOVERY:
        if (life > 0) {
          const cap = cmd.overHeal ? this.maxLife << 1 : this.maxLife;
          const s = (cmd.value + life) | 0;
          life = s < cap ? s : cap;
        }
        break;
      case GUARD_START:
        guard = (guard + 1) | 0;
        break;
      case GUARD_END:
        guard = nonNegative((guard - 1) | 0);
        break;
      case REDUCTION_START:
        reduction = (reduction + cmd.value) | 0;
        break;
      case REDUCTION_END:
        reduction = nonNegative((reduction - cmd.value) | 0);
        break;
    }
    state[0] = life;
    state[1] = guard;
    state[2] = reduction;
  }
  lifeAt(ms: number): number {
    const frame = this.frameOf(ms);
    const c = this.cachedFrame;
    let full: boolean;
    let start: number;
    const state: [number, number, number] = [this.initialLife, 0, 0];
    if (c < 0 || frame <= c) {
      full = c >= 0 && frame <= c;
      start = 0;
    } else {
      full = false;
      state[0] = this.cachedLife;
      state[1] = this.cachedGuard;
      state[2] = this.cachedReduction;
      start = c + 1;
    }
    for (let k = start; k < Math.max(frame, start); k++) {
      const cmds = this.commands[k];
      if (cmds) for (const cmd of cmds) this.step(state, cmd);
    }
    if (frame < 0) return state[0];
    if (!full) {
      this.cachedFrame = frame - 1;
      [this.cachedLife, this.cachedGuard, this.cachedReduction] = state;
    }
    if (frame >= this.maxFrame) return state[0];
    const cmds = this.commands[frame];
    if (cmds)
      for (const cmd of cmds) {
        if (cmd.timeMs > ms) break;
        this.step(state, cmd);
      }
    return state[0];
  }
  syncCurrent(t: number) {
    this.currentLife = this.lifeAt(t);
  }
}
