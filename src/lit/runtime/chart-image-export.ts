/**
 * Composes the simple chart overview into a downloadable PNG.
 *
 * The overview canvas paints each panel on pure black, so the export keeps
 * that colour as an even padding around the whole strip — no visible seam
 * between the chart and its frame. The header pairs the jacket with the song
 * title, artist, difficulty pill, attribute mark and band mark; a full-width
 * stats grid (spread with space-between so it fills the strip) carries the
 * song meta; the Haneoka brand appears top-right and leads the footer.
 * Typography, the difficulty pill and spacing follow Material Design 3
 * (dark, 4dp rhythm, corner-full pill, tone-on-surface emphasis levels).
 */

const FONT_STACK = `"Roboto Variable", "Noto Sans Variable", "Noto Sans JP Variable", "Noto Sans TC Variable", "Noto Sans SC Variable", "Noto Sans KR Variable", sans-serif`;
const DIFFICULTY_COLORS: Record<string, string> = {
  easy: "#48cadc",
  normal: "#56ce79",
  hard: "#f4bb3c",
  expert: "#e84e43",
  master: "#c950d7",
};

export interface ChartExportStat {
  label: string;
  value: string;
  /** Optional semantic id used to fill chart-derived values later. */
  id?: "time" | "bpm" | "nps";
}

export interface ChartOverviewExportMeta {
  title: string;
  artist?: string;
  jacketUrl?: string;
  /** Attribute (musicType) mark shown beside the credit row. */
  attributeIconUrl?: string;
  /** Band mark and name rendered as the enlarged subtitle line. */
  bandIconUrl?: string;
  bandName?: string;
  /** Song credits shown as the "作曲 X · 作词 Y · 编曲 Z · 发布 D" row. */
  credits?: ChartExportStat[];
  difficultyName: string;
  displayLevel: string | number;
  /**
   * Ordered stat cells. `stats[0]` should be the total note count so the
   * per-kind breakdown can be inserted directly after it.
   */
  stats: ChartExportStat[];
  songId?: string | number;
  locale: string;
}

const clampText = (context: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
  if (!text || context.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && context.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
};

const difficultyColor = (difficultyName: string): string => {
  const token = `--md-extended-color-difficulty-${difficultyName.toLowerCase()}`;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return resolved || DIFFICULTY_COLORS[difficultyName.toLowerCase()] || "#e84e43";
};

const roundRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  if (typeof context.roundRect === "function") {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    return;
  }
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
};

type DecodedImage = ImageBitmap | HTMLImageElement;

/**
 * Decodes an image through the element pipeline. `createImageBitmap` fails
 * silently on filter-heavy SVGs in Chromium (the site mark never rendered
 * through it), while `HTMLImageElement.decode()` is the same path `<img>`
 * uses and always works.
 */
const loadImage = async (url: string, size?: number): Promise<DecodedImage | undefined> => {
  try {
    if (size === undefined) {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return image;
    }
    const response = await fetch(url);
    if (!response.ok) return undefined;
    // An SVG without intrinsic width/height rasterizes at the wrong scale in
    // some engines; pin the dimensions before decoding.
    const source = (await response.text()).replace(
      /<svg\b([^>]*)>/u,
      (match, attributes: string) =>
        /\bwidth=/u.test(attributes) && /\bheight=/u.test(attributes)
          ? match
          : `<svg${attributes} width="${size}" height="${size}">`,
    );
    const image = new Image();
    image.decoding = "async";
    image.width = size;
    image.height = size;
    image.src = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
    try {
      await image.decode();
    } finally {
      URL.revokeObjectURL(image.src);
    }
    return image;
  } catch {
    return undefined;
  }
};

/** Loads a square raster mark (attribute/band icons are plain PNGs). */
const loadMark = async (url: string | undefined): Promise<DecodedImage | undefined> => {
  if (!url) return undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return await createImageBitmap(await response.blob());
  } catch {
    return undefined;
  }
};

const ensureFonts = async (meta: ChartOverviewExportMeta): Promise<void> => {
  if (!("fonts" in document)) return;
  const sample = `${meta.title} ${meta.artist || ""} ${meta.bandName || ""} ${(meta.credits || [])
    .map((credit) => `${credit.label}${credit.value}`)
    .join(" ")} Haneoka haneoka.org ${meta.stats
    .map((stat) => `${stat.label}${stat.value}`)
    .join(" ")} 0123456789 Lv.${meta.displayLevel}`;
  const weights = ["400 32px", "500 20px", "400 18px", "500 12px"];
  await Promise.allSettled(
    weights.flatMap((weight) => [
      document.fonts.load(`${weight} "Roboto Variable"`, sample),
      document.fonts.load(`${weight} "Noto Sans JP Variable"`, sample),
      document.fonts.load(`${weight} "Noto Sans SC Variable"`, sample),
      document.fonts.load(`${weight} "Noto Sans TC Variable"`, sample),
      document.fonts.load(`${weight} "Noto Sans KR Variable"`, sample),
    ]),
  );
};

export const chartImageFileName = (meta: ChartOverviewExportMeta): string => {
  const difficulty = `${meta.difficultyName} ${meta.displayLevel}`.trim();
  const safe = (value: string) =>
    value
      .replace(/[\\/:*?"<>|\x00-\x1f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  const name = [safe(meta.title), safe(difficulty) && `[${safe(difficulty)}]`, "Haneoka"]
    .filter(Boolean)
    .join(" ");
  return `${name.slice(0, 160)}.png`;
};

interface StatCell {
  label: string;
  value: string;
  width: number;
}

const measureStatCells = (context: CanvasRenderingContext2D, stats: ChartExportStat[], scale: number): StatCell[] =>
  stats.map((stat) => {
    context.font = `500 ${Math.round(12.5 * scale)}px/${Math.round(16 * scale)}px ${FONT_STACK}`;
    const label = stat.label.toUpperCase();
    const labelWidth = context.measureText(label).width;
    context.font = `500 ${Math.round(20 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
    const valueWidth = context.measureText(stat.value).width;
    return { label, value: stat.value, width: Math.max(labelWidth, valueWidth) };
  });

/** Greedy-wraps cells into rows, then spreads each row across the full width. */
const layoutStatRows = (cells: StatCell[], contentWidth: number, gap: number, maxRows: number): StatCell[][] => {
  const rows: StatCell[][] = [];
  let row: StatCell[] = [];
  let rowWidth = 0;
  for (const cell of cells) {
    const needed = row.length ? rowWidth + gap + cell.width : cell.width;
    if (row.length && (needed > contentWidth || rows.length === maxRows - 1)) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push(cell);
    rowWidth = row.length > 1 ? rowWidth + gap + cell.width : cell.width;
  }
  if (row.length) rows.push(row);
  return rows;
};

export async function composeChartOverviewImage(
  canvas: HTMLCanvasElement,
  meta: ChartOverviewExportMeta,
): Promise<Blob | undefined> {
  const cssWidth = Number.parseFloat(canvas.style.width || "") || canvas.width;
  const cssHeight = Number.parseFloat(canvas.style.height || "") || canvas.height;
  if (!canvas.width || !canvas.height || !cssWidth || !cssHeight) return undefined;

  const [jacket, attributeMark, bandMark, brandMarkSmall] = await Promise.all([
    meta.jacketUrl ? loadImage(meta.jacketUrl) : undefined,
    loadMark(meta.attributeIconUrl),
    loadMark(meta.bandIconUrl),
    loadImage("/favicon.svg", Math.round(26 * 2)),
    ensureFonts(meta).then(() => undefined),
  ]);
  const scale = Math.max(2, Math.min(3, devicePixelRatio || 1, 4096 / Math.max(cssWidth, cssHeight)));
  const chartWidth = Math.round(cssWidth * scale);
  const chartHeight = Math.round(cssHeight * scale);
  const padding = Math.round(40 * scale);
  const jacketSize = Math.round(116 * scale);
  const pillHeight = Math.round(32 * scale);
  const pillRowTop = Math.round(74 * scale);
  const creditsRowTop = Math.round(146 * scale);
  const headerHeight = Math.round(182 * scale);
  const statRowHeight = Math.round(52 * scale);
  const statRowGap = Math.round(10 * scale);
  const gapHeaderStats = Math.round(18 * scale);
  const gapStatsChart = Math.round(20 * scale);
  const width = chartWidth + padding * 2;

  const output = document.createElement("canvas");
  const context = output.getContext("2d");
  if (!context) return undefined;
  // Two rows keep the stats band dense on every strip width; wider strips
  // simply spread the same cells further apart.
  const statRows = layoutStatRows(
    measureStatCells(context, meta.stats, scale),
    width - padding * 2,
    Math.round(26 * scale),
    2,
  );
  const statsHeight = statRows.length * statRowHeight + (statRows.length - 1) * statRowGap;
  const height = padding + headerHeight + gapHeaderStats + statsHeight + gapStatsChart + chartHeight + padding;
  output.width = width;
  output.height = height;

  const accent = difficultyColor(meta.difficultyName);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Same colour as the overview panels: the padding reads as part of the chart.
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  // Header — jacket on the left; the enlarged title with the band mark and
  // band name to its right, then the difficulty pill and the credit row.
  // Every header row shares one left edge (`textLeft`), matching the site
  // brand block on the right edge.
  const textLeft = padding + (jacket ? jacketSize + Math.round(24 * scale) : 0);
  const titleSize = Math.round(40 * scale);
  context.font = `400 ${titleSize}px/${Math.round(50 * scale)}px ${FONT_STACK}`;
  const titleRowCenter = padding + Math.round(34 * scale);
  const titleMaxWidth = width - padding - textLeft - Math.round(320 * scale);
  const title = clampText(context, meta.title, titleMaxWidth);
  const titleDrawnWidth = Math.min(context.measureText(title).width, titleMaxWidth);
  context.fillStyle = "rgba(255,255,255,.94)";
  context.textBaseline = "middle";
  context.fillText(title, textLeft, titleRowCenter);
  if (jacket) {
    context.save();
    roundRect(context, padding, padding, jacketSize, jacketSize, Math.round(16 * scale));
    context.clip();
    context.drawImage(jacket, padding, padding, jacketSize, jacketSize);
    context.restore();
  }

  // Band mark and name sit beside the enlarged title, vertically centered
  // against it.
  const bandMarkSize = Math.round(34 * scale);
  let bandCursor = textLeft + titleDrawnWidth + Math.round(24 * scale);
  if (bandMark) {
    context.drawImage(bandMark, bandCursor, titleRowCenter - bandMarkSize / 2, bandMarkSize, bandMarkSize);
    bandCursor += bandMarkSize + Math.round(14 * scale);
  }
  if (meta.bandName || meta.artist) {
    context.font = `500 ${Math.round(24 * scale)}px/${Math.round(32 * scale)}px ${FONT_STACK}`;
    context.fillStyle = "rgba(255,255,255,.82)";
    context.fillText(
      clampText(context, meta.bandName || meta.artist || "", Math.max(0, width - padding - bandCursor)),
      bandCursor,
      titleRowCenter,
    );
  }
  context.textBaseline = "alphabetic";

  // Pill row — the difficulty pill, then the attribute mark, on the shared
  // left edge.
  const pillTop = padding + pillRowTop;
  const pillLabel = `${meta.difficultyName.toUpperCase()} ${meta.displayLevel}`.trim();
  context.font = `500 ${Math.round(16 * scale)}px/${pillHeight}px ${FONT_STACK}`;
  const pillPadding = Math.round(18 * scale);
  const pillWidth = context.measureText(pillLabel).width + pillPadding * 2;
  context.globalAlpha = 0.32;
  context.fillStyle = accent;
  roundRect(context, textLeft, pillTop, pillWidth, pillHeight, pillHeight / 2);
  context.fill();
  context.globalAlpha = 1;
  context.lineWidth = Math.max(1, Math.round(1.5 * scale));
  context.strokeStyle = accent;
  roundRect(context, textLeft, pillTop, pillWidth, pillHeight, pillHeight / 2);
  context.stroke();
  context.fillStyle = accent;
  context.textBaseline = "middle";
  context.fillText(pillLabel, textLeft + pillPadding, pillTop + pillHeight / 2);
  const cursor = textLeft + pillWidth + Math.round(16 * scale);
  const markSize = Math.round(28 * scale);
  if (attributeMark) {
    context.drawImage(attributeMark, cursor, pillTop + (pillHeight - markSize) / 2, markSize, markSize);
  }
  context.textBaseline = "alphabetic";

  // Credit row — 作曲 · 作词 · 编曲 · 发布 on the shared left edge. Labels
  // share one column width so the values also line up vertically.
  const credits = (meta.credits || []).filter((credit) => credit.value);
  if (credits.length) {
    const creditTop = padding + creditsRowTop;
    context.font = `500 ${Math.round(13 * scale)}px/${Math.round(20 * scale)}px ${FONT_STACK}`;
    const labelWidth = Math.max(...credits.map((credit) => context.measureText(credit.label).width));
    context.textBaseline = "middle";
    let creditCursor = textLeft;
    for (const credit of credits) {
      context.font = `500 ${Math.round(13 * scale)}px/${Math.round(20 * scale)}px ${FONT_STACK}`;
      context.fillStyle = "rgba(255,255,255,.45)";
      context.fillText(credit.label, creditCursor, creditTop);
      context.font = `400 ${Math.round(16 * scale)}px/${Math.round(22 * scale)}px ${FONT_STACK}`;
      context.fillStyle = "rgba(255,255,255,.78)";
      const maxTextWidth = Math.max(0, width - padding - creditCursor - labelWidth - Math.round(10 * scale));
      const text = clampText(context, credit.value, maxTextWidth);
      context.fillText(text, creditCursor + labelWidth + Math.round(10 * scale), creditTop);
      creditCursor += labelWidth + Math.round(10 * scale) + context.measureText(text).width + Math.round(26 * scale);
      if (creditCursor > width - padding) break;
    }
    context.textBaseline = "alphabetic";
  }

  // Top-right corner — site mark, name, URL, the Cassiopeia credit and the
  // song id, all right-aligned on the shared right edge.
  const brandName = "Haneoka";
  const creditLine = "Powered by Cassiopeia from haneoka";
  context.font = `500 ${Math.round(18 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
  const brandNameWidth = context.measureText(brandName).width;
  context.font = `400 ${Math.round(15 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
  const brandUrlWidth = context.measureText("haneoka.org").width;
  const brandGap = Math.round(10 * scale);
  const brandMarkSize = Math.round(26 * scale);
  const brandRight =
    padding + brandMarkSize + brandGap + brandNameWidth + brandGap + brandUrlWidth;
  let brandCursor = width - brandRight;
  if (brandMarkSmall) {
    context.drawImage(brandMarkSmall, brandCursor, padding + Math.round(2 * scale), brandMarkSize, brandMarkSize);
  }
  brandCursor += brandMarkSize + brandGap;
  context.textBaseline = "middle";
  context.font = `500 ${Math.round(18 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
  context.fillStyle = "rgba(255,255,255,.92)";
  context.fillText(brandName, brandCursor, padding + Math.round(15 * scale));
  brandCursor += brandNameWidth + brandGap;
  context.font = `400 ${Math.round(15 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
  context.fillStyle = "rgba(255,255,255,.55)";
  context.fillText("haneoka.org", brandCursor, padding + Math.round(15 * scale));
  context.textAlign = "right";
  context.font = `400 ${Math.round(14 * scale)}px/${Math.round(20 * scale)}px ${FONT_STACK}`;
  context.fillStyle = "rgba(255,255,255,.45)";
  context.fillText(creditLine, width - padding, padding + Math.round(42 * scale));
  if (meta.songId !== undefined && meta.songId !== "") {
    context.fillText(`ID ${meta.songId}`, width - padding, padding + Math.round(64 * scale));
  }
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  // Stats grid — label over value on the shared left edge, each row spread
  // across the strip width.
  let statsTop = padding + headerHeight + gapHeaderStats;
  for (const row of statRows) {
    const rowWidth = row.reduce((total, cell) => total + cell.width, 0);
    const gap = row.length > 1 ? (width - padding * 2 - rowWidth) / (row.length - 1) : 0;
    // First cell pins to the shared left edge; the rest spread evenly.
    let rowCursor = padding;
    for (const cell of row) {
      context.font = `500 ${Math.round(12.5 * scale)}px/${Math.round(16 * scale)}px ${FONT_STACK}`;
      context.fillStyle = "rgba(255,255,255,.5)";
      context.fillText(cell.label, rowCursor, statsTop + Math.round(11 * scale));
      context.font = `500 ${Math.round(20 * scale)}px/${Math.round(26 * scale)}px ${FONT_STACK}`;
      context.fillStyle = "rgba(255,255,255,.92)";
      context.fillText(cell.value, rowCursor, statsTop + Math.round(39 * scale));
      rowCursor += cell.width + gap;
    }
    statsTop += statRowHeight + statRowGap;
  }

  // Chart strip — the export ends flush with the strip: no footer band.
  context.drawImage(
    canvas,
    padding,
    padding + headerHeight + gapHeaderStats + statsHeight + gapStatsChart,
    chartWidth,
    chartHeight,
  );

  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
  return blob || undefined;
}

export function downloadChartOverviewImage(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
