import type { ChartCallChangeEvent, ChartFeverTransitionEvent, ChartSkillEvent, JudgementEvent } from "../core/types";
import type { ChartPerfSummary } from "../render/PerfProbe";

export interface ChartPlayerExpose {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  resize(): void;
}

export interface ChartPlayerEvents {
  ready: [];
  playing: [value: boolean];
  timeupdate: [seconds: number];
  duration: [seconds: number];
  judgement: [event: JudgementEvent];
  skill: [event: ChartSkillEvent];
  fever: [event: ChartFeverTransitionEvent];
  callchange: [event: ChartCallChangeEvent];
  error: [error: Error];
  perf: [summary: ChartPerfSummary];
}
