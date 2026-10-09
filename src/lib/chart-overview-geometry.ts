export interface ChartOverviewColumn {
  readonly index: number;
  readonly leftCss: number;
  readonly rightCss: number;
  readonly startMs: number;
  /** Full column span used by the existing painter. */
  readonly paintEndMs: number;
  /** Actual chart boundary used by interaction. */
  readonly endMs: number;
  readonly activeTopCss: number;
}

export interface ChartOverviewGeometry {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly columnWidth: number;
  readonly columnDurationMs: number;
  readonly heightPerSecond: number;
  readonly chartDurationMs: number;
  readonly columns: readonly ChartOverviewColumn[];
}

export interface ChartOverviewRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartOverviewTimePoint {
  readonly column: number;
  readonly timeMs: number;
  readonly xCss: number;
  readonly yCss: number;
}

/** Capture the numeric layout the painter uses, independently of canvas DPR. */
export function createChartOverviewGeometry(
  chartDurationMs: number,
  cssHeight: number,
  columnWidth: number,
  heightPerSecond: number,
): ChartOverviewGeometry | undefined {
  if (
    ![chartDurationMs, cssHeight, columnWidth, heightPerSecond].every(Number.isFinite) ||
    chartDurationMs <= 0 ||
    cssHeight <= 0 ||
    columnWidth <= 0 ||
    heightPerSecond <= 0
  )
    return;
  // Keep the painter's operation order, including its full final column.
  const columnDurationMs = (cssHeight / heightPerSecond) * 1000;
  const count = Math.max(1, Math.ceil(chartDurationMs / columnDurationMs));
  const cssWidth = count * columnWidth;
  if (
    !Number.isFinite(columnDurationMs) ||
    columnDurationMs <= 0 ||
    !Number.isSafeInteger(count) ||
    count > 0xffffffff ||
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(count * columnDurationMs)
  )
    return;
  const columns = Array.from({ length: count }, (_, index): ChartOverviewColumn => {
    const startMs = index * columnDurationMs;
    const paintEndMs = (index + 1) * columnDurationMs;
    const endMs = Math.min(paintEndMs, chartDurationMs);
    return Object.freeze({
      index,
      leftCss: index * columnWidth,
      rightCss: (index + 1) * columnWidth,
      startMs,
      paintEndMs,
      endMs,
      activeTopCss:
        endMs === paintEndMs
          ? 0
          : Math.max(0, Math.min(cssHeight, cssHeight - ((endMs - startMs) / 1000) * heightPerSecond)),
    });
  });
  return Object.freeze({
    cssWidth,
    cssHeight,
    columnWidth,
    columnDurationMs,
    heightPerSecond,
    chartDurationMs,
    columns: Object.freeze(columns),
  });
}

/** Map a real canvas client rect; its scroll translation is already included. */
export function chartOverviewPointToTime(
  geometry: ChartOverviewGeometry,
  rect: ChartOverviewRect,
  clientX: number,
  clientY: number,
  policy: "reject" | "clamp" = "reject",
): ChartOverviewTimePoint | undefined {
  if (
    ![rect.left, rect.top, rect.width, rect.height, clientX, clientY].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return;
  if (policy !== "clamp" && (clientX < rect.left || clientX > right || clientY < rect.top || clientY > bottom)) return;
  let xCss = ((clientX - rect.left) / rect.width) * geometry.cssWidth;
  let yCss = ((clientY - rect.top) / rect.height) * geometry.cssHeight;
  if (!Number.isFinite(xCss) || !Number.isFinite(yCss)) return;
  // Rect-domain rejection precedes clipping, including round-off at an exact edge.
  xCss = Math.max(0, Math.min(geometry.cssWidth, xCss));
  yCss = Math.max(0, Math.min(geometry.cssHeight, yCss));
  const index = Math.min(geometry.columns.length - 1, Math.floor(xCss / geometry.columnWidth));
  const column = geometry.columns[index];
  if (!column) return;
  if (yCss < column.activeTopCss) {
    if (policy !== "clamp") return;
    yCss = column.activeTopCss;
  }
  const time = column.startMs + ((geometry.cssHeight - yCss) / geometry.heightPerSecond) * 1000;
  return Object.freeze({
    column: index,
    // Clip only floating-point round-off at an already valid active edge.
    timeMs: Math.max(column.startMs, Math.min(column.endMs, time)),
    xCss,
    yCss,
  });
}

/** Identical successful redraws do not invalidate an in-progress gesture. */
export function sameChartOverviewGeometry(
  first: ChartOverviewGeometry | undefined,
  second: ChartOverviewGeometry | undefined,
): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    first.cssWidth === second.cssWidth &&
    first.cssHeight === second.cssHeight &&
    first.columnWidth === second.columnWidth &&
    first.columnDurationMs === second.columnDurationMs &&
    first.heightPerSecond === second.heightPerSecond &&
    first.chartDurationMs === second.chartDurationMs &&
    first.columns.length === second.columns.length
  );
}
