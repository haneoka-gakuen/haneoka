import { CanvasSpriteAtlas } from "../assets/CanvasSpriteAtlas";
import { OUR_NOTES_LIVE_GEOMETRY, type OurNotesAssetManifest, type SpriteAtlasManifest } from "../assets/manifest";
import type { SpriteRegion } from "../assets/SpriteAtlas";
import {
  layoutNoteSkinArrow,
  layoutNoteSkinBody,
  layoutNoteSkinDecoration,
  noteSkinBodyHeight,
  noteSkinArrowName,
  noteSkinDecorationName,
  noteSkinEffectiveDirection,
  noteSkinSpriteBounds,
  noteSkinTightHorizontalSlices,
  selectFlatNoteSkinParts,
  selectNoteSkinParts,
  type NoteSkinParts,
  type NoteSkinQuad,
  type NoteSkinSlice,
  type NoteSkinSpriteBounds,
} from "../render/noteSkinLayout";
import type { RenderDirection, RenderNoteKind } from "../render/types";

interface CachedCanvasSprite {
  /** Prepared, oriented tight textureRect. */
  canvas: HTMLCanvasElement;
  region: SpriteRegion;
  bounds: NoteSkinSpriteBounds;
}

export interface ChartCanvasNote {
  kind: RenderNoteKind;
  /** Effective visual direction. Pass the mirrored direction when the lane is mirrored. */
  direction?: RenderDirection;
  /** Left edge in the chart's absolute 24-lane coordinate system. */
  lane: number;
  centerX: number;
  centerY: number;
  /** Final note-body width in canvas CSS pixels. */
  width: number;
  /** Authored width in the chart's 24-lane coordinate system. */
  laneSpan: number;
  /** Full 24-lane stage width in canvas CSS pixels. */
  stageWidth: number;
  scale?: number;
}

/** A flat note uses the original neutral L / 0 / R sprites and has no lane-angle input. */
export type ChartCanvasFlatNote = Omit<ChartCanvasNote, "lane">;

export interface ChartCanvasLanePlane {
  centerX: number;
  top?: number;
  height: number;
  /** Width of one visible lane band in canvas CSS pixels. */
  laneWidth: number;
  /** Screen-space style scale; positions still use laneWidth. */
  styleLaneWidth?: number;
  /** Number of equally sized visual bands across this flat lane plane. */
  bandCount?: number;
  /** Optional half-band markers matching the live stage's short space lines. */
  spaceCount?: number;
  laneFillStyle?: string;
  mainLineStyle?: string;
  spaceLineStyle?: string;
  outsideFillStyle?: string;
  outsideLineStyle?: string;
}

export type ChartCanvasRibbonKind = "slide" | "guide";

export interface ChartCanvasRibbonStyle {
  fillStyle: CanvasGradient;
  strokeStyle: string;
  lineWidth: number;
  alphaMultiplier: number;
}

export interface ChartCanvasRibbonSample {
  left: number;
  right: number;
  y: number;
}

const canvasSideSpritePrefixes = [
  "notes_tap_side_",
  "notes_flick_side_",
  "notes_flick_left_side_",
  "notes_flick_right_side_",
  "notes_slide_side_",
  "notes_slide_end_side_",
  "notes_slide_connection_side_",
  "notes_trace_side_",
] as const;

const canvasOverlaySpriteNames = new Set([
  "note_trace_3",
  "tap_decoration",
  "flick_decoration",
  "flick_left_decoration",
  "flick_right_decoration",
  "slide_decoration",
  "slide_connection_icon",
  ...["S", "M", "L", "LL"].map((size) => `notes_flick_arrow_upper_${size}`),
  ...["left", "right"].flatMap((direction) =>
    Array.from({ length: 8 }, (_, index) => `notes_flick_arrow_${direction}_${String(index + 1).padStart(2, "0")}`),
  ),
]);

function canvasAtlasManifest(assets: OurNotesAssetManifest): SpriteAtlasManifest {
  return {
    ...assets.noteAtlas,
    sprites: assets.noteAtlas.sprites.filter(
      (sprite) =>
        canvasOverlaySpriteNames.has(sprite.name) ||
        canvasSideSpritePrefixes.some((prefix) => sprite.name.startsWith(prefix)),
    ),
  };
}

function sourceImageSize(image: CanvasImageSource): { width: number; height: number } | undefined {
  const value = image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  const width = Number(value.naturalWidth ?? value.width);
  const height = Number(value.naturalHeight ?? value.height);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function drawTightSpriteQuad(
  context: CanvasRenderingContext2D,
  sprite: CachedCanvasSprite,
  quad: NoteSkinQuad,
  originX: number,
  originY: number,
  nativeToCss: number,
  slice: NoteSkinSlice = { x: 0, y: 0, width: 1, height: 1 },
): void {
  const width = Math.abs(quad.width) * nativeToCss;
  const height = quad.height * nativeToCss;
  const sourceWidth = slice.width * sprite.canvas.width;
  const sourceHeight = slice.height * sprite.canvas.height;
  if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return;
  context.save();
  context.translate(originX + quad.centerX * nativeToCss, originY - quad.centerY * nativeToCss);
  if (quad.width < 0) context.scale(-1, 1);
  context.drawImage(
    sprite.canvas,
    slice.x * sprite.canvas.width,
    slice.y * sprite.canvas.height,
    sourceWidth,
    sourceHeight,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  context.restore();
}

function drawTightSpriteOverlay(
  context: CanvasRenderingContext2D,
  sprite: CachedCanvasSprite,
  layout: { centerX: number; centerY: number; width: number; height: number; rotation: number },
  originX: number,
  originY: number,
  nativeToCss: number,
): void {
  const width = layout.width * nativeToCss;
  const height = layout.height * nativeToCss;
  if (width <= 0 || height <= 0) return;
  context.save();
  context.translate(originX + layout.centerX * nativeToCss, originY - layout.centerY * nativeToCss);
  // Shared layout is in Unity/Three's y-up coordinates; Canvas is y-down.
  context.rotate(-layout.rotation);
  context.drawImage(sprite.canvas, -width / 2, -height / 2, width, height);
  context.restore();
}

/**
 * Canvas renderer for the original skin001 note sprites used by both the
 * overview and authoring surfaces. Missing atlas data fails closed: no
 * geometric or palette substitute is emitted.
 */
export class ChartCanvasSkin {
  readonly missingSprites: readonly string[];
  private readonly spriteCache = new Map<string, CachedCanvasSprite>();

  private constructor(
    private readonly atlas: CanvasSpriteAtlas,
    private readonly tiltThresholds: OurNotesAssetManifest["tiltThresholds"],
  ) {
    this.missingSprites = atlas.missingSprites;
  }

  static async load(assets: OurNotesAssetManifest): Promise<ChartCanvasSkin> {
    return new ChartCanvasSkin(await CanvasSpriteAtlas.load(canvasAtlasManifest(assets)), assets.tiltThresholds);
  }

  drawNote(context: CanvasRenderingContext2D, note: ChartCanvasNote): boolean {
    if (!Number.isFinite(note.lane) || !this.validNote(note)) return false;
    const parts = selectNoteSkinParts({ kind: note.kind, lane: note.lane, width: note.laneSpan }, this.tiltThresholds);
    return this.drawNoteParts(context, note, parts);
  }

  /** Draws a flat authoring note without applying live-camera endpoint tilt. */
  drawFlatNote(context: CanvasRenderingContext2D, note: ChartCanvasFlatNote): boolean {
    if (!this.validNote(note)) return false;
    return this.drawNoteParts(context, note, selectFlatNoteSkinParts(note.kind));
  }

  /** Measures only the neutral L / 0 / R body in canvas CSS pixels. */
  flatNoteBodyHeight(kind: RenderNoteKind, stageWidth: number, scale = 1): number | undefined {
    if (!Number.isFinite(stageWidth) || stageWidth <= 0 || !Number.isFinite(scale)) return undefined;
    const parts = selectFlatNoteSkinParts(kind);
    const left = this.cachedSprite(parts.left.spriteName);
    const main = this.cachedSprite(parts.mainSpriteName);
    const right = this.cachedSprite(parts.right.spriteName);
    if (!left || !main || !right) return undefined;
    return (
      noteSkinBodyHeight(
        {
          leftBounds: left.bounds,
          mainBounds: main.bounds,
          rightBounds: right.bounds,
        },
        Math.max(0.001, scale),
      ) *
      (stageWidth / OUR_NOTES_LIVE_GEOMETRY.screenJudgementWidth)
    );
  }

  /** Finds a uniform native scale that gives a reference flat note the requested body height. */
  scaleForFlatNoteBodyHeight(
    stageWidth: number,
    targetCssHeight: number,
    referenceKind: RenderNoteKind = "tap",
  ): number | undefined {
    if (!Number.isFinite(targetCssHeight) || targetCssHeight <= 0) return undefined;
    const unscaledHeight = this.flatNoteBodyHeight(referenceKind, stageWidth, 1);
    return unscaledHeight && unscaledHeight > 0 ? targetCssHeight / unscaledHeight : undefined;
  }

  dispose(): void {
    this.spriteCache.clear();
    this.atlas.dispose();
  }

  private validNote(note: ChartCanvasFlatNote): boolean {
    return (
      Number.isFinite(note.laneSpan) &&
      Number.isFinite(note.centerX) &&
      Number.isFinite(note.centerY) &&
      Number.isFinite(note.width) &&
      Number.isFinite(note.stageWidth) &&
      note.laneSpan > 0 &&
      note.width > 0 &&
      note.stageWidth > 0 &&
      Number.isFinite(note.scale ?? 1)
    );
  }

  private drawNoteParts(context: CanvasRenderingContext2D, note: ChartCanvasFlatNote, parts: NoteSkinParts): boolean {
    const scale = Math.max(0.001, note.scale ?? 1);
    // Canvas `stageWidth` is the visible span of chart lanes 0..24. Notes in
    // screen_root use the decoded 15.4168896 judgement width, not the wider
    // 19.12-unit physical lane mesh used by note effects.
    const nativeToCss = note.stageWidth / OUR_NOTES_LIVE_GEOMETRY.screenJudgementWidth;
    const left = this.cachedSprite(parts.left.spriteName);
    const main = this.cachedSprite(parts.mainSpriteName);
    const right = this.cachedSprite(parts.right.spriteName);
    if (!left || !main || !right) return false;

    const bodyLayout = layoutNoteSkinBody({
      parts,
      leftBounds: left.bounds,
      rightBounds: right.bounds,
      mainBounds: main.bounds,
      mainRegion: main.region,
      viewWidth: note.width / nativeToCss,
      scale,
    });
    const mainSlices = noteSkinTightHorizontalSlices(main.region);
    drawTightSpriteQuad(context, left, bodyLayout.left, note.centerX, note.centerY, nativeToCss);
    drawTightSpriteQuad(context, main, bodyLayout.mainLeft, note.centerX, note.centerY, nativeToCss, mainSlices[0]);
    drawTightSpriteQuad(context, main, bodyLayout.mainMiddle, note.centerX, note.centerY, nativeToCss, mainSlices[1]);
    drawTightSpriteQuad(context, main, bodyLayout.mainRight, note.centerX, note.centerY, nativeToCss, mainSlices[2]);
    drawTightSpriteQuad(context, right, bodyLayout.right, note.centerX, note.centerY, nativeToCss);

    const decorationName = noteSkinDecorationName(note.kind);
    const decoration = decorationName ? this.cachedSprite(decorationName) : undefined;
    if (decoration) {
      drawTightSpriteOverlay(
        context,
        decoration,
        layoutNoteSkinDecoration(decoration.bounds, scale),
        note.centerX,
        note.centerY,
        nativeToCss,
      );
    }

    const arrowName = noteSkinArrowName({ kind: note.kind, direction: note.direction, width: note.laneSpan });
    const arrow = arrowName ? this.cachedSprite(arrowName) : undefined;
    if (arrow && arrowName) {
      drawTightSpriteOverlay(
        context,
        arrow,
        layoutNoteSkinArrow(arrowName, noteSkinEffectiveDirection(note), arrow.bounds, scale),
        note.centerX,
        note.centerY,
        nativeToCss,
      );
    }
    return true;
  }

  private cachedSprite(name: string): CachedCanvasSprite | undefined {
    const cached = this.spriteCache.get(name);
    if (cached) return cached;
    const region = this.atlas.region(name);
    const image = this.atlas.image;
    if (!region || !image) return undefined;
    const imageSize = sourceImageSize(image);
    if (!imageSize) return undefined;

    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.ceil(region.rect.width));
    crop.height = Math.max(1, Math.ceil(region.rect.height));
    const cropContext = crop.getContext("2d");
    if (!cropContext) return undefined;
    cropContext.drawImage(
      image,
      region.rect.x,
      imageSize.height - region.rect.y - region.rect.height,
      region.rect.width,
      region.rect.height,
      0,
      0,
      crop.width,
      crop.height,
    );

    const oriented = document.createElement("canvas");
    const rotated = region.packingRotation === 4;
    oriented.width = rotated ? crop.height : crop.width;
    oriented.height = rotated ? crop.width : crop.height;
    const orientedContext = oriented.getContext("2d");
    if (!orientedContext) return undefined;
    if (region.packingRotation === 1) {
      orientedContext.translate(oriented.width, 0);
      orientedContext.scale(-1, 1);
    } else if (region.packingRotation === 2) {
      orientedContext.translate(0, oriented.height);
      orientedContext.scale(1, -1);
    } else if (region.packingRotation === 3) {
      orientedContext.translate(oriented.width, oriented.height);
      orientedContext.scale(-1, -1);
    } else if (region.packingRotation === 4) {
      orientedContext.translate(oriented.width, 0);
      orientedContext.rotate(Math.PI / 2);
    }
    orientedContext.drawImage(crop, 0, 0);

    const result = { canvas: oriented, region, bounds: noteSkinSpriteBounds(region) };
    this.spriteCache.set(name, result);
    return result;
  }
}

export function loadChartCanvasSkin(assets: OurNotesAssetManifest): Promise<ChartCanvasSkin> {
  return ChartCanvasSkin.load(assets);
}

/** Draws the flat lane plane shared by the chart overview and editor. */
export function drawChartCanvasLanePlane(context: CanvasRenderingContext2D, options: ChartCanvasLanePlane): void {
  const top = options.top ?? 0;
  const bandCount = Math.max(1, Math.round(options.bandCount ?? 6));
  const spaceCount = Math.max(0, Math.round(options.spaceCount ?? 0));
  const styleLaneWidth = Math.max(0.001, options.styleLaneWidth ?? options.laneWidth);
  const mainLineWidth = styleLaneWidth / 10;
  const laneLeft = options.centerX - (bandCount / 2) * options.laneWidth;
  const laneRight = options.centerX + (bandCount / 2) * options.laneWidth;
  context.save();
  context.lineWidth = mainLineWidth;
  context.fillStyle = options.laneFillStyle ?? "rgba(0, 0, 25, 0.4)";
  context.fillRect(laneLeft, top, laneRight - laneLeft, options.height);
  context.strokeStyle = options.mainLineStyle ?? "rgba(128, 255, 255, 0.2)";
  context.beginPath();
  for (let lane = 1; lane < bandCount; lane++) {
    const x = laneLeft + lane * options.laneWidth;
    context.moveTo(x, top);
    context.lineTo(x, top + options.height);
  }
  context.stroke();
  if (spaceCount > bandCount) {
    context.lineWidth = Math.max(0.5, styleLaneWidth / 20);
    context.strokeStyle = options.spaceLineStyle ?? "rgba(128, 255, 255, 0.1)";
    context.beginPath();
    for (let space = 1; space < spaceCount; space++) {
      if ((space * bandCount) % spaceCount === 0) continue;
      const x = laneLeft + (space / spaceCount) * (laneRight - laneLeft);
      context.moveTo(x, top);
      context.lineTo(x, top + options.height);
    }
    context.stroke();
  }
  context.fillStyle = options.outsideFillStyle ?? "rgba(0, 255, 255, 0.3)";
  context.strokeStyle = options.outsideLineStyle ?? "rgba(0, 255, 255, 0.5)";
  context.lineWidth = mainLineWidth;
  context.beginPath();
  for (const side of [-1, 1]) {
    const x = options.centerX + side * (bandCount / 2) * options.laneWidth;
    context.fillRect(x, top, 0.25 * side * styleLaneWidth, options.height);
    context.moveTo(x, top);
    context.lineTo(x, top + options.height);
  }
  context.stroke();
  context.restore();
}

/** Creates the decoded skin001 slide-line palette for one canvas viewport. */
export function createChartCanvasRibbonStyle(
  context: CanvasRenderingContext2D,
  kind: ChartCanvasRibbonKind,
  height: number,
  laneWidth: number,
  top = 0,
): ChartCanvasRibbonStyle {
  const fillStyle = context.createLinearGradient(0, top + height, 0, top);
  if (kind === "guide") {
    fillStyle.addColorStop(0, "rgba(120, 98, 255, 0.34)");
    fillStyle.addColorStop(1, "rgba(178, 137, 255, 0.42)");
    return {
      fillStyle,
      strokeStyle: "rgba(171, 142, 255, 0.72)",
      lineWidth: laneWidth / 10,
      alphaMultiplier: 0.7,
    };
  }
  fillStyle.addColorStop(0, "rgba(122, 73, 255, 0.86)");
  fillStyle.addColorStop(0.55, "rgba(68, 83, 217, 0.86)");
  fillStyle.addColorStop(1, "rgba(93, 132, 250, 0.71)");
  return {
    fillStyle,
    strokeStyle: "rgba(151, 122, 255, 0.82)",
    lineWidth: laneWidth / 10,
    alphaMultiplier: 1,
  };
}

/**
 * Draws one closed ribbon with an inside-only outline. Keeping the stroke
 * inside the authored polygon prevents sharp joins from protruding beyond
 * its endpoint notes.
 */
export function drawChartCanvasRibbon(
  context: CanvasRenderingContext2D,
  samples: readonly ChartCanvasRibbonSample[],
  style: ChartCanvasRibbonStyle,
  alpha = 1,
): void {
  if (samples.length < 2) return;
  context.save();
  context.beginPath();
  context.moveTo(samples[0]!.left, samples[0]!.y);
  for (let index = 1; index < samples.length; index++) {
    const sample = samples[index]!;
    context.lineTo(sample.left, sample.y);
  }
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!;
    context.lineTo(sample.right, sample.y);
  }
  context.closePath();
  context.globalAlpha *= Math.max(0, Math.min(1, alpha)) * style.alphaMultiplier;
  context.fillStyle = style.fillStyle;
  context.fill();
  if (style.lineWidth > 0) {
    context.save();
    context.clip();
    context.strokeStyle = style.strokeStyle;
    context.lineWidth = style.lineWidth * 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
    context.restore();
  }
  context.restore();
}
