import { drawExportBrand, HANEOKA_EXPORT_BRAND } from "./export-brand";
import { drawLongPng } from "./long-png";
export interface GachaHistoryReportCard {
  name: string;
  kindLabel: string;
  quantity: number;
  imageUrl?: string;
  attributeImageUrl?: string;
  rarityImageUrl?: string;
  pickup?: number;
}
export interface GachaHistoryReport {
  title: string;
  scope: readonly string[];
  metrics: readonly { label: string; value: string }[];
  charts: readonly {
    label: string;
    caption?: string;
    legend: readonly string[];
    rows: readonly { label: string; values: readonly number[] }[];
  }[];
  groups: readonly { label: string; imageUrl?: string; cards: readonly GachaHistoryReportCard[] }[];
  timeline?: readonly GachaTimelineGroup[];
  timelineHighlights?: readonly GachaTimelineBadge[];
}
export interface GachaTimelineBadge {
  label: string;
  tone: "primary" | "tertiary" | "error";
}
export interface GachaTimelineGroup {
  label: string;
  supporting: string;
  total: string;
  imageUrl?: string;
  empty?: string;
  entries: readonly {
    name: string;
    meta: string;
    badges: readonly GachaTimelineBadge[];
    gapLabel: string;
    gap: number | null;
    pickup?: boolean | null;
    kind?: string;
    imageUrl?: string;
  }[];
}

const WIDTH = 960;
const PAD = 32;
const ROW = 214;
const COLUMNS = 6;

function lines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  let line = "";
  for (const character of text) {
    if (line && ctx.measureText(line + character).width > width) {
      result.push(line);
      line = "";
    }
    line += character;
  }
  if (line) result.push(line);
  return result;
}

async function loadImage(source: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const finish = (value: HTMLImageElement | null) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      image.src = "";
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      image.src = "";
      finish(null);
    }, 15000);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    image.src = source;
  });
}

async function loadReportImages(sources: string[], signal?: AbortSignal, assetsBase?: string) {
  const images = new Map<string, HTMLImageElement | null>();
  const unique = [...new Set(sources)];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const source = unique[cursor++]!;
      const url = assetsBase ? new URL(source, assetsBase).href : source;
      images.set(source, (await loadImage(url, signal)) ?? (await loadImage(url, signal)));
    }
  }));
  return images;
}

async function renderTimelineImages(
  report: GachaHistoryReport,
  signal?: AbortSignal,
  assetsBase?: string,
): Promise<Blob[]> {
  const rowHeight = 94;
  const groupHeader = 94;
  const metricHeight = report.metrics.length ? Math.ceil(report.metrics.length / 4) * 100 : 0;
  const highlights = report.timelineHighlights ?? [];
  const badgeHeight = Math.ceil(highlights.length / 4) * 48;
  const headerHeight = 114 + report.scope.length * 29 + metricHeight + badgeHeight;
  let height = headerHeight + PAD;
  const groups = report.timeline!.map(group => {
    const top = height - PAD;
    const size = groupHeader + Math.max(1, group.entries.length) * rowHeight;
    height += size + 16;
    return { group, top, size, largest: group.entries.reduce((max, row) => Math.max(max, row.gap ?? 0), 1) };
  });
  const sources = groups.flatMap(({ group }) => [
    group.imageUrl, ...group.entries.map(row => row.imageUrl),
  ]).filter((source): source is string => !!source);
  const images = await loadReportImages([HANEOKA_EXPORT_BRAND.logo, ...sources], signal, assetsBase);
  const logo = images.get(HANEOKA_EXPORT_BRAND.logo) ??
    await loadImage(new URL("/favicon.svg", assetsBase ?? location.href).href, signal);
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(`--md-sys-color-${token}`).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const content = WIDTH - PAD * 2;
  return [await drawLongPng(WIDTH, height, (ctx, low, high) => {
    ctx.textBaseline = "top";
    const rounded = (token: string, x: number, y: number, width: number, height: number, radius: number) => {
      ctx.fillStyle = color(token);
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      ctx.fill();
    };
    const text = (label: string, token: string, weight: number, size: number, x: number, y: number, width: number) => {
      ctx.fillStyle = color(token);
      ctx.font = `${weight} ${size}px ${font}`;
      ctx.fillText(label, x, y, width);
    };
    const art = (source: string | undefined, x: number, y: number, width: number, height: number) => {
      const image = source ? images.get(source) : null;
      if (!image) return;
      const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
      ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
    };
    // The hit boxes are square; crop the 3:4 member art to fill them like the
    // page's square gacha cards instead of letterboxing.
    const squareArt = (source: string | undefined, x: number, y: number, size: number) => {
      const image = source ? images.get(source) : null;
      if (!image) return;
      const { naturalWidth: w, naturalHeight: h } = image;
      if (w >= h) ctx.drawImage(image, (w - h) / 2, 0, h, h, x, y, size, size);
      else ctx.drawImage(image, 0, (h - w) * 0.25, w, w, x, y, size, size);
    };
    rounded("surface", 0, low, WIDTH, high - low, 0);
    rounded("secondary-container", PAD, 29, 8, 42, 4);
    const brandWidth = drawExportBrand(
      ctx, { font, onSurface: color("on-surface"), variant: color("on-surface-variant") },
      HANEOKA_EXPORT_BRAND, logo, WIDTH, PAD,
    );
    text(report.title, "on-surface", 700, 38, PAD + 22, 28, content - brandWidth - 22);
    report.scope.forEach((line, index) => text(line, "on-surface-variant", 500, 20, PAD, 86 + 29 * index, content));
    const metricWidth = (content - 36) / 4;
    report.metrics.forEach((metric, index) => {
      const x = PAD + (index % 4) * (metricWidth + 12);
      const y = 104 + report.scope.length * 29 + Math.floor(index / 4) * 100;
      rounded(index === 3 ? "tertiary-container" : "surface-container", x, y, metricWidth, 86, 22);
      text(metric.label, index === 3 ? "on-tertiary-container" : "on-surface-variant", 500, 18, x + 16, y + 13, metricWidth - 32);
      text(metric.value, index === 3 ? "on-tertiary-container" : "on-surface", 700, 28, x + 16, y + 44, metricWidth - 32);
    });
    const badges = (items: readonly GachaTimelineBadge[], x: number, y: number, width: number, small = false) => {
      const size = small ? 15 : 18;
      const height = small ? 24 : 38;
      ctx.font = `650 ${size}px ${font}`;
      for (const [index, item] of items.entries()) {
        const space = Math.min(ctx.measureText(item.label).width + 24, (width - (items.length - index - 1) * 8) / (items.length - index));
        rounded(`${item.tone}-container`, x, y, space, height, height / 2);
        text(item.label, `on-${item.tone}-container`, 650, size, x + 12, y + (small ? 3 : 8), space - 24);
        x += space + 8;
        width -= space + 8;
      }
    };
    for (let index = 0; index < highlights.length; index += 4)
      badges(highlights.slice(index, index + 4), PAD, headerHeight - badgeHeight + index / 4 * 48, content);
    for (const { group, top: y, size: height, largest } of groups) {
      if (y + height <= low || y >= high) continue;
      rounded("surface-container-low", PAD, y, content, height, 28);
      art(group.imageUrl, PAD + 16, y + 20, 98, 52);
      const heading = group.imageUrl && images.get(group.imageUrl) ? PAD + 126 : PAD + 20;
      text(group.label, "on-surface", 700, 27, heading, y + 18, WIDTH - PAD - 180 - heading);
      text(group.supporting, "on-surface-variant", 500, 18, heading, y + 54, WIDTH - PAD - 180 - heading);
      const totalX = WIDTH - PAD - 149;
      rounded("primary-container", totalX, y + 21, 131, 44, 22);
      ctx.textAlign = "center";
      text(group.total, "on-primary-container", 700, 22, totalX + 65.5, y + 30, 110);
      ctx.textAlign = "start";
      const rowsTop = y + groupHeader;
      const first = Math.max(0, Math.floor((low - rowsTop) / rowHeight));
      const end = Math.min(group.entries.length, Math.ceil((high - rowsTop) / rowHeight));
      for (let index = first; index < end; index++) {
        const row = group.entries[index]!;
        const top = rowsTop + index * rowHeight;
        const right = WIDTH - PAD - 20;
        const trackWidth = 224;
        const start = right - trackWidth;
        rounded("surface-container", PAD + 12, top, content - 24, rowHeight - 8, 18);
        if (row.imageUrl && images.get(row.imageUrl)) (row.kind === "member" ? squareArt : art)(row.imageUrl, PAD + 20, top + 5, 68, 68);
        else {
          rounded("secondary-container", PAD + 22, top + 9, 62, 62, 13);
          text("SSR+", "on-secondary-container", 700, 17, PAD + 33, top + 30, 42);
        }
        const titleX = PAD + 102;
        text(row.name, "on-surface", 650, 22, titleX, top + 10, start - titleX - 18);
        text(row.meta, "on-surface-variant", 500, 17, titleX, top + 39, start - titleX - 18);
        if (row.badges.length) badges(row.badges, titleX, top + 58, start - titleX - 18, true);
        ctx.textAlign = "end";
        text(row.gapLabel, "on-surface", 700, 29, right, top + 12, trackWidth);
        ctx.textAlign = "start";
        rounded("surface-container-highest", start, top + 54, trackWidth, 12, 6);
        if (row.gap) rounded(row.pickup ? "tertiary" : "primary", start, top + 54, Math.max(4, row.gap * trackWidth / largest), 12, 6);
      }
      if (!group.entries.length && group.empty)
        text(group.empty, "on-surface-variant", 500, 22, PAD + 20, y + groupHeader + 18, content - 40);
    }
  }, signal)];
}

export async function renderGachaHistoryImages(
  report: GachaHistoryReport,
  { signal, assetsBase }: { signal?: AbortSignal; assetsBase?: string } = {},
): Promise<Blob[]> {
  signal?.throwIfAborted();
  await document.fonts.ready;
  signal?.throwIfAborted();
  if (report.timeline) return renderTimelineImages(report, signal, assetsBase);
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(`--md-sys-color-${token}`).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const groups = report.groups.filter(group => group.cards.length);
  const sources = [
    HANEOKA_EXPORT_BRAND.logo,
    ...groups.map((group) => group.imageUrl).filter((value): value is string => !!value),
    ...new Set(
      groups.flatMap((group) =>
        group.cards
          .flatMap((card) => [card.imageUrl, card.attributeImageUrl, card.rarityImageUrl])
          .filter((source): source is string => Boolean(source)),
      ),
    ),
  ];
  const images = await loadReportImages(sources, signal, assetsBase);
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `500 20px ${font}`;
  const scope = report.scope.flatMap((text) => lines(measure, text, WIDTH - PAD * 2));
  const headerHeight = 104 + scope.length * 28;
  const metricColumns = report.metrics.length <= 4 ? 4 : 3;
  const metricRows = Math.ceil(report.metrics.length / metricColumns);
  measure.font = `600 26px ${font}`;
  const groupTitles = groups.map((group) => lines(measure, group.label, WIDTH - PAD * 2 - (group.imageUrl ? 108 : 0)));
  const chartHeight = report.charts.reduce(
    (sum, chart) => sum + 100 + (chart.caption ? 28 : 0) + chart.rows.length * 44,
    0,
  );
  const height =
    headerHeight +
    metricRows * 104 +
    chartHeight +
    36 +
    groups.reduce(
      (height, group, index) =>
        height + groupTitles[index].length * 32 + 40 + Math.ceil(group.cards.length / COLUMNS) * ROW,
      0,
    ) +
    52;
  return [await drawLongPng(WIDTH, height, (ctx, low, high) => {
    ctx.fillStyle = color("surface");
    ctx.fillRect(0, low, WIDTH, high - low);
    ctx.textBaseline = "top";
    ctx.fillStyle = color("on-surface");
    ctx.font = `700 36px ${font}`;
    const brandWidth = drawExportBrand(
      ctx,
      { font, onSurface: color("on-surface"), variant: color("on-surface-variant") },
      HANEOKA_EXPORT_BRAND,
      images.get(HANEOKA_EXPORT_BRAND.logo) ?? null,
      WIDTH,
      PAD,
    );
    ctx.fillStyle = color("on-surface");
    ctx.font = `700 36px ${font}`;
    ctx.fillText(report.title, PAD, PAD, WIDTH - PAD * 2 - brandWidth);
    ctx.font = `500 20px ${font}`;
    ctx.fillStyle = color("on-surface-variant");
    scope.forEach((text, index) => ctx.fillText(text, PAD, 88 + index * 28));
    const metricWidth = (WIDTH - PAD * 2 - 12 * (metricColumns - 1)) / metricColumns;
    for (const [index, metric] of report.metrics.entries()) {
      const x = PAD + (index % metricColumns) * (metricWidth + 12),
        y = headerHeight + Math.floor(index / metricColumns) * 104;
      ctx.fillStyle = color("surface-container");
      ctx.beginPath();
      ctx.roundRect(x, y, metricWidth, 92, 20);
      ctx.fill();
      ctx.fillStyle = color("on-surface-variant");
      ctx.font = `500 16px ${font}`;
      ctx.fillText(metric.label, x + 16, y + 14, metricWidth - 32);
      ctx.fillStyle = color("on-surface");
      ctx.font = `600 27px ${font}`;
      ctx.fillText(metric.value, x + 16, y + 44, metricWidth - 32);
    }
    let y = headerHeight + metricRows * 104 + 24;
    for (const chart of report.charts) {
      ctx.fillStyle = color("on-surface");
      ctx.font = `600 24px ${font}`;
      ctx.fillText(chart.label, PAD, y);
      y += 40;
      if (chart.caption) {
        ctx.font = `400 18px ${font}`;
        ctx.fillStyle = color("on-surface-variant");
        ctx.fillText(chart.caption, PAD, y);
        y += 28;
      }
      const colors = ["primary", "tertiary", "outline"];
      const maximum = Math.max(1, ...chart.rows.map((row) => row.values.reduce((sum, value) => sum + value, 0)));
      for (const row of chart.rows) {
        ctx.fillStyle = color("on-surface-variant");
        ctx.font = `500 18px ${font}`;
        ctx.fillText(row.label, PAD, y + 6, 146);
        let x = PAD + 160;
        row.values.forEach((value, index) => {
          if (!value) return;
          const width = (value / maximum) * (WIDTH - PAD * 2 - 226);
          ctx.fillStyle = color(colors[index]);
          ctx.fillRect(x, y, width, 28);
          if (width > 24) {
            ctx.fillStyle = color(index === 1 ? "on-tertiary" : index === 2 ? "surface" : "on-primary");
            ctx.fillText(String(value), x + 4, y + 4, width - 8);
          }
          x += width;
        });
        ctx.fillStyle = color("on-surface");
        ctx.fillText(String(row.values.reduce((sum, value) => sum + value, 0)), x + 10, y + 4);
        y += 44;
      }
      chart.legend.forEach((label, index) => {
        const x = PAD + index * 220;
        ctx.fillStyle = color(colors[index]);
        ctx.fillRect(x, y + 4, 16, 16);
        ctx.fillStyle = color("on-surface-variant");
        ctx.fillText(label, x + 24, y + 2);
      });
      y += 60;
    }
    const cardWidth = (WIDTH - PAD * 2 - 12 * (COLUMNS - 1)) / COLUMNS;
    for (const [groupIndex, group] of groups.entries()) {
      const groupHeight = groupTitles[groupIndex].length * 32 + 40 + Math.ceil(group.cards.length / COLUMNS) * ROW;
      if (y + groupHeight <= low || y >= high) { y += groupHeight; continue; }
      ctx.fillStyle = color("primary");
      ctx.font = `600 26px ${font}`;
      const poolImage = group.imageUrl ? images.get(group.imageUrl) : null;
      if (poolImage) {
        const scale = Math.min(96 / poolImage.naturalWidth, 48 / poolImage.naturalHeight);
        ctx.drawImage(poolImage, PAD, y, poolImage.naturalWidth * scale, poolImage.naturalHeight * scale);
      }
      groupTitles[groupIndex].forEach((line, index) => ctx.fillText(line, PAD + (poolImage ? 108 : 0), y + index * 32));
      y += groupTitles[groupIndex].length * 32 + 16;
      const first = Math.max(0, Math.floor((low - y) / ROW)) * COLUMNS;
      const end = Math.min(group.cards.length, Math.ceil((high - y) / ROW) * COLUMNS);
      for (let index = first; index < end; index++) {
        const card = group.cards[index]!;
        const x = PAD + (index % COLUMNS) * (cardWidth + 12),
          top = y + Math.floor(index / COLUMNS) * ROW;
        ctx.fillStyle = color("surface-container");
        ctx.beginPath();
        ctx.roundRect(x, top, cardWidth, cardWidth, 16);
        ctx.fill();
        const image = card.imageUrl ? images.get(card.imageUrl) : null;
        if (image) {
          const scale = Math.min(cardWidth / image.naturalWidth, cardWidth / image.naturalHeight);
          const w = image.naturalWidth * scale,
            h = image.naturalHeight * scale;
          ctx.drawImage(image, x + (cardWidth - w) / 2, top + (cardWidth - h) / 2, w, h);
        }
        for (const [source, left] of [
          [card.attributeImageUrl, true],
          [card.rarityImageUrl, false],
        ] as const) {
          const mark = source ? images.get(source) : null;
          if (mark) ctx.drawImage(mark, x + (left ? 3 : cardWidth - 25), top + 3, 22, 22);
        }
        if (card.pickup) {
          ctx.fillStyle = color("primary");
          ctx.fillRect(x + 3, top + cardWidth - 27, 66, 24);
          ctx.fillStyle = color("on-primary");
          ctx.font = `600 14px ${font}`;
          ctx.fillText(`UP ×${card.pickup}`, x + 7, top + cardWidth - 23, 58);
        }
        ctx.fillStyle = color("primary-container");
        ctx.beginPath();
        ctx.roundRect(x + cardWidth - 52, top + cardWidth - 28, 48, 24, 12);
        ctx.fill();
        ctx.fillStyle = color("on-primary-container");
        ctx.font = `600 16px ${font}`;
        ctx.fillText(`×${card.quantity}`, x + cardWidth - 46, top + cardWidth - 25, 38);
        ctx.fillStyle = color("on-surface");
        ctx.font = `500 14px ${font}`;
        lines(ctx, card.name, cardWidth)
          .slice(0, 2)
          .forEach((line, index) => ctx.fillText(line, x, top + cardWidth + 8 + index * 16));
        ctx.fillStyle = color("on-surface-variant");
        ctx.font = `400 13px ${font}`;
        ctx.fillText(card.kindLabel, x, top + cardWidth + 44, cardWidth);
      }
      y += Math.ceil(group.cards.length / COLUMNS) * ROW + 24;
    }
  }, signal)];
}
