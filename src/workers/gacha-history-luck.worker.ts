// Private probability worker; owner: [GachaLuckClient](../lit/shared/gacha-history-luck.ts).
import { GachaLuckCalculator, type GachaLuckInput, type GachaLuckResult } from "../lib/gacha-history-luck";

export interface GachaLuckRequest { id: number; input: GachaLuckInput }
export interface GachaLuckResponse { id: number; result?: GachaLuckResult; error?: true }
const calculator = new GachaLuckCalculator();
self.onmessage = ({ data }: MessageEvent<GachaLuckRequest>) => {
  try { self.postMessage({ id: data.id, result: calculator.calculate(data.input) } satisfies GachaLuckResponse); }
  catch { self.postMessage({ id: data.id, error: true } satisfies GachaLuckResponse); }
};
