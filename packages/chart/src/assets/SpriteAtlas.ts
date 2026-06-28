import { ClampToEdgeWrapping, LinearFilter, Matrix3, MeshBasicMaterial, SRGBColorSpace, TextureLoader } from "three";
import type { Texture } from "three";
import type { SpriteAtlasManifest, SpriteMetadataRef } from "./manifest";

export interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteRegion {
  name: string;
  rect: SpriteRect;
  sourceSize: { width: number; height: number };
  offset: { x: number; y: number };
  pivot: { x: number; y: number };
  border: { left: number; bottom: number; right: number; top: number };
  pixelsToUnits: number;
  /** Unity SpritePackingRotation value read from SpriteAtlas.settingsRaw. */
  packingRotation: 0 | 1 | 2 | 3 | 4;
}

interface UnitySpriteAsset {
  data?: {
    m_Name?: string;
    m_Rect?: Partial<SpriteRect>;
    m_Offset?: { x?: number; y?: number };
    m_Pivot?: { x?: number; y?: number };
    m_Border?: { x?: number; y?: number; z?: number; w?: number };
    m_PixelsToUnits?: number;
    m_RenderDataKey?: unknown;
  };
}

interface UnityAtlasRenderData {
  textureRect?: Partial<SpriteRect>;
  textureRectOffset?: { x?: number; y?: number };
  settingsRaw?: number;
}

interface UnityAtlasAsset {
  data?: {
    m_RenderDataMap?: Array<[unknown, UnityAtlasRenderData]>;
  };
}

export interface SpriteAtlasLoadOptions {
  fetchImpl?: typeof fetch;
  textureLoader?: TextureLoader;
  /** Throw if even one Sprite metadata file is unavailable. Default: false. */
  strict?: boolean;
}

export interface SpriteSlice {
  /** Normalized coordinates in the source sprite. */
  x: number;
  y: number;
  width: number;
  height: number;
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRect(value: Partial<SpriteRect> | undefined): SpriteRect {
  return {
    x: finite(value?.x),
    y: finite(value?.y),
    width: Math.max(0, finite(value?.width)),
    height: Math.max(0, finite(value?.height)),
  };
}

function stableRenderKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRenderKey).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableRenderKey(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function textureSize(texture: Texture): { width: number; height: number } {
  const image = texture.image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  } | null;
  return {
    width: Math.max(1, finite(image?.naturalWidth ?? image?.width, 1)),
    height: Math.max(1, finite(image?.naturalHeight ?? image?.height, 1)),
  };
}

function packingRotation(settingsRaw: unknown): 0 | 1 | 2 | 3 | 4 {
  const rotation = (finite(settingsRaw) >> 2) & 0xf;
  return rotation >= 0 && rotation <= 4 ? (rotation as 0 | 1 | 2 | 3 | 4) : 0;
}

/**
 * Resolves Unity SpriteAtlas entries by joining each Sprite.m_RenderDataKey to
 * SpriteAtlas.m_RenderDataMap. Reading `Sprite.m_Rect` alone is incorrect for
 * packed sprites because it is local to the source sprite.
 */
export class SpriteAtlas {
  readonly manifest: SpriteAtlasManifest;
  readonly texture: Texture;
  readonly missingSprites: ReadonlyArray<string>;

  private readonly regions = new Map<string, SpriteRegion>();
  /**
   * Cropped atlas views are immutable after construction and therefore safe
   * to share across materials.  A note visual still owns its material (and
   * opacity), while these views are owned by the atlas itself.
   */
  private readonly derivedTextures = new Map<string, Texture>();

  private constructor(
    manifest: SpriteAtlasManifest,
    texture: Texture,
    regions: Map<string, SpriteRegion>,
    missingSprites: string[],
  ) {
    this.manifest = manifest;
    this.texture = texture;
    this.regions = regions;
    this.missingSprites = missingSprites;
  }

  static async load(manifest: SpriteAtlasManifest, options: SpriteAtlasLoadOptions = {}): Promise<SpriteAtlas> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const textureLoader = options.textureLoader ?? new TextureLoader();
    const [texture, atlasAsset] = await Promise.all([
      textureLoader.loadAsync(manifest.textureUrl),
      fetchJson<UnityAtlasAsset>(fetchImpl, manifest.atlasMetadataUrl),
    ]);

    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // LinearFilter never samples mip levels. Avoid generating and retaining an
    // unused pyramid for the (shared) full-size note atlas.
    texture.generateMipmaps = false;

    const renderData = new Map<string, UnityAtlasRenderData>();
    for (const entry of atlasAsset.data?.m_RenderDataMap ?? []) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      renderData.set(stableRenderKey(entry[0]), entry[1]);
    }

    const regions = new Map<string, SpriteRegion>();
    const missing: string[] = [];
    const results = await Promise.allSettled(
      manifest.sprites.map(async (ref) => ({
        ref,
        asset: await fetchJson<UnitySpriteAsset>(fetchImpl, ref.metadataUrl),
      })),
    );

    results.forEach((result, index) => {
      const ref: SpriteMetadataRef = manifest.sprites[index];
      if (result.status === "rejected") {
        missing.push(ref.name);
        return;
      }
      const data = result.value.asset.data;
      const packed = renderData.get(stableRenderKey(data?.m_RenderDataKey));
      const rect = normalizeRect(packed?.textureRect);
      if (!data || rect.width <= 0 || rect.height <= 0) {
        missing.push(ref.name);
        return;
      }
      const sourceRect = normalizeRect(data.m_Rect);
      regions.set(ref.name, {
        name: data.m_Name || ref.name,
        rect,
        sourceSize: {
          width: sourceRect.width || rect.width,
          height: sourceRect.height || rect.height,
        },
        offset: {
          x: finite(packed?.textureRectOffset?.x ?? data.m_Offset?.x),
          y: finite(packed?.textureRectOffset?.y ?? data.m_Offset?.y),
        },
        pivot: {
          x: finite(data.m_Pivot?.x, 0.5),
          y: finite(data.m_Pivot?.y, 0.5),
        },
        border: {
          left: finite(data.m_Border?.x),
          bottom: finite(data.m_Border?.y),
          right: finite(data.m_Border?.z),
          top: finite(data.m_Border?.w),
        },
        pixelsToUnits: Math.max(1, finite(data.m_PixelsToUnits, 100)),
        packingRotation: packingRotation(packed?.settingsRaw),
      });
    });

    if (options.strict && missing.length) {
      texture.dispose();
      throw new Error(`SpriteAtlas ${manifest.id}: missing ${missing.length} sprites (${missing.join(", ")})`);
    }

    return new SpriteAtlas(manifest, texture, regions, missing);
  }

  has(name: string): boolean {
    return this.regions.has(name);
  }

  region(name: string): SpriteRegion | undefined {
    return this.regions.get(name);
  }

  private textureView(name: string, slice?: SpriteSlice): Texture | undefined {
    const region = this.regions.get(name);
    if (!region) return undefined;
    const sliceX = Math.max(0, Math.min(1, slice?.x ?? 0));
    const sliceY = Math.max(0, Math.min(1, slice?.y ?? 0));
    const sliceWidth = Math.max(0, Math.min(1 - sliceX, slice?.width ?? 1));
    const sliceHeight = Math.max(0, Math.min(1 - sliceY, slice?.height ?? 1));
    const cacheKey = `${name}:${sliceX}:${sliceY}:${sliceWidth}:${sliceHeight}`;
    const cached = this.derivedTextures.get(cacheKey);
    if (cached) return cached;
    const size = textureSize(this.texture);
    const texture = this.texture.clone();
    texture.image = this.texture.image;
    texture.needsUpdate = true;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    const x = region.rect.x / size.width;
    const y = region.rect.y / size.height;
    const width = region.rect.width / size.width;
    const height = region.rect.height / size.height;
    // Explicit matrix avoids Three's center/rotation ambiguity. Unity raw75
    // directional-right arrows decode to rotation=2 (flip vertical).
    texture.matrixAutoUpdate = false;
    switch (region.packingRotation) {
      case 1: // FlipHorizontal
        texture.matrix.set(-width, 0, x + width, 0, height, y, 0, 0, 1);
        break;
      case 2: // FlipVertical
        texture.matrix.set(width, 0, x, 0, -height, y + height, 0, 0, 1);
        break;
      case 3: // Rotate180
        texture.matrix.set(-width, 0, x + width, 0, -height, y + height, 0, 0, 1);
        break;
      case 4: // UnityPy restores this as ROTATE_270.
        texture.matrix.set(0, -width, x + width, height, 0, y, 0, 0, 1);
        break;
      default:
        texture.matrix.set(width, 0, x, 0, height, y, 0, 0, 1);
        break;
    }
    if (slice) {
      const localSlice = new Matrix3().set(sliceWidth, 0, sliceX, 0, sliceHeight, sliceY, 0, 0, 1);
      texture.matrix.multiply(localSlice);
    }
    texture.colorSpace = SRGBColorSpace;
    this.derivedTextures.set(cacheKey, texture);
    return texture;
  }

  /** Create an immutable cropped texture view shared for the atlas lifetime. */
  createTexture(name: string): Texture | undefined {
    return this.textureView(name);
  }

  /**
   * Affine UV transform (base uv -> atlas uv) for a sprite region, optionally
   * restricted to a normalized slice: `atlasU = a*u + b*v + e`,
   * `atlasV = c*u + d*v + f`. Reading the coefficients from the same cached
   * textureView the materials use lets a caller bake many sprite variants into
   * one geometry (one shared material over the raw atlas) instead of cloning a
   * Texture per variant. Packing rotation, pivot and slice handling are
   * identical to createMaterial.
   */
  regionUvTransform(
    name: string,
    slice?: SpriteSlice,
  ): { a: number; b: number; c: number; d: number; e: number; f: number } | undefined {
    const texture = this.textureView(name, slice);
    if (!texture) return undefined;
    // Matrix3.elements is column-major: [n11,n21,n31, n12,n22,n32, n13,n23,n33].
    // textureView writes set(n11,n12,n13, n21,n22,n23, n31,n32,n33), so the
    // affine coefficients map to elements 0,3,1,4,6,7.
    const el = texture.matrix.elements;
    return { a: el[0]!, b: el[3]!, c: el[1]!, d: el[4]!, e: el[6]!, f: el[7]! };
  }

  createMaterial(name: string, opacity = 1): MeshBasicMaterial | undefined {
    const map = this.createTexture(name);
    if (!map) return undefined;
    return new MeshBasicMaterial({
      map,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
  }

  /** Create a material for a normalized slice of the source sprite. */
  createMaterialSlice(name: string, slice: SpriteSlice, opacity = 1): MeshBasicMaterial | undefined {
    const map = this.textureView(name, slice);
    if (!map) return undefined;
    return new MeshBasicMaterial({
      map,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
  }

  releaseMaterial(material: MeshBasicMaterial): void {
    // The material is per visual because its opacity changes per note.  Its
    // texture view is shared and remains alive until SpriteAtlas.dispose().
    material.dispose();
  }

  get stats(): { cachedTextureViews: number } {
    return { cachedTextureViews: this.derivedTextures.size };
  }

  dispose(): void {
    for (const texture of this.derivedTextures.values()) texture.dispose();
    this.derivedTextures.clear();
    this.texture.dispose();
    this.regions.clear();
  }
}
