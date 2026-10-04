import { canvasToPngBlob } from "../../lib/canvas-capture";

export interface ResultImageCard {
  title: string;
  character: string;
  image: string;
  avatars: string[];
  attribute?: string;
  rarity?: string;
  attributeLabel: string;
  rarityLabel: string;
  leader: boolean;
  facts: { label: string; value: string }[];
}
export interface TeamResultImage {
  title: string;
  subtitle: string;
  jacket?: string;
  membersLabel: string;
  snapshotsLabel: string;
  leaderLabel: string;
  emptyLabel: string;
  imageUnavailableLabel: string;
  members: ResultImageCard[];
  snapshots: (ResultImageCard | null)[];
  metrics: { label: string; value: string; detail: string }[];
  footer: string[];
  server: string;
  releaseId: string;
  theme: { surface: string; container: string; text: string; muted: string; primary: string; outline: string; font: string };
}

/** Render captured results only. Images stay pinned to their original release. */
export async function renderTeamResultImage(model: TeamResultImage): Promise<Blob> {
  const images = new Map<string, HTMLImageElement | null>();
  const sources = new Set(model.members.concat(model.snapshots.filter((card): card is ResultImageCard => card !== null))
    .flatMap(card => [card.image, card.attribute, card.rarity, ...card.avatars]).filter((url): url is string => !!url));
  if (model.jacket) sources.add(model.jacket);
  await Promise.all([...sources].map(async source => {
    try {
      const url = new URL(source, location.href);
      if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) return;
      if (url.pathname.startsWith(`/assets/${model.server}/`)) url.searchParams.set("release", model.releaseId);
      const image = new Image(); image.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { image.src = ""; reject(new Error("image-timeout")); }, 8000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("image-unavailable")); };
        image.src = url.href;
      });
      images.set(source, image);
    } catch { images.set(source, null); }
  }));
  await document.fonts.ready;
  const canvas = document.createElement("canvas"), rows = Math.max(1, Math.ceil(model.metrics.length / 3));
  const hasSnapshots = model.snapshots.some(card => card !== null);
  canvas.width = 1280; canvas.height = 1480 + (rows - 1) * 122 - (hasSnapshots ? 0 : 140);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-unavailable");
  const c = context, t = model.theme, margin = 48, gap = 16, width = 224;
  c.fillStyle = t.surface; c.fillRect(0, 0, canvas.width, canvas.height);
  const font = (size: number, weight = 400) => { c.font = `${weight} ${size}px ${t.font}`; c.textBaseline = "top"; };
  const lines = (text: string, x: number, y: number, max: number, size: number, limit = 1, color = t.text, weight = 400) => {
    font(size, weight); c.fillStyle = color;
    const paragraphs = text.split(/\r?\n/u); let used = 0;
    for (const paragraph of paragraphs) {
      const chars = Array.from(paragraph); let line = "";
      for (let index = 0; index < chars.length; index++) {
        if (c.measureText(line + chars[index]).width <= max) { line += chars[index]; continue; }
        if (used === limit - 1) {
          while (line && c.measureText(line + "…").width > max) line = Array.from(line).slice(0, -1).join("");
          c.fillText(line + "…", x, y + used * (size + 6)); return;
        }
        c.fillText(line, x, y + used++ * (size + 6)); line = chars[index];
      }
      if (used >= limit) return;
      c.fillText(line, x, y + used++ * (size + 6));
    }
  };
  const panel = (x: number, y: number, w: number, h: number) => {
    c.fillStyle = t.container; c.beginPath(); c.roundRect(x, y, w, h, 16); c.fill();
  };
  const image = (source: string | undefined, x: number, y: number, w: number, h: number) => {
    const loaded = source ? images.get(source) : null;
    if (!loaded) return false;
    const scale = Math.min(w / loaded.naturalWidth, h / loaded.naturalHeight);
    c.drawImage(loaded, x + (w - loaded.naturalWidth * scale) / 2, y + (h - loaded.naturalHeight * scale) / 2, loaded.naturalWidth * scale, loaded.naturalHeight * scale);
    return true;
  };
  lines("haneoka", margin, 32, 1184, 20, 1, t.primary, 700);
  if (model.jacket) image(model.jacket, 1120, 72, 112, 112);
  lines(model.title, margin, 76, model.jacket ? 1048 : 1184, 36, 2, t.text, 700);
  lines(model.subtitle, margin, 165, model.jacket ? 1048 : 1184, 20, 1, t.muted);
  const metricWidth = (1184 - gap * (Math.min(3, model.metrics.length) - 1)) / Math.max(1, Math.min(3, model.metrics.length));
  model.metrics.forEach((metric, index) => {
    const x = margin + index % 3 * (metricWidth + gap), y = 208 + Math.floor(index / 3) * 122;
    panel(x, y, metricWidth, 106);
    lines(metric.label, x + 16, y + 12, metricWidth - 32, 17, 1, t.muted);
    lines(metric.value, x + 16, y + 36, metricWidth - 32, 29, 1, t.primary, 700);
    lines(metric.detail, x + 16, y + 73, metricWidth - 32, 14, 1, t.muted);
  });
  const membersY = 232 + rows * 122;
  lines(model.membersLabel, margin, membersY, 1184, 22, 1, t.text, 700);
  const drawCard = (card: ResultImageCard | null, index: number, y: number, member: boolean) => {
    const x = margin + index * (width + gap), h = member ? 299 : 126;
    panel(x, y, width, h);
    if (!card) { lines(model.emptyLabel, x + 16, y + h / 2 - 12, width - 32, 20, 2, t.muted); return; }
    if (!image(card.image, x, y, width, h)) lines(model.imageUnavailableLabel, x + 16, y + h / 2 - 12, width - 32, 18, 2, t.muted);
    if (!image(card.attribute, x + 8, y + 8, 32, 32)) lines(card.attributeLabel, x + 8, y + 8, 128, 16, 1, t.primary, 600);
    if (!image(card.rarity, x + width - 40, y + 8, 32, 32)) lines(card.rarityLabel, x + width - 48, y + 8, 40, 18, 1, t.primary, 600);
    if (card.leader) {
      font(15, 700); const w = Math.min(width - 16, c.measureText(model.leaderLabel).width + 24);
      c.fillStyle = t.surface; c.beginPath(); c.roundRect(x + width - w - 8, y + h - 36, w, 28, 14); c.fill();
      lines(model.leaderLabel, x + width - w + 4, y + h - 31, w - 24, 15, 1, t.primary, 700);
    }
    lines(card.title, x, y + h + 14, width, 20, 2, t.text, 600);
    let avatarX = x;
    for (const avatar of card.avatars.slice(0, 5)) {
      if (image(avatar, avatarX, y + h + 71, 24, 24)) avatarX += 20;
    }
    lines(card.character, avatarX + (avatarX > x ? 8 : 0), y + h + 75, width - (avatarX - x) - 8, 15, 2, t.muted);
    card.facts.forEach((fact, factIndex) => {
      const fx = x + factIndex % 2 * (width / 2), fy = y + h + 128 + Math.floor(factIndex / 2) * 45;
      lines(fact.label, fx, fy, width / 2 - 8, 12, 1, t.muted);
      lines(fact.value, fx, fy + 18, width / 2 - 8, 18, 1, t.text, 600);
    });
  };
  model.members.forEach((card, index) => drawCard(card, index, membersY + 40, true));
  const snapshotsY = membersY + 605;
  lines(model.snapshotsLabel, margin, snapshotsY, 1184, 22, 1, t.text, 700);
  model.snapshots.forEach((card, index) => drawCard(card, index, snapshotsY + 40, false));
  const footerY = snapshotsY + (hasSnapshots ? 350 : 210);
  c.strokeStyle = t.outline; c.beginPath(); c.moveTo(margin, footerY); c.lineTo(1232, footerY); c.stroke();
  model.footer.slice(0, 4).forEach((line, index) => lines(line, margin, footerY + 18 + index * 25, 1184, 16, 1, t.muted));
  return canvasToPngBlob(canvas);
}
