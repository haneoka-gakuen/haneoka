// Input: A frozen localized rating report and the current theme.
// Output: Overview or Best 20 PNG with player identity, team and site branding.
// Pos: [Map](L2-2.md); song-progress image export.
// Effects/Dependencies: Loads only report artwork with bounded concurrency and renders locally to Canvas.
import { drawExportBrand, HANEOKA_EXPORT_BRAND } from "./export-brand";

export interface SongProgressImageReport {
  title: string;
  generated: string;
  version: string;
  server: string;
  profile: {
    name: string;
    uid: string;
    rank: string;
    avatar?: string;
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
    status: string;
    image?: string;
  }[];
  team: {
    label: string;
    image?: string;
  }[];
  teamLabel: string;
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
const MAIN_HEIGHT = 1600;
const PAD = 40;
const CONTENT_WIDTH = CANVAS_WIDTH - PAD * 2;
const IMAGE_TIMEOUT_MS = 8000;
const IMAGE_CONCURRENCY = 4;
const MAIN_SONGS_LIMIT = 8;
const DETAILED_SONGS_LIMIT = 20;
const TEAM_LIMIT = 10;
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

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low) + ellipsis;
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
  const team = detailed ? [] : report.team.slice(0, TEAM_LIMIT);
  const metrics = report.metrics.slice(0, METRICS_LIMIT);
  const counts = report.counts.slice(0, COUNTS_LIMIT);
  const brandLogoUrl = getBrandLogoUrl();

  const sourcesToLoad: (string | undefined)[] = [
    brandLogoUrl,
    report.profile.avatar,
    ...songs.map((s) => s.image),
    ...team.map((t) => t.image),
  ];
  const images = await loadImagesBounded(sourcesToLoad);
  const brandLogo = brandLogoUrl ? (images.get(brandLogoUrl) ?? null) : null;

  const rowHeightDetailed = 84;
  const rowGapDetailed = 10;
  const detailedListStart = 758;
  const detailedFooterHeight = 76;
  const detailedSongsHeight =
    songs.length > 0 ? songs.length * rowHeightDetailed + (songs.length - 1) * rowGapDetailed : 0;
  const canvasHeight = detailed
    ? Math.max(960, detailedListStart + detailedSongsHeight + detailedFooterHeight)
    : MAIN_HEIGHT;

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

  ctx.fillStyle = theme.variant;
  ctx.font = `500 18px ${theme.font}`;
  drawTextFit(ctx, report.server, PAD, 76, headerTextMaxWidth, "left");

  const profileY = 122;
  const profileH = 96;
  drawCard(ctx, PAD, profileY, CONTENT_WIDTH, profileH, 20, theme.surfaceContainer, theme.outlineVariant);

  const avatarSize = 68;
  const avatarImg = report.profile.avatar ? images.get(report.profile.avatar) : null;
  drawImageOrPlaceholder(
    ctx,
    avatarImg,
    PAD + 16,
    profileY + 14,
    avatarSize,
    avatarSize,
    16,
    theme,
    report.profile.name,
  );

  const profileTextX = PAD + 16 + avatarSize + 18;
  const profileNameMaxW = CONTENT_WIDTH - (profileTextX - PAD) - 220;
  ctx.fillStyle = theme.onSurface;
  ctx.font = `700 26px ${theme.font}`;
  drawTextFit(ctx, report.profile.name, profileTextX, profileY + 20, profileNameMaxW, "left");

  ctx.fillStyle = theme.variant;
  ctx.font = `500 18px ${theme.font}`;
  drawTextFit(ctx, report.profile.uid, profileTextX, profileY + 54, profileNameMaxW, "left");

  ctx.fillStyle = theme.primary;
  ctx.font = `700 22px ${theme.font}`;
  drawTextFit(ctx, report.profile.rank, PAD + CONTENT_WIDTH - 20, profileY + 35, 190, "right");

  const metricsStartY = 236;
  const metricGap = 16;
  const metricW = (CONTENT_WIDTH - metricGap * 2) / 3;
  const metricH = 88;

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

  const tableY = 446;
  const tableHeaderH = 40;
  const tableRowH = 42;
  const tableH = tableHeaderH + counts.length * tableRowH + 8;
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

  let nextSectionY = tableY + tableH + 22;

  if (!detailed && team.length > 0) {
    ctx.fillStyle = theme.onSurface;
    ctx.font = `700 20px ${theme.font}`;
    drawTextFit(ctx, report.teamLabel, PAD, nextSectionY, CONTENT_WIDTH, "left");

    const teamStartY = nextSectionY + 32;
    const teamGapX = 14;
    const teamGapY = 12;
    const teamCardW = (CONTENT_WIDTH - teamGapX * 4) / 5;
    const teamCardH = 108;

    team.forEach((member, index) => {
      const col = index % 5;
      const row = Math.floor(index / 5);
      const x = PAD + col * (teamCardW + teamGapX);
      const y = teamStartY + row * (teamCardH + teamGapY);

      drawCard(ctx, x, y, teamCardW, teamCardH, 14, theme.surfaceContainer, theme.outlineVariant);
      const thumbSize = 64;
      const thumbImg = member.image ? images.get(member.image) : null;
      drawImageOrPlaceholder(
        ctx,
        thumbImg,
        x + (teamCardW - thumbSize) / 2,
        y + 10,
        thumbSize,
        thumbSize,
        12,
        theme,
        member.label,
      );

      ctx.fillStyle = theme.onSurface;
      ctx.font = `500 14px ${theme.font}`;
      drawTextFit(ctx, member.label, x + teamCardW / 2, y + 82, teamCardW - 16, "center");
    });

    nextSectionY = teamStartY + 2 * teamCardH + teamGapY + 22;
  }

  ctx.fillStyle = theme.onSurface;
  ctx.font = `700 20px ${theme.font}`;
  drawTextFit(ctx, report.bestTitle, PAD, nextSectionY, CONTENT_WIDTH, "left");
  const songsStartY = nextSectionY + 32;

  if (detailed) {
    songs.forEach((song, index) => {
      const y = songsStartY + index * (rowHeightDetailed + rowGapDetailed);
      drawCard(ctx, PAD, y, CONTENT_WIDTH, rowHeightDetailed, 14, theme.surfaceContainer, theme.outlineVariant);

      const thumbSize = 60;
      const songImg = song.image ? images.get(song.image) : null;
      drawImageOrPlaceholder(ctx, songImg, PAD + 14, y + 12, thumbSize, thumbSize, 10, theme, song.title);

      ctx.fillStyle = theme.variant;
      ctx.font = `700 18px ${theme.font}`;
      drawTextFit(ctx, String(index + 1), PAD + 88, y + 32, 36, "left");

      ctx.fillStyle = theme.onSurface;
      ctx.font = `600 20px ${theme.font}`;
      drawTextFit(ctx, song.title, PAD + 130, y + 18, CONTENT_WIDTH - 330, "left");

      ctx.fillStyle = theme.variant;
      ctx.font = `500 16px ${theme.font}`;
      drawTextFit(ctx, song.level, PAD + 130, y + 48, CONTENT_WIDTH - 330, "left");

      ctx.fillStyle = theme.primary;
      ctx.font = `700 20px ${theme.font}`;
      drawTextFit(ctx, song.status, PAD + CONTENT_WIDTH - 20, y + 31, 170, "right");
    });
  } else {
    const songGapX = 16;
    const songGapY = 12;
    const songCardW = (CONTENT_WIDTH - songGapX) / 2;
    const songCardH = 110;

    songs.forEach((song, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = PAD + col * (songCardW + songGapX);
      const y = songsStartY + row * (songCardH + songGapY);

      drawCard(ctx, x, y, songCardW, songCardH, 16, theme.surfaceContainer, theme.outlineVariant);
      const thumbSize = 78;
      const songImg = song.image ? images.get(song.image) : null;
      drawImageOrPlaceholder(ctx, songImg, x + 14, y + 16, thumbSize, thumbSize, 12, theme, song.title);

      const textX = x + 14 + thumbSize + 14;
      const textMaxW = songCardW - (textX - x) - 16;

      ctx.fillStyle = theme.onSurface;
      ctx.font = `600 18px ${theme.font}`;
      drawTextFit(ctx, song.title, textX, y + 18, textMaxW, "left");

      ctx.fillStyle = theme.variant;
      ctx.font = `500 15px ${theme.font}`;
      drawTextFit(ctx, song.level, textX, y + 48, textMaxW, "left");

      ctx.fillStyle = theme.primary;
      ctx.font = `700 16px ${theme.font}`;
      drawTextFit(ctx, song.status, textX, y + 74, textMaxW, "left");
    });
  }

  const footerY = canvasHeight - 40;
  ctx.fillStyle = theme.variant;
  ctx.font = `500 15px ${theme.font}`;
  const footerLeft = [report.generated, report.version, report.server].filter(Boolean).join(" · ");
  drawTextFit(ctx, footerLeft, PAD, footerY, CONTENT_WIDTH - 240, "left");

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
