/** The live's random streams: four .NET `System.Random` instances seeded from one base seed. */
import { f } from "./num";

const MBIG = 2147483647;
const MSEED = 161803398;
export const SKILL = 0;
export const LUCK = 1;

class NetRandom {
  private readonly seeds = new Int32Array(56);
  private inext = 0;
  private inextp = 21;
  constructor(seed: number) {
    const sa = this.seeds;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = (MSEED - subtraction) | 0;
    sa[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      ii += 21;
      if (ii >= 55) ii -= 55;
      sa[ii] = mk;
      mk = (mj - mk) | 0;
      if (mk < 0) mk = (mk + MBIG) | 0;
      mj = sa[ii]!;
    }
    for (let k = 1; k < 5; k++)
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        sa[i] = (sa[i]! - sa[1 + n]!) | 0;
        if (sa[i]! < 0) sa[i] = (sa[i]! + MBIG) | 0;
      }
  }
  private internal(): number {
    let a = this.inext + 1;
    let b = this.inextp + 1;
    if (a >= 56) a = 1;
    if (b >= 56) b = 1;
    let r = (this.seeds[a]! - this.seeds[b]!) | 0;
    if (r === MBIG) r--;
    if (r < 0) r = (r + MBIG) | 0;
    this.seeds[a] = r;
    this.inext = a;
    this.inextp = b;
    return r;
  }
  nextDouble(): number {
    return this.internal() * (1 / MBIG);
  }
  /** `Next(int.MinValue, int.MaxValue)`: the large-range sample. */
  nextInt(): number {
    let result = this.internal();
    if (this.internal() % 2 === 0) result = -result;
    let d = result + (MBIG - 1);
    d /= 2 * MBIG - 1;
    return (Math.trunc(d * 4294967295) - 2147483648) | 0;
  }
}

export class LiveRandom {
  private streams: NetRandom[];
  draws = 0;
  constructor(public baseSeed = 0) {
    this.streams = [0, 1, 2, 3].map((index) => new NetRandom(Math.imul(index, -0x61c88647) ^ baseSeed));
  }
  value(stream: number): number {
    this.draws++;
    return f(this.streams[stream]!.nextDouble());
  }
  nextInt(stream: number): number {
    this.draws++;
    return this.streams[stream]!.nextInt();
  }
}
