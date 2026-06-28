import type { SpriteAtlasManifest, SpriteMetadataRef } from "./manifest";
import type { SpriteRect, SpriteRegion } from "./SpriteAtlas";

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
  data?: { m_RenderDataMap?: Array<[unknown, UnityAtlasRenderData]> };
}

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
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

function packingRotation(settingsRaw: unknown): 0 | 1 | 2 | 3 | 4 {
  const rotation = (finite(settingsRaw) >> 2) & 0xf;
  return rotation >= 0 && rotation <= 4 ? (rotation as 0 | 1 | 2 | 3 | 4) : 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load sprite atlas image: ${url}`));
    image.src = url;
  });
}

/** Canvas-only atlas reader shared by 2D chart surfaces; it deliberately has no Three.js dependency. */
export class CanvasSpriteAtlas {
  readonly missingSprites: readonly string[];
  private readonly regions: Map<string, SpriteRegion>;

  private constructor(
    readonly image: HTMLImageElement,
    regions: Map<string, SpriteRegion>,
    missingSprites: string[],
  ) {
    this.regions = regions;
    this.missingSprites = missingSprites;
  }

  static async load(manifest: SpriteAtlasManifest): Promise<CanvasSpriteAtlas> {
    const [image, atlasAsset] = await Promise.all([
      loadImage(manifest.textureUrl),
      fetchJson<UnityAtlasAsset>(manifest.atlasMetadataUrl),
    ]);
    const renderData = new Map<string, UnityAtlasRenderData>();
    for (const entry of atlasAsset.data?.m_RenderDataMap ?? []) {
      if (Array.isArray(entry) && entry.length >= 2) renderData.set(stableRenderKey(entry[0]), entry[1]);
    }

    const regions = new Map<string, SpriteRegion>();
    const missing: string[] = [];
    const results = await Promise.allSettled(
      manifest.sprites.map(async (ref) => ({ ref, asset: await fetchJson<UnitySpriteAsset>(ref.metadataUrl) })),
    );
    results.forEach((result, index) => {
      const ref: SpriteMetadataRef = manifest.sprites[index]!;
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
        pivot: { x: finite(data.m_Pivot?.x, 0.5), y: finite(data.m_Pivot?.y, 0.5) },
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
    return new CanvasSpriteAtlas(image, regions, missing);
  }

  region(name: string): SpriteRegion | undefined {
    return this.regions.get(name);
  }

  dispose(): void {
    this.regions.clear();
  }
}
