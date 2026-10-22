import { canvasToPngBlob } from "../../lib/canvas-capture";
import type { CardGrowth } from "./card-growth";

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
  growth?: CardGrowth | null;
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
  allEmptyLabel?: string;
  imageUnavailableLabel: string;
  members: ResultImageCard[];
  snapshots: (ResultImageCard | null)[];
  metrics: { label: string; value: string; detail: string }[];
  footer: string[];
  server: string;
  releaseId: string;
  theme: {
    surface: string;
    container: string;
    text: string;
    muted: string;
    primary: string;
    outline: string;
    font: string;
  };
}

/** Render captured results only. Images stay pinned to their original release. */
export async function renderTeamResultImage(model: TeamResultImage): Promise<Blob> {
  const images = new Map<string, HTMLImageElement | ImageBitmap | null>();
  const dimensions = (image: HTMLImageElement | ImageBitmap) =>
    "naturalWidth" in image ? { width: image.naturalWidth, height: image.naturalHeight } : image;
  const loadedImages = new Map(
    [...document.images]
      .filter((image) => image.complete && image.naturalWidth > 0)
      .map((image) => [image.currentSrc, image]),
  );
  const sources = new Set(
    model.members
      .concat(model.snapshots.filter((card): card is ResultImageCard => card !== null))
      .flatMap((card) => {
        const growth = card.growth;
        return [
          card.image,
          card.attribute,
          card.rarity,
          ...card.avatars,
          growth?.icons.training,
          growth?.liveSkill?.icon,
          growth?.gekisoSkill?.icon,
          growth && (growth.kind === "member" ? growth.icons.memberRanks : growth.icons.supportRanks)[growth.rank ?? 0],
        ];
      })
      .filter((url): url is string => !!url),
  );
  if (model.jacket) sources.add(model.jacket);
  await Promise.all(
    [...sources].map(async (source) => {
      try {
        const url = new URL(source, location.href);
        if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) return;
        if (url.pathname.startsWith(`/assets/${model.server}/`)) url.searchParams.set("release", model.releaseId);
        const loaded = loadedImages.get(url.href);
        if (loaded) {
          images.set(source, await createImageBitmap(loaded));
          return;
        }
        const image = new Image();
        image.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            image.src = "";
            reject(new Error("image-timeout"));
          }, 8000);
          image.onload = () => {
            clearTimeout(timer);
            resolve();
          };
          image.onerror = () => {
            clearTimeout(timer);
            reject(new Error("image-unavailable"));
          };
          image.src = url.href;
        });
        images.set(source, image);
      } catch {
        images.set(source, null);
      }
    }),
  );
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-unavailable");
  const c = context,
    t = model.theme,
    margin = 48,
    gap = 16,
    width = 224;
  const font = (size: number, weight = 400) => {
    c.font = `${weight} ${size}px ${t.font}`;
    c.textBaseline = "top";
  };
  const wrap = (text: string, max: number, size: number, weight = 400) => {
    font(size, weight);
    return text.split(/\r?\n/u).flatMap((paragraph) => {
      const result: string[] = [];
      let line = "";
      for (const char of Array.from(paragraph)) {
        if (line && c.measureText(line + char).width > max) {
          result.push(line);
          line = "";
        }
        line += char;
      }
      result.push(line);
      return result;
    });
  };
  const height = (text: string, max: number, size: number, weight = 400) =>
    wrap(text, max, size, weight).length * (size + 6);
  const lines = (
    text: string,
    x: number,
    y: number,
    max: number,
    size: number,
    _limit = 1,
    color = t.text,
    weight = 400,
  ) => {
    const rows = wrap(text, max, size, weight);
    c.fillStyle = color;
    rows.forEach((line, index) => c.fillText(line, x, y + index * (size + 6)));
    return rows.length * (size + 6);
  };
  const panel = (x: number, y: number, w: number, h: number) => {
    c.fillStyle = t.container;
    c.beginPath();
    c.roundRect(x, y, w, h, 16);
    c.fill();
  };
  const image = (source: string | undefined, x: number, y: number, w: number, h: number) => {
    const loaded = source ? images.get(source) : null;
    if (!loaded) return false;
    const size = dimensions(loaded);
    const scale = Math.min(w / size.width, h / size.height);
    c.drawImage(
      loaded,
      x + (w - size.width * scale) / 2,
      y + (h - size.height * scale) / 2,
      size.width * scale,
      size.height * scale,
    );
    return true;
  };
  const drawCard = (
    card: ResultImageCard | null,
    index: number,
    y: number,
    member: boolean,
    titleHeight: number,
    characterHeight: number,
  ) => {
    const x = margin + index * (width + gap),
      h = member ? 299 : 126;
    panel(x, y, width, h);
    if (!card) {
      lines(model.emptyLabel, x + 16, y + h / 2 - 12, width - 32, 20, 2, t.muted);
      return;
    }
    if (!image(card.image, x, y, width, h))
      lines(model.imageUnavailableLabel, x + 16, y + h / 2 - 12, width - 32, 18, 2, t.muted);
    const markWidth = width * (member ? 50 / 224 : 50 / 326);
    const markHeight = (source: string | undefined) => {
      const loaded = source ? images.get(source) : null;
      return loaded ? (markWidth * dimensions(loaded).height) / dimensions(loaded).width : markWidth;
    };
    if (!image(card.attribute, x, y, markWidth, markHeight(card.attribute)))
      lines(card.attributeLabel, x + 8, y + 8, 128, 16, 1, t.primary, 600);
    if (!image(card.rarity, x + width - markWidth, y, markWidth, markHeight(card.rarity)))
      lines(card.rarityLabel, x + width - 48, y + 8, 40, 18, 1, t.primary, 600);
    if (card.growth) {
      const growth = card.growth;
      const value = (number: number | null | undefined) => String(number ?? growth.unknown ?? "?");
      const overlay = (text: string, left: number, top: number, size: number) => {
        c.save();
        font(size, 600);
        c.fillStyle = "#fff";
        c.strokeStyle = "#000";
        c.lineWidth = 1.2;
        c.strokeText(text, left, top);
        c.fillText(text, left, top);
        c.restore();
      };
      if (growth.level !== undefined) overlay(`Lv.${value(growth.level)}`, x + width * 0.03, y + h * 0.97 - 28, 28);
      if (growth.training !== undefined) {
        image(growth.icons.training, x + width * 0.03, y + h * 0.85 - 24, 22, 22);
        overlay(value(growth.training), x + width * 0.03 + 26, y + h * 0.85 - 24, 24);
      }
      let left = x + width * 0.03;
      for (const skill of [growth.liveSkill, growth.gekisoSkill])
        if (skill?.icon) {
          image(skill.icon, left, y + h * 0.71 - 24, 24, 24);
          overlay(value(skill.level), left + 27, y + h * 0.71 - 24, 24);
          left += 58;
        }
      if (growth.rank !== undefined) {
        const source = (growth.kind === "member" ? growth.icons.memberRanks : growth.icons.supportRanks)[
          growth.rank ?? 0
        ];
        const w = width * (member ? 64 / 224 : 64 / 326),
          loaded = source ? images.get(source) : null;
        const rankHeight = loaded ? (w * dimensions(loaded).height) / dimensions(loaded).width : w;
        image(source, x + width - w, y + h - rankHeight, w, rankHeight);
        if (growth.rank === null) overlay(value(growth.rank), x + width - w * 0.65, y + h - rankHeight * 0.65, 22);
      }
    }
    if (card.leader) {
      font(15, 700);
      const w = Math.min(width - 16, c.measureText(model.leaderLabel).width + 24);
      c.fillStyle = t.surface;
      c.beginPath();
      c.roundRect(x + 8, y + h * 0.56 - 28, w, 28, 14);
      c.fill();
      lines(model.leaderLabel, x + 20, y + h * 0.56 - 23, w - 24, 15, 1, t.primary, 700);
    }
    lines(card.title, x, y + h + 14, width, 20, 2, t.text, 600);
    let avatarX = x;
    for (const avatar of card.avatars.slice(0, 5)) {
      const loaded = images.get(avatar);
      if (loaded) {
        const size = dimensions(loaded);
        const edge = Math.min(size.width, size.height);
        c.drawImage(
          loaded,
          (size.width - edge) / 2,
          (size.height - edge) / 4,
          edge,
          edge,
          avatarX,
          y + h + 14 + titleHeight + 8,
          24,
          24,
        );
        avatarX += 20;
      }
    }
    lines(
      card.character,
      avatarX + (avatarX > x ? 8 : 0),
      y + h + 14 + titleHeight + 8,
      width - Math.min(5, card.avatars.length) * 20 - 8,
      15,
      2,
      t.muted,
    );
    card.facts.forEach((fact, factIndex) => {
      const fx = x + (factIndex % 2) * (width / 2),
        fy = y + h + 14 + titleHeight + 8 + characterHeight + 12 + Math.floor(factIndex / 2) * 45;
      lines(fact.label, fx, fy, width / 2 - 8, 12, 1, t.muted);
      lines(fact.value, fx, fy + 18, width / 2 - 8, 18, 1, t.text, 600);
    });
  };
  const drawRow = (cards: (ResultImageCard | null)[], y: number, member: boolean) => {
    const titleHeight = Math.max(0, ...cards.map((card) => (card ? height(card.title, width, 20, 600) : 0)));
    const characterHeight = Math.max(
      24,
      ...cards.map((card) =>
        card ? height(card.character, width - Math.min(5, card.avatars.length) * 20 - 8, 15) : 0,
      ),
    );
    const factsHeight = Math.max(0, ...cards.map((card) => Math.ceil((card?.facts.length ?? 0) / 2) * 45));
    cards.forEach((card, index) => drawCard(card, index, y, member, titleHeight, characterHeight));
    return y + (member ? 299 : 126) + 14 + titleHeight + 8 + characterHeight + (factsHeight ? 12 + factsHeight : 0);
  };
  const layout = () => {
    c.fillStyle = t.surface;
    c.fillRect(0, 0, canvas.width, canvas.height);
    let y = 32;
    y += lines("haneoka", margin, y, 1184, 20, 1, t.primary, 700) + 16;
    const titleWidth = model.jacket ? 1048 : 1184;
    if (model.jacket) image(model.jacket, 1120, y, 112, 112);
    const top = y;
    y += lines(model.title, margin, y, titleWidth, 22, 1, t.muted, 600) + 8;
    if (model.subtitle) y += lines(model.subtitle, margin, y, titleWidth, 28, 1, t.text, 600);
    if (model.jacket) y = Math.max(y, top + 112);
    y += 24;
    const [primary, ...secondary] = model.metrics;
    if (primary) {
      y += lines(primary.label, margin, y, 1184, 20, 1, t.muted) + 4;
      y += lines(primary.value, margin, y, 1184, 44, 1, t.primary, 700);
      if (primary.detail) y += lines(primary.detail, margin, y, 1184, 18, 1, t.muted);
      y += 16;
    }
    for (let index = 0; index < secondary.length; index += 2) {
      let bottom = y;
      secondary.slice(index, index + 2).forEach((metric, column) => {
        const x = margin + column * 600;
        let my = y;
        my += lines(metric.label, x, my, 584, 18, 1, t.muted) + 4;
        my += lines(metric.value, x, my, 584, 26, 1, t.text, 600);
        if (metric.detail) my += lines(metric.detail, x, my, 584, 18, 1, t.muted);
        bottom = Math.max(bottom, my);
      });
      y = bottom + 16;
    }
    y += 8;
    y += lines(model.membersLabel, margin, y, 1184, 22, 1, t.text, 600) + 12;
    y = drawRow(model.members, y, true) + 32;
    if (model.snapshots.length === 5 && model.snapshots.every((card) => card === null) && model.allEmptyLabel) {
      y += lines(model.allEmptyLabel, margin, y, 1184, 20, 1, t.muted);
    } else {
      y += lines(model.snapshotsLabel, margin, y, 1184, 22, 1, t.text, 600) + 12;
      y = drawRow(model.snapshots, y, false);
    }
    y += 24;
    c.strokeStyle = t.outline;
    c.beginPath();
    c.moveTo(margin, y);
    c.lineTo(1232, y);
    c.stroke();
    y += 16;
    for (let index = 0; index < model.footer.length; index += 2) {
      const heights = model.footer
        .slice(index, index + 2)
        .map((line, column) => lines(line, margin + column * 600, y, 584, 18, 1, t.muted));
      y += Math.max(...heights) + 4;
    }
    return Math.ceil(y + 32);
  };
  canvas.height = layout();
  layout();
  for (const image of images.values()) if (image instanceof ImageBitmap) image.close();
  return canvasToPngBlob(canvas);
}
