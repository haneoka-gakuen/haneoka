/** PNG exports of a recruitment simulation: every draw, or the merged summary. */

export interface GachaImageCard {
  kind: "member" | "support" | "item";
  rarity: number;
  pickup: boolean;
  image: string;
  attribute: string;
  /** The rarity emblem's image. */
  rarityMark: string;
  count: number;
}

export interface GachaImageInput {
  mode: "pulls" | "stats";
  title: string;
  subtitle: string;
  /** One line per card kind; an empty label for marks such as UP. */
  summary: Array<{ label: string; entries: Array<{ image?: string; label: string; count: number }> }>;
  batches: Array<{ label: string; rows: Array<{ label: string; cards: GachaImageCard[] }> }>;
  groups: Array<{ kind: string; label: string; cards: GachaImageCard[] }>;
  brand: { name: string; url: string; logo: string };
}

const PAD = 40;
const GAP = 8;
const WIDTH = 1200;

function tokens() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    surface: value("--md-sys-color-surface", "#fdf8fd"),
    container: value("--md-sys-color-surface-container", "#f1ecf1"),
    containerHigh: value("--md-sys-color-surface-container-highest", "#e6e1e6"),
    onSurface: value("--md-sys-color-on-surface", "#1c1b1f"),
    variant: value("--md-sys-color-on-surface-variant", "#49454f"),
    outline: value("--md-sys-color-outline-variant", "#cac4d0"),
    primary: value("--md-sys-color-primary", "#65558f"),
    onPrimary: value("--md-sys-color-on-primary", "#ffffff"),
    tertiary: value("--md-sys-color-tertiary-container", "#ffd8e4"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
  };
}

const images = new Map<string, Promise<HTMLImageElement | null>>();
const ready = new Map<string, HTMLImageElement | null>();
const loaded = (source: string) => ready.get(source) ?? null;
function load(source: string) {
  if (!source) return Promise.resolve(null);
  let pending = images.get(source);
  if (!pending) {
    pending = new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => {
        ready.set(source, image);
        resolve(image);
      };
      image.onerror = () => resolve(null);
      image.src = source;
    });
    images.set(source, pending);
  }
  return pending;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function contain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (!image) return;
  const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

type Theme = ReturnType<typeof tokens>;

function badge(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  text: string,
  x: number,
  y: number,
  align: "start" | "end",
  fill: string,
  color: string,
) {
  ctx.font = `700 15px ${theme.font}`;
  const w = ctx.measureText(text).width + 12;
  const left = align === "start" ? x : x - w;
  ctx.fillStyle = fill;
  roundRect(ctx, left, y - 22, w, 22, 11);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, left + w / 2, y - 11);
  ctx.textAlign = "start";
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  card: GachaImageCard,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = card.rarity >= 4 ? theme.tertiary : theme.container;
  ctx.fill();
  ctx.clip();
  contain(ctx, loaded(card.image), x + 2, y + 2, w - 4, h - 4);
  ctx.restore();
  const mark = Math.round(Math.min(w, h) * 0.24);
  contain(ctx, loaded(card.attribute), x + 4, y + 4, mark, mark);
  contain(ctx, loaded(card.rarityMark), x + w - mark - 4, y + 4, mark, mark);
  if (card.pickup) badge(ctx, theme, "UP", x + 4, y + h - 4, "start", theme.primary, theme.onPrimary);
  if (card.count) badge(ctx, theme, `×${card.count}`, x + w - 4, y + h - 4, "end", "rgba(0, 0, 0, 0.72)", "#ffffff");
}

function chip(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  entry: { image?: string; label: string; count: number },
  x: number,
  y: number,
) {
  ctx.font = `600 18px ${theme.font}`;
  const text = entry.count.toLocaleString();
  const mark = loaded(entry.image || "");
  const lead = mark ? 28 : ctx.measureText(entry.label).width;
  const w = 12 + lead + 8 + ctx.measureText(text).width + 14;
  ctx.strokeStyle = theme.outline;
  roundRect(ctx, x, y, w, 40, 8);
  ctx.stroke();
  ctx.textBaseline = "middle";
  if (mark) contain(ctx, mark, x + 12, y + 6, 28, 28);
  else {
    ctx.fillStyle = theme.primary;
    ctx.fillText(entry.label, x + 12, y + 20);
  }
  ctx.fillStyle = theme.onSurface;
  ctx.fillText(text, x + 12 + lead + 8, y + 20);
  return w;
}

/** Logo, site name and address, right-aligned; returns the width taken. */
function brand(ctx: CanvasRenderingContext2D, theme: Theme, input: GachaImageInput) {
  const right = WIDTH - PAD;
  ctx.textBaseline = "top";
  ctx.textAlign = "end";
  ctx.font = `600 22px ${theme.font}`;
  const nameWidth = ctx.measureText(input.brand.name).width;
  ctx.fillStyle = theme.onSurface;
  ctx.fillText(input.brand.name, right, PAD + 2);
  ctx.font = `400 15px ${theme.font}`;
  const urlWidth = ctx.measureText(input.brand.url).width;
  ctx.fillStyle = theme.variant;
  ctx.fillText(input.brand.url, right, PAD + 32);
  ctx.textAlign = "start";
  const text = Math.max(nameWidth, urlWidth);
  contain(ctx, loaded(input.brand.logo), right - text - 12 - 52, PAD, 52, 52);
  return text + 12 + 52 + 24;
}

function header(ctx: CanvasRenderingContext2D | null, theme: Theme, input: GachaImageInput) {
  let y = PAD;
  if (ctx) {
    const width = WIDTH - PAD * 2 - brand(ctx, theme, input);
    ctx.fillStyle = theme.onSurface;
    ctx.textBaseline = "top";
    ctx.font = `600 30px ${theme.font}`;
    ctx.fillText(input.title, PAD, y, width);
    ctx.fillStyle = theme.variant;
    ctx.font = `400 18px ${theme.font}`;
    ctx.fillText(input.subtitle, PAD, y + 44, width);
  }
  y += 84;
  const labelWidth = 120;
  for (const line of input.summary) {
    if (ctx) {
      ctx.fillStyle = theme.variant;
      ctx.font = `500 17px ${theme.font}`;
      ctx.textBaseline = "middle";
      ctx.fillText(line.label, PAD, y + 20, labelWidth - 12);
      let x = PAD + labelWidth;
      for (const entry of line.entries) x += chip(ctx, theme, entry, x, y) + GAP;
    }
    y += 40 + GAP;
  }
  return y + 16;
}

async function render(ctx: CanvasRenderingContext2D | null, theme: Theme, input: GachaImageInput): Promise<number> {
  let y = header(ctx, theme, input);
  const inner = WIDTH - PAD * 2;
  if (input.mode === "pulls") {
    const label = 64;
    const columns = 10;
    const cell = Math.floor((inner - label - GAP * (columns - 1)) / columns);
    for (const [index, batch] of input.batches.entries()) {
      if (ctx) {
        ctx.fillStyle = theme.onSurface;
        ctx.font = `600 20px ${theme.font}`;
        ctx.textBaseline = "top";
        ctx.fillText(`${index + 1}  ${batch.label}`, PAD, y + 4);
      }
      y += 40;
      for (const row of batch.rows) {
        if (ctx) {
          ctx.fillStyle = theme.variant;
          ctx.font = `500 16px ${theme.font}`;
          ctx.textBaseline = "middle";
          ctx.fillText(row.label, PAD, y + cell / 2);
          row.cards.forEach((card, index) =>
            drawCard(ctx, theme, card, PAD + label + index * (cell + GAP), y, cell, cell),
          );
        }
        y += cell + GAP;
      }
      y += 16;
    }
  } else {
    for (const group of input.groups) {
      const total = group.cards.reduce((sum, card) => sum + card.count, 0);
      if (ctx) {
        ctx.fillStyle = theme.onSurface;
        ctx.font = `600 22px ${theme.font}`;
        ctx.textBaseline = "top";
        ctx.fillText(group.label, PAD, y);
        const width = ctx.measureText(group.label).width;
        ctx.fillStyle = theme.variant;
        ctx.font = `400 18px ${theme.font}`;
        ctx.fillText(`${group.cards.length} · ${total}`, PAD + width + 12, y + 3);
      }
      y += 40;
      const columns = group.kind === "support" ? 6 : 10;
      const w = Math.floor((inner - GAP * (columns - 1)) / columns);
      const h =
        group.kind === "support" ? Math.round((w * 9) / 16) : group.kind === "member" ? Math.round((w * 4) / 3) : w;
      for (let index = 0; index < group.cards.length; index += columns) {
        if (ctx)
          group.cards
            .slice(index, index + columns)
            .forEach((card, column) => drawCard(ctx, theme, card, PAD + column * (w + GAP), y, w, h));
        y += h + GAP;
      }
      y += 24;
    }
  }
  return y + PAD - GAP;
}

export async function renderGachaImage(input: GachaImageInput): Promise<Blob> {
  const theme = tokens();
  const cards =
    input.mode === "pulls"
      ? input.batches.flatMap((batch) => batch.rows.flatMap((row) => row.cards))
      : input.groups.flatMap((group) => group.cards);
  const sources = new Set([
    ...cards.flatMap((card) => [card.image, card.attribute, card.rarityMark]),
    ...input.summary.flatMap((line) => line.entries.map((entry) => entry.image || "")),
    input.brand.logo,
  ]);
  await Promise.all([...sources].map(load));
  await document.fonts?.ready;
  const height = await render(null, theme, input);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, WIDTH, height);
  await render(ctx, theme, input);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob"))), "image/png"),
  );
}
