/** Judgement conversion (effect types 12006 and 13005): registered functions tried from the most recent. */
import { END_FRAME, EXECUTE_FRAME } from "./effects";

const JUST = 6;
const CONVERT_TO_JUST = 13005;

interface ConvertParam {
  key: string;
  count: number;
  maxCount: number;
  targets: readonly number[];
  to: number;
}
export interface ConvertEffect {
  type: number;
  value: number;
  limitCount: number;
  targets: readonly number[];
  effectId: number;
}

export class Conversion {
  private order: number[] = [];
  private registered = new Set<number>();
  private funcId = 0;
  private idMap = new Map<string, number>();
  private params = new Map<number, ConvertParam>();
  private limitFinished = new Map<string, number>();
  private context = new Map<number, readonly number[]>();
  converted = 0;
  constructor(private readonly noJust: ReadonlySet<number>) {}

  private register(): number {
    const k = ++this.funcId;
    this.registered.add(k);
    this.order.unshift(k);
    return k;
  }
  private unregister(id: number) {
    if (!this.registered.delete(id)) throw new Error(`judgement convert function ${id} is not registered`);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
  }
  convert(judgement: number, judgementType: number, timeMs: number): number {
    for (let i = 0; i < this.order.length; i++) {
      const key = this.order[i]!;
      if (!this.registered.has(key)) continue;
      const out = this.tryConvert(key, judgement, judgementType, timeMs);
      if (out !== judgement) return out;
      if (!(i < this.order.length && this.order[i] === key)) i--;
    }
    return judgement;
  }
  private tryConvert(id: number, cur: number, judgementType: number, timeMs: number): number {
    const p = this.params.get(id);
    if (!p) return cur;
    if (p.to === -1 || !p.targets.includes(cur) || cur === p.to) return cur;
    if (p.to === JUST && this.noJust.has(judgementType)) return cur;
    p.count++;
    if (p.maxCount > 0 && p.maxCount <= p.count) {
      this.unregister(id);
      this.idMap.delete(p.key);
      this.params.delete(id);
      this.limitFinished.set(p.key, timeMs);
    }
    this.converted++;
    return p.to;
  }
  /** One applier update; returns the time the effect reached its limit when that is reported now. */
  update(key: string, state: number, effect: ConvertEffect): number | null {
    const finished = this.limitFinished.get(key);
    if (finished !== undefined) {
      this.limitFinished.delete(key);
      state = END_FRAME;
    }
    if (state === END_FRAME) {
      const id = this.idMap.get(key);
      if (id !== undefined) {
        this.idMap.delete(key);
        this.unregister(id);
        this.params.delete(id);
      }
    } else if (state === EXECUTE_FRAME) {
      let targets = this.context.get(effect.effectId);
      if (!targets) this.context.set(effect.effectId, (targets = effect.targets));
      const to =
        effect.type === CONVERT_TO_JUST ? JUST : effect.value - 1 >= 0 && effect.value - 1 <= 5 ? effect.value | 0 : -1;
      const id = this.register();
      if (this.idMap.has(key)) throw new Error("judgement convert state registered twice");
      this.idMap.set(key, id);
      this.params.set(id, { key, count: 0, maxCount: effect.limitCount, targets, to });
    }
    return finished ?? null;
  }
}
