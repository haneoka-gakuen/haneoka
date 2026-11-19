// L3 — GEB
// Input: Selected dialogue, loaded portraits, reader theme and a source link.
// Output: A bounded PNG download with chapter and authoring-site attribution.
// Pos: [Map](L2-2.md); lazy transcript share renderer.
// Effects/Dependencies: Draws locally on a canvas and reuses loaded portraits.
import { canvasToPngBlob, downloadBlob } from "./canvas-capture";

interface ExcerptLine {
  speaker: string;
  text: string;
  portraits: readonly HTMLImageElement[];
}

interface Excerpt {
  title: string;
  chapter: string;
  source: string;
  lines: readonly ExcerptLine[];
  style: CSSStyleDeclaration;
  locale: string;
  active: () => boolean;
}

function wrap(
  context: CanvasRenderingContext2D,
  text: string,
  width: number,
  words: Intl.Segmenter,
  graphemes: Intl.Segmenter,
): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    let row = "";
    const append = (segment: string) => {
      if (row && context.measureText(row + segment).width > width) {
        rows.push(row.trimEnd());
        row = segment.trimStart();
      } else row += segment;
    };
    for (const { segment } of words.segment(paragraph)) {
      if (context.measureText(segment).width <= width) append(segment);
      else for (const part of graphemes.segment(segment)) append(part.segment);
    }
    rows.push(row.trimEnd());
  }
  return rows;
}

function drawPortrait(
  target: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  source: HTMLImageElement,
  x: number,
  y: number,
) {
  const size = scratch.canvas.width;
  scratch.canvas.width = size;
  const scale = Math.min(size / source.naturalWidth, size / source.naturalHeight);
  const width = source.naturalWidth * scale;
  const height = source.naturalHeight * scale;
  scratch.drawImage(source, (size - width) / 2, (size - height) / 2, width, height);
  try {
    // A redirected or external image must not taint the finished download.
    scratch.getImageData(0, 0, 1, 1);
  } catch {
    return;
  }
  target.save();
  target.beginPath();
  target.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  target.clip();
  target.drawImage(scratch.canvas, x, y);
  target.restore();
}

export async function exportStoryExcerpt(excerpt: Excerpt): Promise<void> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const portraitCanvas = document.createElement("canvas");
  portraitCanvas.width = portraitCanvas.height = 32;
  const portraitContext = portraitCanvas.getContext("2d", { willReadFrequently: true });
  if (!context || !portraitContext) throw new Error("Canvas unavailable");
  const width = 620;
  const inset = 32;
  const words = new Intl.Segmenter(excerpt.locale, { granularity: "word" });
  const graphemes = new Intl.Segmenter(excerpt.locale, { granularity: "grapheme" });
  const family = excerpt.style.fontFamily;
  const font = (weight: number, size: number) => `${weight} ${size}px ${family}`;
  const color = (name: string) => excerpt.style.getPropertyValue(`--md-sys-color-${name}`).trim();
  const measure = (value: string, size: number, weight: number, available: number) => {
    context.font = font(weight, size);
    return value ? wrap(context, value, available, words, graphemes) : [];
  };
  const logo = new Image();
  logo.src = "/favicon.svg";
  const [logoReady] = await Promise.all([
    logo.decode().then(
      () => true,
      () => false,
    ),
    document.fonts.ready,
  ]);
  if (!excerpt.active()) return;
  const headerWidth = width - inset * 2;
  const title = measure(excerpt.title, 31, 700, headerWidth);
  const chapter = measure(excerpt.chapter, 16, 550, headerWidth);
  const source = measure(excerpt.source, 13, 400, headerWidth);
  const rows = excerpt.lines.map((line) => ({
    ...line,
    speakerRows: measure(line.speaker, 16, 650, headerWidth - 28 - Math.min(3, line.portraits.length) * 36),
    bodyRows: measure(line.text, 19, 400, headerWidth - 32),
  }));
  const headerHeight = 82 + title.length * 40 + chapter.length * 23;
  const rowHeight = (row: (typeof rows)[number]) =>
    28 + row.bodyRows.length * 29 + (row.speakerRows.length ? Math.max(36, row.speakerRows.length * 22) : 0);
  const height = headerHeight + rows.reduce((sum, row) => sum + rowHeight(row) + 12, 0) + 44 + source.length * 18;
  if (height > 4800) throw new RangeError("Excerpt image is too tall");
  canvas.width = width * 2;
  canvas.height = height * 2;
  try {
    context.scale(2, 2);
    context.fillStyle = color("surface");
    context.fillRect(0, 0, width, height);
    context.fillStyle = color("primary");
    context.fillRect(0, 0, width, 6);
    const write = (
      lines: readonly string[],
      x: number,
      top: number,
      size: number,
      weight: number,
      leading: number,
      ink: string,
    ) => {
      context.font = font(weight, size);
      context.fillStyle = color(ink);
      context.textBaseline = "top";
      for (const [index, line] of lines.entries()) context.fillText(line, x, top + index * leading);
    };
    if (logoReady) context.drawImage(logo, inset, 22, 32, 32);
    write(["haneoka"], inset + (logoReady ? 44 : 0), 28, 23, 750, 26, "primary");
    write(title, inset, 67, 31, 700, 40, "on-surface");
    write(chapter, inset, 67 + title.length * 40, 16, 550, 23, "on-surface-variant");
    let y = headerHeight;
    for (const row of rows) {
      const blockHeight = rowHeight(row);
      context.fillStyle = color("surface-container-low");
      context.beginPath();
      context.roundRect(inset, y, headerWidth, blockHeight, 18);
      context.fill();
      const portraits = row.speakerRows.length ? row.portraits.slice(0, 3) : [];
      portraits.forEach((portrait, index) => {
        drawPortrait(context, portraitContext, portrait, inset + 16 + index * 36, y + 10);
      });
      write(row.speakerRows, inset + 16 + portraits.length * 36, y + 14, 16, 650, 22, "primary");
      const bodyY = y + 14 + (row.speakerRows.length ? Math.max(36, row.speakerRows.length * 22) : 0);
      write(row.bodyRows, inset + 16, bodyY, 19, 400, 29, "on-surface");
      y += blockHeight + 12;
    }
    write(source, inset, y + 20, 13, 400, 18, "on-surface-variant");
    const image = await canvasToPngBlob(canvas);
    if (excerpt.active()) await downloadBlob(image, `haneoka - ${excerpt.title}.png`);
  } finally {
    canvas.width = canvas.height = 1;
  }
}
