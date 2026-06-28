import { buildChart, parseScore, type ChartDocument } from "@haneoka/chart/parser";

interface ChartPreviewRequest {
  id: number;
  source: string;
}

interface ChartPreviewSuccess {
  id: number;
  chart: ChartDocument;
}

interface ChartPreviewFailure {
  id: number;
  error: string;
}

/**
 * Chart conversion is intentionally isolated from the Vue/UI thread.  A
 * malformed or unusually dense third-party score must result in an error
 * state, never make the route impossible to leave.
 */
self.addEventListener("message", (event: MessageEvent<ChartPreviewRequest>) => {
  const { id, source } = event.data;
  try {
    const chart = buildChart(parseScore(source));
    self.postMessage({ id, chart } satisfies ChartPreviewSuccess);
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "Unable to parse this chart.";
    self.postMessage({ id, error } satisfies ChartPreviewFailure);
  }
});
