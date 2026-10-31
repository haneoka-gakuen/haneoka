import { drawExportBrand, HANEOKA_EXPORT_BRAND } from "./export-brand";
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
}

const WIDTH = 960;
const PAD = 32;
const ROW = 214;
const COLUMNS = 6;
const PAGE_CARDS = 36;

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

export async function renderGachaHistoryImages(
  report: GachaHistoryReport,
  { signal, page, assetsBase }: { signal?: AbortSignal; page?: number; assetsBase?: string } = {},
): Promise<Blob[]> {
  signal?.throwIfAborted();
  await document.fonts.ready;
  signal?.throwIfAborted();
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(`--md-sys-color-${token}`).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const pages: Array<Array<{ label: string; imageUrl?: string; cards: readonly GachaHistoryReportCard[] }>> = [[]];
  let remaining = PAGE_CARDS;
  for (const group of report.groups) {
    if (!group.cards.length) continue;
    for (let start = 0; start < group.cards.length;) {
      if (!remaining) {
        pages.push([]);
        remaining = PAGE_CARDS;
      }
      const cards = group.cards.slice(start, start + remaining);
      pages[pages.length - 1].push({ label: group.label, imageUrl: group.imageUrl, cards });
      start += cards.length;
      remaining -= cards.length;
    }
  }
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > pages.length)) throw new RangeError("Unknown report page");
  const selected = [...pages.entries()].filter(([index]) => page === undefined || index === page - 1);
  const selectedGroups = selected.flatMap(([, groups]) => groups);
  const images = new Map<string, HTMLImageElement | null>();
  const sources = [
    HANEOKA_EXPORT_BRAND.logo,
    ...selectedGroups.map((group) => group.imageUrl).filter((value): value is string => !!value),
    ...new Set(
      selectedGroups.flatMap((group) =>
        group.cards
          .flatMap((card) => [card.imageUrl, card.attributeImageUrl, card.rarityImageUrl])
          .filter((source): source is string => Boolean(source)),
      ),
    ),
  ];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++]!;
        const url = assetsBase ? new URL(source, assetsBase).href : source;
        images.set(source, (await loadImage(url, signal)) ?? (await loadImage(url, signal)));
      }
    }),
  );
  const output: Blob[] = [];
  for (const [pageIndex, groups] of selected) {
    signal?.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    const ctx = canvas.getContext("2d")!;
    ctx.font = `500 20px ${font}`;
    const scope = report.scope.flatMap((text) => lines(ctx, text, WIDTH - PAD * 2));
    const headerHeight = 104 + scope.length * 28;
    const metricColumns = report.metrics.length <= 4 ? 4 : 3;
    const metricRows = Math.ceil(report.metrics.length / metricColumns);
    ctx.font = `600 26px ${font}`;
    const groupTitles = groups.map((group) => lines(ctx, group.label, WIDTH - PAD * 2 - (group.imageUrl ? 108 : 0)));
    const chartHeight = report.charts.reduce(
      (sum, chart) => sum + 100 + (chart.caption ? 28 : 0) + chart.rows.length * 44,
      0,
    );
    canvas.height =
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
    if (canvas.width * canvas.height > 12_000_000) throw new RangeError("Report image exceeds the pixel budget");
    ctx.fillStyle = color("surface");
    ctx.fillRect(0, 0, WIDTH, canvas.height);
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
      ctx.fillStyle = color("primary");
      ctx.font = `600 26px ${font}`;
      const poolImage = group.imageUrl ? images.get(group.imageUrl) : null;
      if (poolImage) {
        const scale = Math.min(96 / poolImage.naturalWidth, 48 / poolImage.naturalHeight);
        ctx.drawImage(poolImage, PAD, y, poolImage.naturalWidth * scale, poolImage.naturalHeight * scale);
      }
      groupTitles[groupIndex].forEach((line, index) => ctx.fillText(line, PAD + (poolImage ? 108 : 0), y + index * 32));
      y += groupTitles[groupIndex].length * 32 + 16;
      for (const [index, card] of group.cards.entries()) {
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
    ctx.fillStyle = color("on-surface-variant");
    ctx.font = `500 16px ${font}`;
    ctx.fillText(`Haneoka / ${pageIndex + 1}/${pages.length}`, PAD, canvas.height - 36);
    output.push(
      await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("image_export_failed"))), "image/png"),
      ),
    );
  }
  signal?.throwIfAborted();
  return output;
}
