import type { OurNotesAssetManifest } from "../assets/manifest";
import { TmpSdfFont } from "./TmpSdfFont";
import type { RenderHudState } from "./types";

const EMPTY_HUD_STATE: Readonly<RenderHudState> = Object.freeze({});
const DEFAULT_RANK_LABELS = ["C", "B", "A", "S", "SS"] as const;
const RANK_LABEL_X = [248, 337, 424, 512, 599] as const;
const RANK_SEPARATOR_X = [248, 335, 424, 512, 600] as const;
const HUD_CHARACTER_SPACING = 1;
const RANK_ICON_SCALE = 0.5;
const RANK_ICON_SOURCE_WIDTH = 230;
const RANK_ICON_SOURCE_HEIGHT = 190;
const RANK_ICON_CENTER_X = 80.5;
const RANK_ICON_CENTER_Y = 89;
const PAUSE_ICON_SLOT_SIZE = 64;
const PAUSE_ICON_SLOT_TOP = 27;
const PAUSE_ICON_SPRITE_RECT = {
  offsetX: 19.076120376586914,
  offsetY: 16.076120376586914,
  width: 25.84775733947754,
  height: 31.84775733947754,
} as const;
const COMBO_ADD_PEAK_TIME = 0.13333334028720856;
const COMBO_ADD_DURATION = 0.15000000596046448;

// UILiveNoteJudgeEffectView.Initialize assigns each Sprite and immediately
// invokes Image.SetNativeSize(). The prefab's common 276x66 RectTransform is
// therefore only an editor placeholder, not the runtime render size.
const JUDGEMENT_NATIVE_SIZES = {
  just: [346, 122],
  perfect: [312, 78],
  great: [233, 76],
  good: [186, 76],
  bad: [156, 80],
  miss: [177, 76],
} as const;

interface RankSpriteRect {
  readonly offsetX: number;
  /** Unity textureRectOffset uses a bottom-left origin. */
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

// RankIconAtlas sprites are exported as tight PNGs. Unity's Simple Image
// restores this padding inside the common 230x190 Sprite rect even when
// PreserveAspect is disabled; drawing each tight PNG across the whole slot
// would visibly stretch D/C/B. Values come directly from each Sprite.m_RD.
const RANK_SPRITE_RECTS: Readonly<Record<string, RankSpriteRect>> = {
  D: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  C: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  B: { offsetX: 43.07612228393555, offsetY: 23.076120376586914, width: 143.84774780273438, height: 142.84774780273438 },
  A: { offsetX: 18.076120376586914, offsetY: 0, width: 193.84774780273438, height: 190 },
  S: { offsetX: 18.076120376586914, offsetY: 0, width: 194.84774780273438, height: 190 },
  SS: { offsetX: 0, offsetY: 0, width: 230, height: 190 },
};

interface SliceBorder {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

interface HudStaticSignature {
  score: number | undefined;
  scoreDelta: number | undefined;
  combo: number | undefined;
  perfectCombo: boolean | undefined;
  life: number | undefined;
  maxLife: number | undefined;
  rank: string | undefined;
  rankProgress: number | undefined;
  rankLabels: ReadonlyArray<string> | undefined;
  showPause: boolean | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep01(value: number): number {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red * 255}, ${green * 255}, ${blue * 255}, ${alpha})`;
}

function interpolate(from: readonly [number, number, number], to: readonly [number, number, number], t: number) {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t] as const;
}

/** Draws Unity Image.Type.Sliced geometry using the source Sprite borders. */
function drawNineSlice(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
  border: SliceBorder,
  pixelsPerUnitMultiplier = 1,
): void {
  if (width <= 0 || height <= 0 || image.width <= 0 || image.height <= 0) return;
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const left = clamp(border.left ?? 0, 0, sourceWidth);
  const right = clamp(border.right ?? 0, 0, sourceWidth - left);
  const top = clamp(border.top ?? 0, 0, sourceHeight);
  const bottom = clamp(border.bottom ?? 0, 0, sourceHeight - top);
  const ppu = Math.max(0.0001, pixelsPerUnitMultiplier);
  let destinationLeft = left / ppu;
  let destinationRight = right / ppu;
  let destinationTop = top / ppu;
  let destinationBottom = bottom / ppu;
  if (destinationLeft + destinationRight > width) {
    const scale = width / (destinationLeft + destinationRight);
    destinationLeft *= scale;
    destinationRight *= scale;
  }
  if (destinationTop + destinationBottom > height) {
    const scale = height / (destinationTop + destinationBottom);
    destinationTop *= scale;
    destinationBottom *= scale;
  }

  const sourceX = [0, left, sourceWidth - right];
  const sourceY = [0, top, sourceHeight - bottom];
  const sourceWidths = [left, sourceWidth - left - right, right];
  const sourceHeights = [top, sourceHeight - top - bottom, bottom];
  const destinationX = [x, x + destinationLeft, x + width - destinationRight];
  const destinationY = [y, y + destinationTop, y + height - destinationBottom];
  const destinationWidths = [destinationLeft, width - destinationLeft - destinationRight, destinationRight];
  const destinationHeights = [destinationTop, height - destinationTop - destinationBottom, destinationBottom];

  for (let row = 0; row < 3; row += 1) {
    if (destinationHeights[row]! <= 0) continue;
    for (let column = 0; column < 3; column += 1) {
      if (destinationWidths[column]! <= 0) continue;
      // Unity permits a zero-width centre (circle_ingame_half is authored this
      // way). Its sliced mesh stretches the inner-edge texel across the centre.
      const sourceCellWidth = sourceWidths[column] || 1;
      const sourceCellHeight = sourceHeights[row] || 1;
      const sourceCellX = clamp(sourceX[column]!, 0, Math.max(0, sourceWidth - sourceCellWidth));
      const sourceCellY = clamp(sourceY[row]!, 0, Math.max(0, sourceHeight - sourceCellHeight));
      context.drawImage(
        image,
        sourceCellX,
        sourceCellY,
        sourceCellWidth,
        sourceCellHeight,
        destinationX[column]!,
        destinationY[row]!,
        destinationWidths[column]!,
        destinationHeights[row]!,
      );
    }
  }
}

/** Canvas HUD matching the reference Live presentation hierarchy. */
export class HudLayer {
  readonly canvas: HTMLCanvasElement;

  private readonly context: CanvasRenderingContext2D;
  private readonly scratchCanvas: HTMLCanvasElement;
  private readonly scratchContext: CanvasRenderingContext2D;
  private readonly assets: OurNotesAssetManifest;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private logicalWidth = 1920;
  private logicalHeight = 1080;
  private readonly judgementImages: Partial<
    Record<"just" | "perfect" | "great" | "good" | "bad" | "miss" | "fast" | "late", HTMLImageElement>
  > = {};
  private readonly hudImages = new Map<string, HTMLImageElement>();
  private tmpSdfFont?: TmpSdfFont;
  private readonly staticSignature: HudStaticSignature = {
    score: undefined,
    scoreDelta: undefined,
    combo: undefined,
    perfectCombo: undefined,
    life: undefined,
    maxLife: undefined,
    rank: undefined,
    rankProgress: undefined,
    rankLabels: undefined,
    showPause: undefined,
  };
  private forceRedraw = true;
  private renderedVisible = false;
  private judgementWasAnimating = false;
  private comboWasAnimating = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, assets: OurNotesAssetManifest) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("OurNotes HUD requires a 2D canvas context");
    const scratchCanvas = document.createElement("canvas");
    const scratchContext = scratchCanvas.getContext("2d");
    if (!scratchContext) throw new Error("OurNotes HUD requires a mask canvas context");
    this.canvas = canvas;
    this.context = context;
    this.scratchCanvas = scratchCanvas;
    this.scratchContext = scratchContext;
    scratchCanvas.width = 1;
    scratchCanvas.height = 1;
    this.assets = assets;
  }

  resize(width: number, height: number, pixelRatio = 1): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = clamp(pixelRatio, 0.5, 3);
    this.canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.forceRedraw = true;
  }

  async loadAssets(): Promise<void> {
    if (this.disposed) return;
    if (typeof Image === "undefined") throw new Error("HUD sprites require a browser Image implementation");
    const judgementEntries = Object.entries(this.assets.hud.judgementImages).map(
      ([name, url]) => [`judgement:${name}`, url] as const,
    );
    const entries: ReadonlyArray<readonly [string, string]> = [
      ...judgementEntries,
      ["combo:label", this.assets.hud.comboLabelUrl],
      ...this.assets.hud.comboDigitUrls.map((url, digit) => [`combo:${digit}`, url] as const),
      ["combo:perfect:label", this.assets.hud.perfectComboLabelUrl],
      ...this.assets.hud.perfectComboDigitUrls.map((url, digit) => [`combo:perfect:${digit}`, url] as const),
      ["pause:icon", this.assets.hud.pauseIconUrl],
      ["pause:frame", this.assets.hud.pauseFrameUrl],
      ["pause:shadow", this.assets.hud.pauseShadowUrl],
      ...Object.entries(this.assets.hud.lifeIconUrls).map(([name, url]) => [`life:${name}`, url] as const),
      ...Object.entries(this.assets.hud.rankIconUrls).map(([name, url]) => [`rank:${name}`, url] as const),
      ["rank:base", this.assets.hud.rankBaseUrl],
      ["shape:round14", this.assets.hud.roundMask14Url],
      ["status:base", this.assets.hud.statusBaseUrl],
      ["score:star", this.assets.hud.scoreStarUrl],
      ["white", this.assets.hud.whiteSpriteUrl],
    ];
    const fontRequest = this.assets.tmpSdfFont
      ? Promise.allSettled([TmpSdfFont.load(this.assets.tmpSdfFont)]).then((fontResults) => fontResults[0]!)
      : Promise.resolve(undefined);
    const [results, fontResult] = await Promise.all([
      Promise.allSettled(
        entries.map(
          ([key, url]) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              image.decoding = "async";
              image.onload = () => {
                if (this.disposed) {
                  resolve();
                  return;
                }
                if (key.startsWith("judgement:")) {
                  const name = key.slice("judgement:".length) as keyof typeof this.judgementImages;
                  this.judgementImages[name] = image;
                } else {
                  this.hudImages.set(key, image);
                }
                resolve();
              };
              image.onerror = () =>
                this.disposed ? resolve() : reject(new Error(`Unable to load HUD sprite: ${url}`));
              image.src = url;
            }),
        ),
      ),
      fontRequest,
    ]);
    if (this.disposed) {
      if (fontResult?.status === "fulfilled") fontResult.value.dispose();
      return;
    }
    if (fontResult?.status === "fulfilled") this.tmpSdfFont = fontResult.value;
    if (results.every((result) => result.status === "rejected")) throw new Error("Unable to load original HUD sprites");
    this.forceRedraw = true;
    if (fontResult?.status === "rejected") throw fontResult.reason;
  }

  draw(state: RenderHudState | undefined): void {
    const context = this.context;
    const next = state ?? EMPTY_HUD_STATE;
    const visible = next.visible !== false;
    if (!visible) {
      if (this.renderedVisible || this.forceRedraw) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.renderedVisible = false;
      this.judgementWasAnimating = false;
      this.comboWasAnimating = false;
      this.forceRedraw = false;
      return;
    }

    const judgementAnimating = Boolean(next.judgement && (next.judgementAge ?? 0) < 0.3);
    const comboAnimating = Boolean(next.combo && next.combo >= 2 && (next.comboAge ?? Infinity) < COMBO_ADD_DURATION);
    if (
      !this.forceRedraw &&
      this.renderedVisible &&
      !this.staticStateChanged(next) &&
      !judgementAnimating &&
      !this.judgementWasAnimating &&
      !comboAnimating &&
      !this.comboWasAnimating
    ) {
      return;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    // CanvasScaler: reference 1920x1080, ScaleWithScreenSize / Expand.
    const scale = Math.min(this.width / 1920, this.height / 1080);
    this.logicalWidth = this.width / scale;
    this.logicalHeight = this.height / scale;
    context.scale(scale, scale);
    context.imageSmoothingEnabled = true;
    context.lineJoin = "round";
    this.drawScore(next);
    this.drawLife(next);
    this.drawCombo(next);
    this.drawJudgement(next);
    // Live skill cells use a separate prefab/atlas. They intentionally remain
    // absent until those source assets can be rendered; generic panels would
    // be visibly unrelated to the original UI.
    this.captureStaticState(next);
    this.renderedVisible = true;
    this.judgementWasAnimating = judgementAnimating;
    this.comboWasAnimating = comboAnimating;
    this.forceRedraw = false;
  }

  private staticStateChanged(state: Readonly<RenderHudState>): boolean {
    const previous = this.staticSignature;
    return (
      previous.score !== state.score ||
      previous.scoreDelta !== state.scoreDelta ||
      previous.combo !== state.combo ||
      previous.perfectCombo !== state.perfectCombo ||
      previous.life !== state.life ||
      previous.maxLife !== state.maxLife ||
      previous.rank !== state.rank ||
      previous.rankProgress !== state.rankProgress ||
      previous.rankLabels !== state.rankLabels ||
      previous.showPause !== state.showPause
    );
  }

  private captureStaticState(state: Readonly<RenderHudState>): void {
    const target = this.staticSignature;
    target.score = state.score;
    target.scoreDelta = state.scoreDelta;
    target.combo = state.combo;
    target.perfectCombo = state.perfectCombo;
    target.life = state.life;
    target.maxLife = state.maxLife;
    target.rank = state.rank;
    target.rankProgress = state.rankProgress;
    target.rankLabels = state.rankLabels;
    target.showPause = state.showPause;
  }

  private drawMaskedSlice(
    image: HTMLImageElement,
    x: number,
    y: number,
    width: number,
    height: number,
    border: SliceBorder,
    pixelsPerUnitMultiplier: number,
    paint: (context: CanvasRenderingContext2D, width: number, height: number) => string | CanvasGradient,
  ): void {
    const scratchWidth = Math.max(1, Math.ceil(width));
    const scratchHeight = Math.max(1, Math.ceil(height));
    if (this.scratchCanvas.width < scratchWidth || this.scratchCanvas.height < scratchHeight) {
      this.scratchCanvas.width = Math.max(this.scratchCanvas.width, scratchWidth);
      this.scratchCanvas.height = Math.max(this.scratchCanvas.height, scratchHeight);
    }
    const scratch = this.scratchContext;
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalCompositeOperation = "source-over";
    scratch.clearRect(0, 0, scratchWidth, scratchHeight);
    scratch.setTransform(scratchWidth / width, 0, 0, scratchHeight / height, 0, 0);
    drawNineSlice(scratch, image, 0, 0, width, height, border, pixelsPerUnitMultiplier);
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalCompositeOperation = "source-in";
    scratch.fillStyle = paint(scratch, scratchWidth, scratchHeight);
    scratch.fillRect(0, 0, scratchWidth, scratchHeight);
    scratch.globalCompositeOperation = "source-over";
    this.context.drawImage(this.scratchCanvas, 0, 0, scratchWidth, scratchHeight, x, y, width, height);
  }

  private drawHeaderBackground(): void {
    const context = this.context;
    const from = [0, 0.0588235, 0.2] as const;
    const to = [0.1921569, 0.2235294, 0.4039216] as const;
    const gradient = context.createLinearGradient(20, 0, 680, 0);
    for (const [position, alpha] of [
      [0, 1],
      [0.6, 0.698039],
      [0.9, 0.4],
      [1, 0],
    ] as const) {
      const color = interpolate(from, to, position);
      gradient.addColorStop(position, rgba(color[0], color[1], color[2], alpha));
    }
    context.fillStyle = gradient;
    context.fillRect(20, 0, 660, 146);
  }

  private drawScore(state: RenderHudState): void {
    const context = this.context;
    context.save();
    this.drawHeaderBackground();

    const rankBase = this.hudImages.get("rank:base");
    if (rankBase) drawNineSlice(context, rankBase, 6, 0, 149, 160, { left: 26, top: 4, right: 26, bottom: 25 });
    this.tmpSdfFont?.drawText(context, "RANK", 80.5, 31, {
      align: "center",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: "#ffffff",
      fontSize: 24,
    });
    const rank = state.rank ?? "D";
    const rankImage = this.hudImages.get(`rank:${rank}`);
    if (rankImage) {
      const spriteRect = RANK_SPRITE_RECTS[rank] ?? RANK_SPRITE_RECTS.D!;
      const slotLeft = RANK_ICON_CENTER_X - (RANK_ICON_SOURCE_WIDTH * RANK_ICON_SCALE) / 2;
      const slotTop = RANK_ICON_CENTER_Y - (RANK_ICON_SOURCE_HEIGHT * RANK_ICON_SCALE) / 2;
      context.drawImage(
        rankImage,
        slotLeft + spriteRect.offsetX * RANK_ICON_SCALE,
        slotTop + (RANK_ICON_SOURCE_HEIGHT - spriteRect.offsetY - spriteRect.height) * RANK_ICON_SCALE,
        spriteRect.width * RANK_ICON_SCALE,
        spriteRect.height * RANK_ICON_SCALE,
      );
    }

    const roundMask = this.hudImages.get("shape:round14");
    if (roundMask) {
      this.drawMaskedSlice(
        roundMask,
        158,
        66,
        506,
        28,
        { left: 14, top: 14, right: 14, bottom: 14 },
        1,
        () => "#ffffff",
      );
      this.drawMaskedSlice(
        roundMask,
        160,
        68,
        502,
        24,
        { left: 14, top: 14, right: 14, bottom: 14 },
        7 / 6,
        () => "rgba(24, 18, 41, 0.698039)",
      );
      const gaugeProgress = clamp(state.rankProgress ?? 0, 0, 1);
      if (gaugeProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(160, 68, 502 * gaugeProgress, 24);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          160,
          68,
          502,
          24,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 6,
          (maskContext, width) => {
            const gradient = maskContext.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, "rgb(163, 224, 255)");
            gradient.addColorStop(9175 / 65535, "rgb(162, 255, 183)");
            gradient.addColorStop(19661 / 65535, "rgb(247, 255, 154)");
            gradient.addColorStop(30801 / 65535, "rgb(255, 204, 162)");
            gradient.addColorStop(41942 / 65535, "rgb(255, 136, 155)");
            gradient.addColorStop(53083 / 65535, "rgb(255, 166, 227)");
            gradient.addColorStop(1, "rgb(154, 125, 250)");
            return gradient;
          },
        );
        context.restore();
      }
    }

    const white = this.hudImages.get("white");
    if (white) {
      for (const separatorX of RANK_SEPARATOR_X) context.drawImage(white, separatorX - 1.5, 68, 3, 24);
    }
    const labels = state.rankLabels ?? DEFAULT_RANK_LABELS;
    const labelCount = Math.min(labels.length, RANK_LABEL_X.length);
    for (let index = 0; index < labelCount; index += 1) {
      this.tmpSdfFont?.drawText(context, labels[index]!, RANK_LABEL_X[index]!, 43, {
        align: "center",
        characterSpacing: HUD_CHARACTER_SPACING,
        color: "#ffffff",
        fontSize: 30,
      });
    }

    const scoreValue = Math.max(0, Math.round(state.score ?? 0));
    const scoreRaw = String(scoreValue);
    const scoreText = scoreRaw.padStart(8, "0");
    const leadingZeroCount = Math.max(0, scoreText.length - scoreRaw.length);
    const font = this.tmpSdfFont;
    font?.drawText(context, scoreText, 42, 190, {
      align: "left",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: (_character, index) => (index < leadingZeroCount ? "#b1afc1" : "#ffffff"),
      fontSize: 44,
    });
    const scoreStar = this.hudImages.get("score:star");
    if (scoreStar) context.drawImage(scoreStar, 20, 202.8, 16.65, 16.2);
    if (white) context.drawImage(white, 28.325, 209, 260, 2);
    font?.drawText(context, "LIVE SCORE", 127, 230, {
      align: "center",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: "#ffffff",
      fontSize: 24,
    });
    if (state.scoreDelta !== undefined && state.scoreDelta !== 0) {
      const delta = Math.round(state.scoreDelta);
      const deltaText = `${delta > 0 ? "+" : ""}${delta}`;
      font?.drawText(context, deltaText, 271.28845, 196.9, {
        align: "left",
        characterSpacing: HUD_CHARACTER_SPACING,
        color: delta >= 0 ? "#ffffff" : "#ff0000",
        fontSize: 24,
      });
    }
    context.restore();
  }

  private drawStatusBackground(): void {
    const statusBase = this.hudImages.get("status:base");
    if (!statusBase) return;
    const from = [0.1921569, 0.2235294, 0.4039216] as const;
    const to = [0, 0.0588235, 0.2] as const;
    this.drawMaskedSlice(statusBase, this.logicalWidth - 420, 19, 400, 80, { right: 60 }, 1.5, (context, width) => {
      const gradient = context.createLinearGradient(0, 0, width, 0);
      for (const [position, alpha] of [
        [0, 0],
        [0.1, 0.4],
        [0.4, 0.698039],
        [1, 1],
      ] as const) {
        const color = interpolate(from, to, position);
        gradient.addColorStop(position, rgba(color[0], color[1], color[2], alpha));
      }
      return gradient;
    });
  }

  private drawLife(state: RenderHudState): void {
    const context = this.context;
    const life = Math.max(0, state.life ?? 1000);
    const maxLife = Math.max(1, state.maxLife ?? 1000);
    const isDanger = life / maxLife <= 0.3;
    const isOver = life > maxLife;
    const lifeType = isDanger ? "danger" : isOver ? "over" : "normal";
    context.save();
    this.drawStatusBackground();

    const roundMask = this.hudImages.get("shape:round14");
    if (roundMask) {
      this.drawMaskedSlice(
        roundMask,
        this.logicalWidth - 400,
        62,
        284,
        16,
        { left: 14, top: 14, right: 14, bottom: 14 },
        1.75,
        () => "rgb(5, 18, 51)",
      );
      const baseProgress = clamp(life / maxLife, 0, 1);
      if (baseProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(this.logicalWidth - 400, 64, 280 * baseProgress, 12);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          this.logicalWidth - 400,
          64,
          280,
          12,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 3,
          () => (isDanger ? "rgb(255, 77, 77)" : "rgb(102, 255, 140)"),
        );
        context.restore();
      }
      const overProgress = clamp((life - maxLife) / maxLife, 0, 1);
      if (overProgress > 0) {
        context.save();
        context.beginPath();
        context.rect(this.logicalWidth - 400, 64, 280 * overProgress, 12);
        context.clip();
        this.drawMaskedSlice(
          roundMask,
          this.logicalWidth - 400,
          64,
          280,
          12,
          { left: 14, top: 14, right: 14, bottom: 14 },
          7 / 3,
          () => "rgb(198, 255, 234)",
        );
        context.restore();
      }
    }

    const lifeImage = this.hudImages.get(`life:${lifeType}`);
    if (lifeImage) context.drawImage(lifeImage, this.logicalWidth - 220, 34.5, 30, 27);
    this.tmpSdfFont?.drawText(context, String(Math.round(life)), this.logicalWidth - 117.5, 48, {
      align: "right",
      characterSpacing: HUD_CHARACTER_SPACING,
      color: isDanger ? "rgb(255, 77, 77)" : isOver ? "rgb(198, 255, 234)" : "#ffffff",
      fontSize: 30,
    });

    if (state.showPause !== false) {
      const pauseShadow = this.hudImages.get("pause:shadow");
      const pauseFrame = this.hudImages.get("pause:frame");
      const pauseIcon = this.hudImages.get("pause:icon");
      if (pauseShadow) {
        drawNineSlice(context, pauseShadow, this.logicalWidth - 100, 22.36, 80, 90.54, { left: 49, right: 49 });
      }
      if (pauseFrame) {
        drawNineSlice(context, pauseFrame, this.logicalWidth - 100, 19, 80, 80, {
          left: 40,
          top: 40,
          right: 40,
          bottom: 40,
        });
      }
      if (pauseIcon) {
        // IconPause_ingame is a tight 26x32 export of a 64x64 Sprite. Unity's
        // Simple Image restores m_RD.textureRectOffset inside that 64x64 slot.
        // Stretching the exported PNG across the slot makes the pause bars
        // roughly twice their authored size.
        context.drawImage(
          pauseIcon,
          this.logicalWidth - 92 + PAUSE_ICON_SPRITE_RECT.offsetX,
          PAUSE_ICON_SLOT_TOP + (PAUSE_ICON_SLOT_SIZE - PAUSE_ICON_SPRITE_RECT.offsetY - PAUSE_ICON_SPRITE_RECT.height),
          PAUSE_ICON_SPRITE_RECT.width,
          PAUSE_ICON_SPRITE_RECT.height,
        );
      }
    }
    context.restore();
  }

  private drawCombo(state: RenderHudState): void {
    if (!state.combo || state.combo < 2) return;
    const comboText = String(Math.min(9999, Math.max(0, Math.round(state.combo))));
    const prefix = state.perfectCombo ? "combo:perfect" : "combo";
    const label = this.hudImages.get(`${prefix}:label`);
    const digits = [...comboText].map((digit) => this.hudImages.get(`${prefix}:${digit}`));
    if (!label || digits.some((digit) => !digit)) return;

    const context = this.context;
    const centerX = this.logicalWidth / 2 + 768;
    const layoutWidth = comboText.length * 112 + Math.max(0, comboText.length - 1) * -34;
    const firstCenter = centerX - layoutWidth / 2 + 56;
    const age = Math.max(0, state.comboAge ?? COMBO_ADD_DURATION);
    const firstProgress = smoothstep01(age / COMBO_ADD_PEAK_TIME);
    const secondProgress = smoothstep01((age - COMBO_ADD_PEAK_TIME) / (COMBO_ADD_DURATION - COMBO_ADD_PEAK_TIME));
    const addScale =
      age < COMBO_ADD_PEAK_TIME
        ? 0.8999999761581421 + (1.25 - 0.8999999761581421) * firstProgress
        : 1.25 - 0.25 * secondProgress;
    const addAlpha = age < COMBO_ADD_PEAK_TIME ? 0.800000011920929 + (1 - 0.800000011920929) * firstProgress : 1;
    context.save();
    // LiveComboAdd.anim: the root CanvasGroup fades 0.8 -> 1 over 8/60 s.
    // Only CountRoot receives the 0.9 -> 1.25 -> 1 scale pulse; Title keeps
    // its authored 183x63 size. Both streamed curves use zero-tangent cubic
    // Hermite interpolation, which is exactly smoothstep.
    context.globalAlpha = addAlpha;
    context.drawImage(label, centerX - 91.5, 466, 183, 63);
    context.translate(centerX, 578);
    context.scale(addScale, addScale);
    for (let index = 0; index < digits.length; index += 1) {
      const digit = digits[index]!;
      if (!digit) continue;
      // SetDigit calls Image.SetNativeSize() after every sprite change. The
      // child Image keeps its natural dimensions (not the frame's serialized
      // placeholder size), while the four fixed 112px parent frames remain in
      // the HorizontalLayoutGroup at 78px centre-to-centre. Only FourDigiFrame
      // (the thousands place) has the authored 0.95 parent scale.
      const frameScale = comboText.length === 4 && index === 0 ? 0.95 : 1;
      const width = digit.naturalWidth * frameScale;
      const height = digit.naturalHeight * frameScale;
      const x = firstCenter + index * 78 - centerX;
      context.drawImage(digit, x - width / 2, -height / 2, width, height);
    }
    context.restore();
  }

  private drawJudgement(state: RenderHudState): void {
    if (!state.judgement || (state.judgementAge ?? 0) >= 0.3) return;
    const image = this.judgementImages[state.judgement];
    if (!image) return;
    const context = this.context;
    const x = this.logicalWidth / 2;
    // Live.prefab: UILiveJudgement y=-109; its effect_root/main_judge child
    // places the judgement center another 16 px below that root. Initialize
    // replaces the common editor placeholder with Image.SetNativeSize().
    const y = this.logicalHeight / 2 + 125;
    const [width, height] = JUDGEMENT_NATIVE_SIZES[state.judgement];
    context.save();
    context.drawImage(image, x - width / 2, y - height / 2, width, height);
    const timingImage = state.fastSlow ? this.judgementImages[state.fastSlow === "FAST" ? "fast" : "late"] : undefined;
    if (timingImage) {
      // timing_offset shares main_judge's center in UILiveNoteJudgeEffectView.
      context.drawImage(timingImage, x - 307 / 2, y - 31 / 2, 307, 31);
    }
    context.restore();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hudImages.clear();
    this.tmpSdfFont?.dispose();
    this.tmpSdfFont = undefined;
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.scratchCanvas.width = 1;
    this.scratchCanvas.height = 1;
  }
}
