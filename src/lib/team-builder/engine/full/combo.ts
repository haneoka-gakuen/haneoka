/** The live's combo counter: judgements kept in chart-time order; a note reads the combo strictly before its time. */
const WAIT = 0;
const PASS = 7;

export class ComboCounter {
  private times: number[] = [];
  private orders: number[] = [];
  private judgements: number[] = [];
  private combos: number[] = [];
  private addOrder = 0;

  addJudgement(timeMs: number, judgement: number) {
    if (judgement === WAIT || judgement === PASS) return;
    const order = this.addOrder++;
    let i = this.times.length;
    while (i >= 1 && (timeMs < this.times[i - 1]! || (timeMs === this.times[i - 1]! && order < this.orders[i - 1]!))) i--;
    this.times.splice(i, 0, timeMs);
    this.orders.splice(i, 0, order);
    this.judgements.splice(i, 0, judgement);
    this.combos.splice(i, 0, 0);
    let combo = i === 0 ? 0 : this.combos[i - 1]!;
    for (let k = i; k < this.times.length; k++) {
      const j = this.judgements[k]!;
      combo = j === 1 || j === 2 ? 0 : combo + 1;
      this.combos[k] = combo;
    }
  }

  /** Combo after the last judgement strictly before `t`. */
  timingCombo(t: number): number {
    const n = this.times.length;
    if (!n || this.times[0]! >= t) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (this.times[mid]! < t) lo = mid;
      else hi = mid - 1;
    }
    return this.combos[lo]!;
  }
}
