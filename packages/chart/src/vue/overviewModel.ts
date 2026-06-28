export interface TimedItem {
  timeMs: number;
}

export interface OverviewViewport {
  panelCount: number;
  contentWidth: number;
  canvasWidth: number;
  firstPanel: number;
  lastPanel: number;
}

export interface OverviewGeometry {
  laneWidth: number;
  panelWidth: number;
  heightPerSecond: number;
  secondsPerPanel: number;
}

export interface ChartCanvasOverviewPresentation {
  laneWidth: number;
  stageWidth: number;
  bandCount: number;
  spaceCount: number;
  heightPerSecond: number;
  noteScale: number;
  longAlpha: number;
  lineWidth: number;
}

const OVERVIEW_BAND_COUNT = 6;

/**
 * Directional flick textures in skin001 both face right. The reference left
 * prefab supplies quaternion (0, 0, 1, 0), a 180-degree Z rotation;
 * the right prefab keeps the identity transform.
 */
export function overviewDirectionalArrowRotation(direction: "left" | "right"): number {
  return direction === "left" ? Math.PI : 0;
}

export function overviewGeometry(viewportHeight: number, chartZoom: number, verticalScale: number): OverviewGeometry {
  const zoom = Math.max(0.01, chartZoom);
  const vertical = Math.max(0.01, verticalScale);
  const height = Math.max(1, viewportHeight);
  const laneWidth = 10 * zoom;
  const panelWidth = 13 * laneWidth;
  const heightPerSecond = 150 * vertical * zoom;
  return {
    laneWidth,
    panelWidth,
    heightPerSecond,
    secondsPerPanel: height / heightPerSecond,
  };
}

/**
 * Canonical screen-space presentation consumed by ChartOverview and every
 * authoring surface that promises visual parity with it.
 */
export function chartCanvasOverviewPresentation(
  chartZoom = 1,
  verticalScale = 1,
  noteScale = 1,
  longAlpha = 0.8,
): ChartCanvasOverviewPresentation {
  const geometry = overviewGeometry(1, chartZoom, verticalScale);
  return {
    laneWidth: geometry.laneWidth,
    stageWidth: OVERVIEW_BAND_COUNT * geometry.laneWidth,
    bandCount: OVERVIEW_BAND_COUNT,
    spaceCount: 0,
    heightPerSecond: geometry.heightPerSecond,
    noteScale: Math.max(0.01, noteScale),
    longAlpha: Math.max(0, Math.min(1, longAlpha)),
    lineWidth: geometry.laneWidth / 10,
  };
}

export const CHART_CANVAS_OVERVIEW_DEFAULT_PRESENTATION = chartCanvasOverviewPresentation();

export function lowerBoundTime(items: ReadonlyArray<TimedItem>, timeMs: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function upperBoundTime(items: ReadonlyArray<TimedItem>, timeMs: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.timeMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Keep the overview's backing canvases bounded by its own scroll viewport.
 * `contentWidth` belongs to the internal track and must never become the
 * canvas or document width.
 */
export function overviewViewport(
  durationMs: number,
  secondsPerPanel: number,
  panelWidth: number,
  viewportWidth: number,
  scrollLeft: number,
): OverviewViewport {
  const durationPerPanel = Math.max(0.001, secondsPerPanel) * 1000;
  const safePanelWidth = Math.max(1, panelWidth);
  // Production uses ceil(maxTime * heightPerSecond / panelHeight), without
  // appending an invented one-second tail panel.
  const panelCount = Math.max(1, Math.ceil(Math.max(0, durationMs) / durationPerPanel));
  const contentWidth = panelCount * safePanelWidth;
  const canvasWidth = Math.max(1, Math.min(Math.max(1, viewportWidth), contentWidth));
  const clampedScroll = Math.max(0, Math.min(scrollLeft, Math.max(0, contentWidth - canvasWidth)));
  const firstPanel = Math.max(0, Math.min(panelCount - 1, Math.floor(clampedScroll / safePanelWidth)));
  const lastPanel = Math.max(
    firstPanel,
    Math.min(panelCount - 1, Math.floor((clampedScroll + canvasWidth - Number.EPSILON) / safePanelWidth)),
  );
  return { panelCount, contentWidth, canvasWidth, firstPanel, lastPanel };
}
