// L3 — GEB
// Input: A frozen localized rating report and the current theme.
// Output: Overview or Best 20 PNG with player identity, song marks and site branding.
// Pos: [Map](L2-2.md); song-progress image export.
// Effects/Dependencies: Loads only report artwork with bounded concurrency and renders locally to Canvas.
import { drawExportBrand, HANEOKA_EXPORT_BRAND } from "./export-brand";

export interface SongProgressImageReport {
  title: string;
  generated: string;
  profile: {
    name: string;
    uid: string;
    rank: string;
    region: string;
  };
  metrics: {
    label: string;
    value: string;
    detail?: string;
  }[];
  counts: {
    label: string;
    clear: number | string;
    fc: number | string;
    ap: number | string;
  }[];
  countHeaders: [string, string, string];
  songs: {
    title: string;
    level: string;
    image: string;
    attributeIcon: string;
    bandIcons: string[];
  }[];
  bestTitle: string;
}

interface ThemePalette {
  font: string;
  surface: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  onSurface: string;
  variant: string;
  primary: string;
  tertiary: string;
  outlineVariant: string;
}

const CANVAS_WIDTH = 1080;
const PAD = 40;
const CONTENT_WIDTH = CANVAS_WIDTH - PAD * 2;
const IMAGE_TIMEOUT_MS = 8000;
const IMAGE_CONCURRENCY = 4;
const MAIN_SONGS_LIMIT = 8;
const DETAILED_SONGS_LIMIT = 20;
const COUNTS_LIMIT = 5;
const METRICS_LIMIT = 6;

function captureTheme(): ThemePalette {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  const read = (name: string): string => rootStyle.getPropertyValue(name).trim();

  const surface = read("--md-sys-color-surface");
  const surfaceContainer = read("--md-sys-color-surface-container") || surface;
  const surfaceContainerHigh = read("--md-sys-color-surface-container-high") || surfaceContainer;
  const onSurface = read("--md-sys-color-on-surface");
  const variant = read("--md-sys-color-on-surface-variant") || onSurface;
  const primary = read("--md-sys-color-primary") || onSurface;
  const tertiary = read("--md-sys-color-tertiary") || primary;
  const outlineVariant = read("--md-sys-color-outline-variant") || variant;
  const font = bodyStyle.fontFamily || "sans-serif";

  return {
    font,
    surface,
    surfaceContainer,
    surfaceContainerHigh,
    onSurface,
    variant,
    primary,
    tertiary,
    outlineVariant,
  };
}

function loadSingleImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;

    const finish = (result: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };

    const timer = window.setTimeout(() => finish(null), IMAGE_TIMEOUT_MS);
    img.crossOrigin = "anonymous";
    img.onload = () => finish(img.naturalWidth > 0 ? img : null);
    img.onerror = () => finish(null);
    img.src = src;
  });
}

async function loadImagesBounded(sources: (string | undefined)[]): Promise<Map<string, HTMLImageElement | null>> {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const raw of sources) {
    const src = raw?.trim();
    if (src && !seen.has(src)) {
      seen.add(src);
      unique.push(src);
    }
  }

  const results = new Map<string, HTMLImageElement | null>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const src = unique[index];
      results.set(src, await loadSingleImage(src));
    }
  };

  const workerCount = Math.min(IMAGE_CONCURRENCY, unique.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function getBrandLogoUrl(): string | undefined {
  const brandRecord = HANEOKA_EXPORT_BRAND as Record<string, unknown>;
  for (const key of ["logoUrl", "logoSrc", "logo"]) {
    const value = brandRecord[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth >= maxWidth) return "";

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, mid).join("") + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return characters.slice(0, low).join("") + ellipsis;
}

function drawTextFit(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: CanvasTextAlign = "left",
): void {
  ctx.textAlign = align;
  ctx.fillText(ellipsize(ctx, text, maxWidth), x, y);
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  stroke: string,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawImageOrPlaceholder(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  theme: ThemePalette,
  fallbackLabel = "",
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();

  if (img) {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
  } else {
    ctx.fillStyle = theme.surfaceContainerHigh;
    ctx.fillRect(x, y, w, h);
    if (fallbackLabel) {
      ctx.fillStyle = theme.variant;
      ctx.font = `600 ${Math.round(Math.min(w, h) * 0.34)}px ${theme.font}`;
      ctx.textBaseline = "middle";
      drawTextFit(ctx, fallbackLabel.slice(0, 2).toUpperCase(), x + w / 2, y + h / 2, w - 12, "center");
    }
  }
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.outlineVariant;
  ctx.stroke();
}

export async function renderSongProgressImage(report: SongProgressImageReport, detailed = false): Promise<Blob> {
  await document.fonts.ready;
  const theme = captureTheme();

  const songs = report.songs.slice(0, detailed ? DETAILED_SONGS_LIMIT : MAIN_SONGS_LIMIT);
  const metrics = report.metrics.slice(0, METRICS_LIMIT);
  const counts = report.counts.slice(0, COUNTS_LIMIT);
  const brandLogoUrl = getBrandLogoUrl();

  const images = await loadImagesBounded([
    brandLogoUrl,
    ...songs.flatMap((song) => [song.image, song.attributeIcon, ...song.bandIcons]),
  ]);
  const brandLogo = brandLogoUrl ? (images.get(brandLogoUrl) ?? null) : null;
  const profileY = 96;
  const hasProfile = Object.values(report.profile).some(Boolean);
  const profileH = 80;
  const metricsStartY = profileY + (hasProfile ? profileH + 18 : 0);
  const metricGap = 16;
  const metricW = (CONTENT_WIDTH - metricGap * 2) / 3;
  const metricH = 88;
  const tableY = metricsStartY + Math.ceil(metrics.length / 3) * (metricH + metricGap) + 8;
  const tableHeaderH = 40;
  const tableRowH = 42;
  const tableH = tableHeaderH + counts.length * tableRowH + 8;
  const nextSectionY = tableY + tableH + 22;
  const songsStartY = nextSectionY + 32;
  const songGapX = 16;
  const songGapY = detailed ? 10 : 12;
  const songCardW = detailed ? CONTENT_WIDTH : (CONTENT_WIDTH - songGapX) / 2;
  const songCardH = detailed ? 84 : 110;
  const songRows = Math.ceil(songs.length / (detailed ? 1 : 2));
  const canvasHeight = songsStartY + songRows * (songCardH + songGapY) + 60;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, CANVAS_WIDTH, canvasHeight);

  drawExportBrand(
    ctx,
    { font: theme.font, onSurface: theme.onSurface, variant: theme.variant },
    HANEOKA_EXPORT_BRAND,
    brandLogo,
    CANVAS_WIDTH,
    PAD,
  );

  const brandReservedWidth = 360;
  const headerTextMaxWidth = CONTENT_WIDTH - brandReservedWidth;

  ctx.textBaseline = "top";
  ctx.fillStyle = theme.onSurface;
  ctx.font = `700 32px ${theme.font}`;
  drawTextFit(ctx, report.title, PAD, 34, headerTextMaxWidth, "left");

  if (hasProfile) {
    drawCard(ctx, PAD, profileY, CONTENT_WIDTH, profileH, 20, theme.surfaceContainer, theme.outlineVariant);
    const left = PAD + 20;
    const right = PAD + CONTENT_WIDTH - 20;
    const paired = Boolean(report.profile.name && report.profile.uid);
    ctx.fillStyle = theme.onSurface;
    ctx.font = `700 26px ${theme.font}`;
    drawTextFit(ctx, report.profile.name || report.profile.uid, left, profileY + (paired ? 12 : 26), CONTENT_WIDTH - 400);
    if (paired) {
      ctx.fillStyle = theme.variant;
      ctx.font = `500 18px ${theme.font}`;
      drawTextFit(ctx, report.profile.uid, left, profileY + 47, CONTENT_WIDTH - 400);
    }
    ctx.fillStyle = theme.primary;
    ctx.font = `700 22px ${theme.font}`;
    const hasTwo = Boolean(report.profile.region && report.profile.rank);
    drawTextFit(ctx, report.profile.region || report.profile.rank, right, profileY + (hasTwo ? 13 : 27), 330, "right");
    if (hasTwo) {
      ctx.fillStyle = theme.variant;
      ctx.font = `500 18px ${theme.font}`;
      drawTextFit(ctx, report.profile.rank, right, profileY + 45, 330, "right");
    }
  }

  metrics.forEach((metric, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = PAD + col * (metricW + metricGap);
    const y = metricsStartY + row * (metricH + metricGap);

    drawCard(ctx, x, y, metricW, metricH, 16, theme.surfaceContainer, theme.outlineVariant);

    ctx.fillStyle = theme.variant;
    ctx.font = `500 15px ${theme.font}`;
    drawTextFit(ctx, metric.label, x + 16, y + 14, metricW - 32, "left");

    ctx.fillStyle = index === 0 ? theme.primary : index === 1 ? theme.tertiary : theme.onSurface;
    ctx.font = `700 28px ${theme.font}`;
    const valueMaxW = metric.detail ? metricW - 120 : metricW - 32;
    drawTextFit(ctx, metric.value, x + 16, y + 40, valueMaxW, "left");

    if (metric.detail) {
      ctx.fillStyle = theme.variant;
      ctx.font = `500 15px ${theme.font}`;
      drawTextFit(ctx, metric.detail, x + metricW - 16, y + 48, 96, "right");
    }
  });

  drawCard(ctx, PAD, tableY, CONTENT_WIDTH, tableH, 18, theme.surfaceContainer, theme.outlineVariant);

  const colLabelX = PAD + 20;
  const col1X = PAD + CONTENT_WIDTH - 360;
  const col2X = PAD + CONTENT_WIDTH - 190;
  const col3X = PAD + CONTENT_WIDTH - 24;

  ctx.fillStyle = theme.variant;
  ctx.font = `600 16px ${theme.font}`;
  drawTextFit(ctx, report.countHeaders[0], col1X, tableY + 13, 140, "right");
  drawTextFit(ctx, report.countHeaders[1], col2X, tableY + 13, 140, "right");
  drawTextFit(ctx, report.countHeaders[2], col3X, tableY + 13, 140, "right");

  counts.forEach((row, index) => {
    const ry = tableY + tableHeaderH + index * tableRowH;
    ctx.beginPath();
    ctx.moveTo(PAD + 16, ry);
    ctx.lineTo(PAD + CONTENT_WIDTH - 16, ry);
    ctx.strokeStyle = theme.outlineVariant;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = theme.onSurface;
    ctx.font = `600 18px ${theme.font}`;
    drawTextFit(ctx, row.label, colLabelX, ry + 12, CONTENT_WIDTH - 460, "left");

    ctx.font = `600 18px ${theme.font}`;
    ctx.fillStyle = theme.onSurface;
    drawTextFit(ctx, String(row.clear), col1X, ry + 12, 140, "right");
    ctx.fillStyle = theme.primary;
    drawTextFit(ctx, String(row.fc), col2X, ry + 12, 140, "right");
    ctx.fillStyle = theme.tertiary;
    drawTextFit(ctx, String(row.ap), col3X, ry + 12, 140, "right");
  });

  ctx.fillStyle = theme.onSurface;
  ctx.font = `700 20px ${theme.font}`;
  drawTextFit(ctx, report.bestTitle, PAD, nextSectionY, CONTENT_WIDTH, "left");
  songs.forEach((song, index) => {
    const col = detailed ? 0 : index % 2;
    const row = detailed ? index : Math.floor(index / 2);
    const x = PAD + col * (songCardW + songGapX);
    const y = songsStartY + row * (songCardH + songGapY);
    drawCard(ctx, x, y, songCardW, songCardH, 16, theme.surfaceContainer, theme.outlineVariant);

    const thumbSize = detailed ? 60 : 78;
    const thumbX = x + 14;
    const thumbY = y + (songCardH - thumbSize) / 2;
    drawImageOrPlaceholder(ctx, images.get(song.image), thumbX, thumbY, thumbSize, thumbSize, 10, theme, song.title);

    if (detailed) {
      ctx.fillStyle = theme.variant;
      ctx.font = `700 18px ${theme.font}`;
      drawTextFit(ctx, String(index + 1), x + 88, y + 32, 32);
    }

    const textX = detailed ? x + 130 : thumbX + thumbSize + 14;
    const textMaxW = x + songCardW - 16 - textX;
    ctx.textBaseline = "top";
    ctx.fillStyle = theme.onSurface;
    ctx.font = `600 ${detailed ? 20 : 18}px ${theme.font}`;
    const titleY = y + (detailed ? 18 : 28);
    const attribute = images.get(song.attributeIcon);
    if (attribute) ctx.drawImage(attribute, textX, titleY, 20, 20);
    const titleIndent = attribute ? 26 : 0;
    drawTextFit(ctx, song.title, textX + titleIndent, titleY, textMaxW - titleIndent);

    const bandY = y + (detailed ? 48 : 58);
    let metadataX = textX;
    for (const icon of song.bandIcons) {
      const band = images.get(icon);
      if (!band || metadataX + 20 > x + songCardW - 80) continue;
      ctx.drawImage(band, metadataX, bandY - 1, 20, 20);
      metadataX += 24;
    }
    ctx.fillStyle = theme.variant;
    ctx.font = `500 16px ${theme.font}`;
    drawTextFit(ctx, song.level, metadataX, bandY, textMaxW - (metadataX - textX));
  });

  const footerY = canvasHeight - 40;
  ctx.fillStyle = theme.variant;
  ctx.font = `500 15px ${theme.font}`;
  drawTextFit(ctx, report.generated, PAD, footerY, CONTENT_WIDTH - 240, "left");

  const brandUrl =
    typeof (HANEOKA_EXPORT_BRAND as Record<string, unknown>).url === "string"
      ? String((HANEOKA_EXPORT_BRAND as Record<string, unknown>).url)
      : "";
  if (brandUrl) {
    drawTextFit(ctx, brandUrl, PAD + CONTENT_WIDTH, footerY, 220, "right");
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to encode PNG blob"));
      }
    }, "image/png");
  });
}
