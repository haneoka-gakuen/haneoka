import type { ChartDocument } from "@haneoka/cassiopeia";
import type { NativeChartPresentation } from "@haneoka/cassiopeia-renderer-three";
import type { ChartPlaybackOptions, ChartUpdateOptions } from "./types.js";
/** Native profile prevalidation rejected this replacement before the current player changed. */
export class ChartReplacementRejectedError extends Error {
  constructor(cause: unknown) {
    super("Chart replacement rejected", { cause });
    this.name = "ChartReplacementRejectedError";
  }
}
export interface PlayerDriver {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setOptions(options: ChartPlaybackOptions): Promise<void>;
  getPresentation?(): NativeChartPresentation | undefined;
  setChart?(chart: ChartDocument, options?: ChartUpdateOptions): Promise<void>;
  /** Resolves after the next actual renderer frame; chart/seek mutations register before requesting it. */
  waitForPresentation?(): Promise<void>;
  dispose(): void;
}
export type PlayerEvent = (name: string, ...args: unknown[]) => void;
