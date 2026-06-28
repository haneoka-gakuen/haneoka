import type { SpriteRegion } from "../assets/SpriteAtlas";
import type { RenderDirection, RenderNoteKind } from "./types";

export interface NoteSkinEndpoint {
  spriteName: string;
  overhang: number;
  flipX: boolean;
}

export interface NoteSkinParts {
  mainSpriteName: string;
  left: NoteSkinEndpoint;
  right: NoteSkinEndpoint;
}

export interface NoteSkinSpriteBounds {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface NoteSkinQuad {
  centerX: number;
  centerY: number;
  /** A negative width mirrors the source around the quad centre. */
  width: number;
  height: number;
}

export interface NoteSkinBodyLayout {
  left: NoteSkinQuad;
  mainLeft: NoteSkinQuad;
  mainMiddle: NoteSkinQuad;
  mainRight: NoteSkinQuad;
  right: NoteSkinQuad;
}

export interface NoteSkinOverlayLayout {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
}

export interface NoteSkinSlice {
  x: number;
  y: number;
  width: number;
  height: number;
}

type NoteSkinSelectionInput = {
  kind: RenderNoteKind;
  lane: number;
  width: number;
};

type NoteSkinArrowInput = {
  kind: RenderNoteKind;
  direction?: RenderDirection;
  width: number;
};

// SiriusAsset.NoteSideParts in skin001. These are the serialized values used
// by LiveSpritePartsNoteViewBase, rather than dimensions inferred from a mock
// canvas shape.
const COMMON_RIGHT_OVERHANG = [0, 0.07, 0.08, 0.09, 0.11, 0.08, 0.18] as const;
const COMMON_LEFT_OVERHANG = [0, 0.21, 0.2, 0.19, 0.33, 0.31, 0] as const;
const SLIDE_END_RIGHT_OVERHANG = [0.18, 0.19, 0.21, 0.24, 0.31, 0.32, 0.48] as const;
const SLIDE_END_LEFT_OVERHANG = [0.18, 0.31, 0.27, 0.41, 0.38, 0.31, 0] as const;
const NO_OVERHANG = [0, 0, 0, 0, 0, 0, 0] as const;
const CENTER_LANE = 11.5;
const CENTER_BOUNDARY = 12;
const DIRECTIONAL_ARROW_THRESHOLDS = [5, 7, 10, 13, 16, 19, 21, 99] as const;

const COMMON_OVERHANGS = { right: COMMON_RIGHT_OVERHANG, left: COMMON_LEFT_OVERHANG } as const;
const SLIDE_END_OVERHANGS = { right: SLIDE_END_RIGHT_OVERHANG, left: SLIDE_END_LEFT_OVERHANG } as const;
const NO_OVERHANGS = { right: NO_OVERHANG, left: NO_OVERHANG } as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function noteSkinPrefix(kind: RenderNoteKind): string {
  switch (kind) {
    case "tap":
      return "notes_tap_side";
    case "flick":
      return "notes_flick_side";
    case "flick-left":
      return "notes_flick_left_side";
    case "flick-right":
      return "notes_flick_right_side";
    case "slide-start":
      return "notes_slide_side";
    case "slide-node":
      return "notes_slide_connection_side";
    case "slide-end":
      return "notes_slide_end_side";
    case "trace":
    case "guide":
      return "notes_trace_side";
  }
}

export function noteSkinDecorationName(kind: RenderNoteKind): string | undefined {
  switch (kind) {
    case "tap":
      return "tap_decoration";
    case "flick":
      return "flick_decoration";
    case "flick-left":
      return "flick_left_decoration";
    case "flick-right":
      return "flick_right_decoration";
    case "slide-start":
      return "slide_decoration";
    case "slide-node":
      return "slide_connection_icon";
    case "trace":
    case "guide":
      return "note_trace_3";
    // LiveSlideEndNoteView has no rendered mark SpriteRenderer.
    case "slide-end":
      return undefined;
  }
}

export function noteSkinEffectiveDirection(note: Pick<NoteSkinArrowInput, "kind" | "direction">): RenderDirection {
  if (note.direction && note.direction !== "none") return note.direction;
  if (note.kind === "flick-left") return "left";
  if (note.kind === "flick-right") return "right";
  return note.kind === "flick" ? "up" : "none";
}

export function noteSkinArrowName(note: NoteSkinArrowInput): string | undefined {
  if (!note.kind.startsWith("flick")) return undefined;
  const direction = noteSkinEffectiveDirection(note);
  if (direction === "up") {
    // LiveFlickNoteView._arrowSpriteEntries branches on width < MaxWidth.
    const size = note.width < 5 ? "S" : note.width < 12 ? "M" : note.width < 17 ? "L" : "LL";
    return `notes_flick_arrow_upper_${size}`;
  }
  if (direction !== "left" && direction !== "right") return undefined;
  const index = DIRECTIONAL_ARROW_THRESHOLDS.findIndex((threshold) => note.width < threshold);
  return `notes_flick_arrow_${direction}_${String(index < 0 ? 8 : index + 1).padStart(2, "0")}`;
}

function overhangsForKind(kind: RenderNoteKind): {
  right: ReadonlyArray<number>;
  left: ReadonlyArray<number>;
} {
  if (kind === "slide-end") return SLIDE_END_OVERHANGS;
  if (kind === "slide-node" || kind === "trace" || kind === "guide") return NO_OVERHANGS;
  return COMMON_OVERHANGS;
}

function rightSprite(prefix: string, tilt: number): string {
  return tilt === 0 ? `${prefix}_R` : `${prefix}_${tilt}`;
}

function leftSprite(prefix: string, tilt: number): string {
  // The serialized tilt-6 LeftSprite intentionally reuses the tilt-4 asset.
  if (tilt === 0) return `${prefix}_L`;
  return `${prefix}_${tilt === 6 ? -4 : -tilt}`;
}

function tiltValue(distance: number, thresholds: ReadonlyArray<{ distance: number; value: number }>): number {
  let value = 0;
  for (const threshold of thresholds) {
    value = threshold.value;
    // Native entries are inclusive upper bounds (ceil buckets).
    if (threshold.distance >= distance) break;
  }
  return clamp(value, 0, 6);
}

/** Exact branch structure of LiveSpritePartsNoteViewBase.OnSetViewWidth. */
export function selectNoteSkinParts(
  note: NoteSkinSelectionInput,
  thresholds: ReadonlyArray<{ distance: number; value: number }>,
): NoteSkinParts {
  const prefix = noteSkinPrefix(note.kind);
  const leftBoundary = note.lane;
  const rightBoundary = note.lane + note.width;
  const laneCenter = note.lane + (note.width - 1) / 2;
  const leftTilt = tiltValue(Math.abs(leftBoundary - CENTER_BOUNDARY), thresholds);
  const rightTilt = tiltValue(Math.abs(rightBoundary - CENTER_BOUNDARY), thresholds);
  const overhangs = overhangsForKind(note.kind);

  const fromRight = (tilt: number, flipX: boolean): NoteSkinEndpoint => ({
    spriteName: rightSprite(prefix, tilt),
    overhang: overhangs.right[tilt] ?? 0,
    flipX,
  });
  const fromLeft = (tilt: number, flipX: boolean): NoteSkinEndpoint => ({
    spriteName: leftSprite(prefix, tilt),
    overhang: overhangs.left[tilt] ?? 0,
    flipX,
  });

  if (leftBoundary < CENTER_BOUNDARY && rightBoundary > CENTER_BOUNDARY) {
    return {
      mainSpriteName: `${prefix}_0`,
      left: fromRight(leftTilt, true),
      right: fromRight(rightTilt, false),
    };
  }
  if (laneCenter < CENTER_LANE) {
    return {
      mainSpriteName: `${prefix}_0`,
      left: fromRight(leftTilt, true),
      right: fromLeft(rightTilt, true),
    };
  }
  return {
    mainSpriteName: `${prefix}_0`,
    left: fromLeft(leftTilt, false),
    right: fromRight(rightTilt, false),
  };
}

/**
 * Selects the decoded, non-tilted L / 0 / R sprite triplet for a flat canvas.
 *
 * The live renderer deliberately changes endpoint sprites with screen
 * position to match its perspective camera. A vertical authoring timeline
 * has no such camera, so carrying that branch across makes the same note bend
 * as it moves between lanes. These are the original skin001 neutral parts;
 * no geometric substitute is introduced.
 */
export function selectFlatNoteSkinParts(kind: RenderNoteKind): NoteSkinParts {
  const prefix = noteSkinPrefix(kind);
  const overhangs = overhangsForKind(kind);
  return {
    mainSpriteName: `${prefix}_0`,
    left: {
      spriteName: `${prefix}_L`,
      overhang: overhangs.left[0] ?? 0,
      flipX: false,
    },
    right: {
      spriteName: `${prefix}_R`,
      overhang: overhangs.right[0] ?? 0,
      flipX: false,
    },
  };
}

/** Unity Sprite.get_bounds calculated from the packed tight textureRect. */
export function noteSkinSpriteBounds(region: SpriteRegion): NoteSkinSpriteBounds {
  const rotated = region.packingRotation === 4;
  const pixelWidth = rotated ? region.rect.height : region.rect.width;
  const pixelHeight = rotated ? region.rect.width : region.rect.height;
  const ppu = region.pixelsToUnits;
  return {
    width: pixelWidth / ppu,
    height: pixelHeight / ppu,
    centerX: (region.offset.x + pixelWidth / 2 - region.pivot.x * region.sourceSize.width) / ppu,
    centerY: (region.offset.y + pixelHeight / 2 - region.pivot.y * region.sourceSize.height) / ppu,
  };
}

/** Height of the complete note body before decorations and flick arrows. */
export function noteSkinBodyHeight(
  bounds: {
    leftBounds: NoteSkinSpriteBounds;
    mainBounds: NoteSkinSpriteBounds;
    rightBounds: NoteSkinSpriteBounds;
  },
  scale = 1,
): number {
  const sprites = [bounds.leftBounds, bounds.mainBounds, bounds.rightBounds];
  const top = Math.max(...sprites.map((sprite) => sprite.centerY + sprite.height / 2));
  const bottom = Math.min(...sprites.map((sprite) => sprite.centerY - sprite.height / 2));
  return Math.max(0, top - bottom) * Math.max(0, scale);
}

/**
 * Horizontal slices expressed in tight source textureRect coordinates.
 * Unity's border is authored against m_Rect, so textureRectOffset must be
 * removed before the atlas crop can be sliced.
 */
export function noteSkinTightHorizontalSlices(
  region: SpriteRegion,
): readonly [NoteSkinSlice, NoteSkinSlice, NoteSkinSlice] {
  const tightWidth = region.packingRotation === 4 ? region.rect.height : region.rect.width;
  if (tightWidth <= 0) {
    const empty = { x: 0, y: 0, width: 0, height: 1 } as const;
    return [empty, empty, empty];
  }
  const leftEnd = clamp(region.border.left - region.offset.x, 0, tightWidth);
  const rightStart = clamp(region.sourceSize.width - region.border.right - region.offset.x, leftEnd, tightWidth);
  return [
    { x: 0, y: 0, width: leftEnd / tightWidth, height: 1 },
    { x: leftEnd / tightWidth, y: 0, width: (rightStart - leftEnd) / tightWidth, height: 1 },
    { x: rightStart / tightWidth, y: 0, width: (tightWidth - rightStart) / tightWidth, height: 1 },
  ];
}

/** Shared native five-quad body layout for WebGL and 2D canvas. */
export function layoutNoteSkinBody(options: {
  parts: NoteSkinParts;
  leftBounds: NoteSkinSpriteBounds;
  rightBounds: NoteSkinSpriteBounds;
  mainBounds: NoteSkinSpriteBounds;
  mainRegion: SpriteRegion;
  /** Final body width in native world units (already includes note scale). */
  viewWidth: number;
  /** Native Transform scale applied to all non-stretched sprite dimensions. */
  scale: number;
}): NoteSkinBodyLayout {
  const scale = Math.max(0, options.scale);
  const leftWidth = options.leftBounds.width * scale;
  const rightWidth = options.rightBounds.width * scale;
  const leftHeight = options.leftBounds.height * scale;
  const rightHeight = options.rightBounds.height * scale;
  const mainHeight = options.mainBounds.height * scale;
  const leftOverhang = options.parts.left.overhang * scale;
  const rightOverhang = options.parts.right.overhang * scale;
  const leftCenterX = options.leftBounds.centerX * scale;
  const leftCenterY = options.leftBounds.centerY * scale;
  const rightCenterX = options.rightBounds.centerX * scale;
  const rightCenterY = options.rightBounds.centerY * scale;

  const mainWidth = Math.max(0.001, options.viewWidth - leftWidth - rightWidth + leftOverhang + rightOverhang);
  const mainX = (leftWidth - rightWidth + rightOverhang - leftOverhang) / 2;

  // SpriteRenderer drawMode=Sliced preserves the serialized m_Border values.
  // If the requested width is narrower than both caps, Unity scales them down
  // together rather than inventing a fixed 4px cap.
  const rawLeftBorder = (Math.max(0, options.mainRegion.border.left) / options.mainRegion.pixelsToUnits) * scale;
  const rawRightBorder = (Math.max(0, options.mainRegion.border.right) / options.mainRegion.pixelsToUnits) * scale;
  const borderTotal = rawLeftBorder + rawRightBorder;
  const borderScale = borderTotal > mainWidth && borderTotal > 0 ? mainWidth / borderTotal : 1;
  const leftBorder = rawLeftBorder * borderScale;
  const rightBorder = rawRightBorder * borderScale;
  const middleWidth = Math.max(0, mainWidth - leftBorder - rightBorder);

  return {
    left: {
      centerX:
        -options.viewWidth / 2 + leftWidth / 2 - leftOverhang + (options.parts.left.flipX ? -leftCenterX : leftCenterX),
      centerY: leftCenterY,
      width: options.parts.left.flipX ? -leftWidth : leftWidth,
      height: leftHeight,
    },
    mainLeft: {
      centerX: mainX - mainWidth / 2 + leftBorder / 2,
      centerY: 0,
      width: leftBorder,
      height: mainHeight,
    },
    mainMiddle: {
      centerX: mainX + (leftBorder - rightBorder) / 2,
      centerY: 0,
      width: middleWidth,
      height: mainHeight,
    },
    mainRight: {
      centerX: mainX + mainWidth / 2 - rightBorder / 2,
      centerY: 0,
      width: rightBorder,
      height: mainHeight,
    },
    right: {
      centerX:
        options.viewWidth / 2 -
        rightWidth / 2 +
        rightOverhang +
        (options.parts.right.flipX ? -rightCenterX : rightCenterX),
      centerY: rightCenterY,
      width: options.parts.right.flipX ? -rightWidth : rightWidth,
      height: rightHeight,
    },
  };
}

export function layoutNoteSkinDecoration(bounds: NoteSkinSpriteBounds, scale: number): NoteSkinOverlayLayout {
  return {
    centerX: bounds.centerX * scale,
    centerY: bounds.centerY * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
    rotation: 0,
  };
}

export function layoutNoteSkinArrow(
  spriteName: string,
  direction: RenderDirection,
  bounds: NoteSkinSpriteBounds,
  scale: number,
): NoteSkinOverlayLayout {
  const isUpper = spriteName.startsWith("notes_flick_arrow_upper_");
  const arrowScale = isUpper ? 0.8 : 1;
  const rotation = !isUpper && direction === "left" ? Math.PI : 0;
  const rotationCos = Math.cos(rotation);
  const rotationSin = Math.sin(rotation);
  const centerX = bounds.centerX * scale * arrowScale;
  const centerY = bounds.centerY * scale * arrowScale;
  return {
    centerX: centerX * rotationCos - centerY * rotationSin,
    centerY: (isUpper ? 1.15 : 1) * scale + centerX * rotationSin + centerY * rotationCos,
    width: bounds.width * scale * arrowScale,
    height: bounds.height * scale * arrowScale,
    rotation,
  };
}
