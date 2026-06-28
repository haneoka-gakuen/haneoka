import type { TmpSdfFontAssetManifest } from "../assets/manifest";

interface UnityTmpFaceInfo {
  m_AscentLine?: unknown;
  m_DescentLine?: unknown;
  m_PointSize?: unknown;
  m_Scale?: unknown;
}

interface UnityTmpCharacter {
  m_GlyphIndex?: unknown;
  m_Scale?: unknown;
  m_Unicode?: unknown;
}

interface UnityTmpGlyph {
  m_AtlasIndex?: unknown;
  m_GlyphRect?: {
    m_Height?: unknown;
    m_Width?: unknown;
    m_X?: unknown;
    m_Y?: unknown;
  };
  m_Index?: unknown;
  m_Metrics?: {
    m_Height?: unknown;
    m_HorizontalAdvance?: unknown;
    m_HorizontalBearingX?: unknown;
    m_HorizontalBearingY?: unknown;
    m_Width?: unknown;
  };
  m_Scale?: unknown;
}

interface UnityTmpAdjustmentRecord {
  m_GlyphIndex?: unknown;
  m_GlyphValueRecord?: {
    m_XAdvance?: unknown;
    m_XPlacement?: unknown;
    m_YAdvance?: unknown;
    m_YPlacement?: unknown;
  };
}

interface UnityTmpPairAdjustment {
  m_FirstAdjustmentRecord?: UnityTmpAdjustmentRecord;
  m_SecondAdjustmentRecord?: UnityTmpAdjustmentRecord;
}

interface UnityTmpFontAsset {
  data?: {
    m_AtlasHeight?: unknown;
    m_AtlasPadding?: unknown;
    m_AtlasWidth?: unknown;
    m_CharacterTable?: UnityTmpCharacter[];
    m_FaceInfo?: UnityTmpFaceInfo;
    m_FontFeatureTable?: { m_GlyphPairAdjustmentRecords?: UnityTmpPairAdjustment[] };
    m_GlyphTable?: UnityTmpGlyph[];
  };
}

interface GlyphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GlyphMetrics {
  width: number;
  height: number;
  horizontalBearingX: number;
  horizontalBearingY: number;
  horizontalAdvance: number;
}

interface Glyph {
  index: number;
  rect: GlyphRect;
  metrics: GlyphMetrics;
  scale: number;
}

interface Character {
  glyph: Glyph;
  scale: number;
}

interface GlyphAdjustment {
  xAdvance: number;
  xPlacement: number;
  yAdvance: number;
  yPlacement: number;
}

interface PairAdjustment {
  first: GlyphAdjustment;
  second: GlyphAdjustment;
}

interface PositionedCharacter {
  character: Character;
  advanceAdjustment: number;
  value: string;
  xPlacement: number;
  yPlacement: number;
}

interface TextLayout {
  characters: PositionedCharacter[];
  scale: number;
  width: number;
}

export interface TmpSdfTextOptions {
  align?: "left" | "center" | "right";
  characterSpacing?: number;
  color: string | ((character: string, index: number) => string);
  fontSize: number;
}

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function positive(value: unknown, fallback: number): number {
  const result = finite(value, fallback);
  return result > 0 ? result : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return Math.trunc(finite(value, fallback));
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function adjustment(value: UnityTmpAdjustmentRecord | undefined): GlyphAdjustment {
  const record = value?.m_GlyphValueRecord;
  return {
    xAdvance: finite(record?.m_XAdvance),
    xPlacement: finite(record?.m_XPlacement),
    yAdvance: finite(record?.m_YAdvance),
    yPlacement: finite(record?.m_YPlacement),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load TMP SDF atlas: ${url}`));
    image.src = url;
  });
}

async function loadMetadata(url: string): Promise<UnityTmpFontAsset> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as UnityTmpFontAsset;
}

/**
 * Canvas projection of the original TextMesh Pro SDF font asset.
 *
 * Glyph placement and advances come from TMP's own tables. The atlas alpha is
 * converted with TMP's normal-face distance threshold instead of asking the
 * browser to substitute a CSS font.
 */
export class TmpSdfFont {
  private readonly characters = new Map<number, Character>();
  private readonly pairAdjustments = new Map<string, PairAdjustment>();
  private readonly maskAtlases = new Map<number, HTMLCanvasElement>();
  private readonly tintedGlyphs = new Map<string, HTMLCanvasElement>();
  private readonly atlasAlpha: Uint8ClampedArray;
  private disposed = false;

  private constructor(
    private readonly atlasWidth: number,
    private readonly atlasHeight: number,
    private readonly atlasPadding: number,
    private readonly pointSize: number,
    private readonly faceScale: number,
    private readonly ascentLine: number,
    private readonly descentLine: number,
    atlasAlpha: Uint8ClampedArray,
    glyphs: ReadonlyMap<number, Glyph>,
    characterTable: ReadonlyArray<UnityTmpCharacter>,
    pairTable: ReadonlyArray<UnityTmpPairAdjustment>,
  ) {
    this.atlasAlpha = atlasAlpha;
    for (const entry of characterTable) {
      const unicode = integer(entry.m_Unicode, -1);
      const glyph = glyphs.get(integer(entry.m_GlyphIndex, -1));
      if (unicode < 0 || unicode > 0x10ffff || !glyph) continue;
      this.characters.set(unicode, { glyph, scale: positive(entry.m_Scale, 1) });
    }
    for (const entry of pairTable) {
      const firstIndex = integer(entry.m_FirstAdjustmentRecord?.m_GlyphIndex, -1);
      const secondIndex = integer(entry.m_SecondAdjustmentRecord?.m_GlyphIndex, -1);
      if (firstIndex < 0 || secondIndex < 0) continue;
      this.pairAdjustments.set(`${firstIndex}:${secondIndex}`, {
        first: adjustment(entry.m_FirstAdjustmentRecord),
        second: adjustment(entry.m_SecondAdjustmentRecord),
      });
    }
  }

  static async load(manifest: TmpSdfFontAssetManifest): Promise<TmpSdfFont> {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      throw new Error("TMP SDF font rendering requires browser canvas APIs");
    }
    const [image, asset] = await Promise.all([loadImage(manifest.atlasTextureUrl), loadMetadata(manifest.metadataUrl)]);
    const data = asset.data;
    const face = data?.m_FaceInfo;
    const atlasWidth = integer(data?.m_AtlasWidth);
    const atlasHeight = integer(data?.m_AtlasHeight);
    if (!data || !face || atlasWidth <= 0 || atlasHeight <= 0) {
      throw new Error(`Invalid TMP font projection: ${manifest.metadataUrl}`);
    }
    if (image.naturalWidth !== atlasWidth || image.naturalHeight !== atlasHeight) {
      throw new Error(
        `TMP atlas dimensions differ from metadata: ${image.naturalWidth}x${image.naturalHeight} != ${atlasWidth}x${atlasHeight}`,
      );
    }

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = atlasWidth;
    sourceCanvas.height = atlasHeight;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) throw new Error("Unable to create TMP SDF atlas canvas");
    sourceContext.drawImage(image, 0, 0);
    const pixels = sourceContext.getImageData(0, 0, atlasWidth, atlasHeight).data;
    const atlasAlpha = new Uint8ClampedArray(atlasWidth * atlasHeight);
    for (let source = 3, target = 0; source < pixels.length; source += 4, target += 1) {
      atlasAlpha[target] = pixels[source]!;
    }
    sourceCanvas.width = 1;
    sourceCanvas.height = 1;

    const glyphs = new Map<number, Glyph>();
    for (const entry of data.m_GlyphTable ?? []) {
      const index = integer(entry.m_Index, -1);
      const rect = entry.m_GlyphRect;
      const metrics = entry.m_Metrics;
      if (index < 0 || integer(entry.m_AtlasIndex) !== 0 || !rect || !metrics) continue;
      const normalizedRect: GlyphRect = {
        x: integer(rect.m_X),
        y: integer(rect.m_Y),
        width: Math.max(0, integer(rect.m_Width)),
        height: Math.max(0, integer(rect.m_Height)),
      };
      if (
        normalizedRect.x < 0 ||
        normalizedRect.y < 0 ||
        normalizedRect.x + normalizedRect.width > atlasWidth ||
        normalizedRect.y + normalizedRect.height > atlasHeight
      ) {
        continue;
      }
      glyphs.set(index, {
        index,
        rect: normalizedRect,
        metrics: {
          width: Math.max(0, finite(metrics.m_Width)),
          height: Math.max(0, finite(metrics.m_Height)),
          horizontalBearingX: finite(metrics.m_HorizontalBearingX),
          horizontalBearingY: finite(metrics.m_HorizontalBearingY),
          horizontalAdvance: finite(metrics.m_HorizontalAdvance),
        },
        scale: positive(entry.m_Scale, 1),
      });
    }

    const font = new TmpSdfFont(
      atlasWidth,
      atlasHeight,
      Math.max(0, integer(data.m_AtlasPadding)),
      positive(face.m_PointSize, 1),
      positive(face.m_Scale, 1),
      finite(face.m_AscentLine),
      finite(face.m_DescentLine),
      atlasAlpha,
      glyphs,
      data.m_CharacterTable ?? [],
      data.m_FontFeatureTable?.m_GlyphPairAdjustmentRecords ?? [],
    );
    if (!font.characters.size) {
      font.dispose();
      throw new Error(`TMP font contains no renderable characters: ${manifest.metadataUrl}`);
    }
    return font;
  }

  canRender(text: string): boolean {
    return [...text].every((value) => this.characters.has(value.codePointAt(0)!));
  }

  measureText(text: string, fontSize: number, characterSpacing = 0): number | undefined {
    return this.layout(text, fontSize, characterSpacing)?.width;
  }

  drawText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    centerY: number,
    options: TmpSdfTextOptions,
  ): boolean {
    if (this.disposed || !text) return false;
    const characterSpacing = finite(options.characterSpacing);
    const layout = this.layout(text, options.fontSize, characterSpacing);
    if (!layout) return false;
    let penX = options.align === "center" ? x - layout.width / 2 : options.align === "right" ? x - layout.width : x;
    // TMP vertical middle alignment uses the font asset's ascent/descent
    // lines, not browser-specific Canvas TextMetrics.
    const baselineY = centerY + ((this.ascentLine + this.descentLine) * layout.scale) / 2;

    for (let index = 0; index < layout.characters.length; index += 1) {
      const positioned = layout.characters[index]!;
      const { character } = positioned;
      const { glyph } = character;
      const glyphScale = layout.scale * character.scale * glyph.scale;
      if (glyph.rect.width > 0 && glyph.rect.height > 0 && glyph.metrics.width > 0 && glyph.metrics.height > 0) {
        const color = typeof options.color === "function" ? options.color(positioned.value, index) : options.color;
        const tintedGlyph = this.tintedGlyph(glyph, options.fontSize, color);
        if (!tintedGlyph) return false;
        const destinationX =
          penX + positioned.xPlacement * layout.scale + glyph.metrics.horizontalBearingX * glyphScale;
        const destinationY =
          baselineY - positioned.yPlacement * layout.scale - glyph.metrics.horizontalBearingY * glyphScale;
        context.drawImage(
          tintedGlyph,
          destinationX,
          destinationY,
          glyph.metrics.width * glyphScale,
          glyph.metrics.height * glyphScale,
        );
      }
      penX +=
        glyph.metrics.horizontalAdvance * glyphScale +
        positioned.advanceAdjustment * layout.scale +
        (index + 1 < layout.characters.length ? characterSpacing : 0);
    }
    return true;
  }

  private layout(text: string, fontSize: number, characterSpacing: number): TextLayout | undefined {
    if (this.disposed || !Number.isFinite(fontSize) || fontSize <= 0) return undefined;
    const characters: PositionedCharacter[] = [];
    for (const value of text) {
      const character = this.characters.get(value.codePointAt(0)!);
      if (!character) return undefined;
      characters.push({ character, advanceAdjustment: 0, value, xPlacement: 0, yPlacement: 0 });
    }
    const scale = (fontSize / this.pointSize) * this.faceScale;
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const first = characters[index]!;
      const second = characters[index + 1]!;
      const pair = this.pairAdjustments.get(`${first.character.glyph.index}:${second.character.glyph.index}`);
      if (!pair) continue;
      first.advanceAdjustment += pair.first.xAdvance;
      first.xPlacement += pair.first.xPlacement;
      first.yPlacement += pair.first.yPlacement;
      second.advanceAdjustment += pair.second.xAdvance;
      second.xPlacement += pair.second.xPlacement;
      second.yPlacement += pair.second.yPlacement;
    }
    let width = 0;
    for (let index = 0; index < characters.length; index += 1) {
      const positioned = characters[index]!;
      const characterScale = scale * positioned.character.scale * positioned.character.glyph.scale;
      width +=
        positioned.character.glyph.metrics.horizontalAdvance * characterScale +
        positioned.advanceAdjustment * scale +
        (index + 1 < characters.length ? characterSpacing : 0);
    }
    return { characters, scale, width: Math.max(0, width) };
  }

  private maskAtlas(fontSize: number): HTMLCanvasElement | undefined {
    const key = Math.round(fontSize * 1024) / 1024;
    const cached = this.maskAtlases.get(key);
    if (cached) return cached;
    if (this.disposed) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = this.atlasWidth;
    canvas.height = this.atlasHeight;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const image = context.createImageData(this.atlasWidth, this.atlasHeight);
    // TMP's default material has zero face dilate/weight. GradientScale is
    // generated as atlas padding + 1 (12 + 1 for this exact font asset).
    const distanceScale = Math.max(1, (this.atlasPadding + 1) * (key / this.pointSize) * this.faceScale);
    for (let pixel = 0, target = 0; pixel < this.atlasAlpha.length; pixel += 1, target += 4) {
      const coverage = clamp((this.atlasAlpha[pixel]! / 255 - 0.5) * distanceScale + 0.5);
      image.data[target] = 255;
      image.data[target + 1] = 255;
      image.data[target + 2] = 255;
      image.data[target + 3] = Math.round(coverage * 255);
    }
    context.putImageData(image, 0, 0);
    this.maskAtlases.set(key, canvas);
    return canvas;
  }

  private tintedGlyph(glyph: Glyph, fontSize: number, color: string): HTMLCanvasElement | undefined {
    const sizeKey = Math.round(fontSize * 1024) / 1024;
    const key = `${sizeKey}:${color}:${glyph.index}`;
    const cached = this.tintedGlyphs.get(key);
    if (cached) return cached;
    const atlas = this.maskAtlas(sizeKey);
    if (!atlas) return undefined;
    const width = Math.max(1, glyph.rect.width);
    const height = Math.max(1, glyph.rect.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const sourceY = this.atlasHeight - glyph.rect.y - glyph.rect.height;
    context.drawImage(atlas, glyph.rect.x, sourceY, width, height, 0, 0, width, height);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    this.tintedGlyphs.set(key, canvas);
    return canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const canvas of this.maskAtlases.values()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    for (const canvas of this.tintedGlyphs.values()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.maskAtlases.clear();
    this.tintedGlyphs.clear();
    this.characters.clear();
    this.pairAdjustments.clear();
  }
}
