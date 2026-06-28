import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
} from "three";
import { SpriteAtlas } from "../assets/SpriteAtlas";
import { OUR_NOTES_LIVE_GEOMETRY, type OurNotesAssetManifest } from "../assets/manifest";
import {
  layoutNoteSkinArrow,
  layoutNoteSkinBody,
  layoutNoteSkinDecoration,
  noteSkinArrowName,
  noteSkinDecorationName,
  noteSkinEffectiveDirection,
  noteSkinSpriteBounds,
  noteSkinTightHorizontalSlices,
  selectNoteSkinParts,
  type NoteSkinParts,
  type NoteSkinSpriteBounds,
} from "./noteSkinLayout";
import type { RenderNote, RenderNoteKind } from "./types";
import { StageProjector } from "./stageGeometry";

interface NoteVisual {
  root: Group;
  signature: string;
  materials: MeshBasicMaterial[];
  /** Merged body: left edge + three sliced strips + right edge in one mesh. */
  body: Mesh<BufferGeometry, MeshBasicMaterial>;
  bodyPositions: BufferAttribute;
  decoration?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  arrow?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  parts: NoteSkinParts;
  decorationName?: string;
  arrowName?: string;
  lastSeen: number;
  layoutWidth: number;
  layoutScale: number;
  lastAlpha: number;
}

/** Left, main-left border, main-middle, main-right border, right. */
const BODY_QUADS = 5;

interface NoteDescriptor {
  kind: RenderNoteKind;
  lane: number;
  width: number;
  direction: RenderNote["direction"];
  parts: NoteSkinParts;
  signature: string;
  decorationName?: string;
  arrowName?: string;
}

/** Sprite-atlas note renderer backed only by skin001 and native view rules. */
export class NoteLayer {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly visuals = new Map<RenderNote["id"], NoteVisual>();
  private readonly pools = new Map<string, NoteVisual[]>();
  private readonly descriptors = new Map<RenderNote["id"], NoteDescriptor>();
  private readonly bounds = new Map<string, NoteSkinSpriteBounds>();
  private atlas?: SpriteAtlas;
  private updateEpoch = 0;
  private visualAllocations = 0;
  private visualReuses = 0;
  private visualReleases = 0;
  private meshAllocations = 0;

  constructor(projector: StageProjector, assets: OurNotesAssetManifest) {
    this.projector = projector;
    this.assets = assets;
    this.group.name = "OurNotesNotes";
  }

  setAtlas(atlas: SpriteAtlas | undefined): void {
    this.destroyVisuals();
    this.descriptors.clear();
    this.bounds.clear();
    this.atlas = atlas;
  }

  update(notes: ReadonlyArray<RenderNote> | undefined): void {
    const epoch = ++this.updateEpoch;
    let drawOrdinal = 0;
    for (const note of notes ?? []) {
      if (note.visible === false) continue;
      const descriptor = this.descriptor(note);
      let visual = this.visuals.get(note.id);
      if (!visual || visual.signature !== descriptor.signature) {
        if (visual) this.releaseVisual(note.id, visual);
        visual = this.acquireVisual(note, descriptor);
        this.visuals.set(note.id, visual);
        this.group.add(visual.root);
      }
      visual.lastSeen = epoch;
      this.setSortOrder(visual, drawOrdinal++);
      this.layout(visual, note);
    }
    for (const [id, visual] of this.visuals) {
      if (visual.lastSeen !== epoch) this.releaseVisual(id, visual);
    }
  }

  private setSortOrder(visual: NoteVisual, ordinal: number): void {
    // The old allocate/dispose path used Object3D.id as Three's final stable
    // transparent-sort tie breaker. Pool reuse changes those ids, so retain
    // the same frame-note order explicitly with a sub-order far below the
    // next native sorting-order integer.
    const tieBreaker = ordinal * 0.000001;
    const noteOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.note + tieBreaker;
    if (visual.body.renderOrder !== noteOrder) {
      visual.body.renderOrder = noteOrder;
      if (visual.arrow) visual.arrow.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteArrow + tieBreaker;
      if (visual.decoration) {
        visual.decoration.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteDecoration + tieBreaker;
      }
    }
  }

  private descriptor(note: RenderNote): NoteDescriptor {
    const cached = this.descriptors.get(note.id);
    if (
      cached &&
      cached.kind === note.kind &&
      cached.lane === note.lane &&
      cached.width === note.width &&
      cached.direction === note.direction
    ) {
      return cached;
    }
    const parts = selectNoteSkinParts(note, this.assets.tiltThresholds);
    const arrowName = noteSkinArrowName(note);
    const decorationName = noteSkinDecorationName(note.kind);
    const descriptor: NoteDescriptor = {
      kind: note.kind,
      lane: note.lane,
      width: note.width,
      direction: note.direction,
      parts,
      signature: `${note.kind}:${parts.left.spriteName}:${parts.left.flipX ? 1 : 0}:${parts.right.spriteName}:${parts.right.flipX ? 1 : 0}:${arrowName ?? ""}:${decorationName ?? ""}`,
      decorationName,
      arrowName,
    };
    this.descriptors.set(note.id, descriptor);
    return descriptor;
  }

  private acquireVisual(note: RenderNote, descriptor: NoteDescriptor): NoteVisual {
    const pool = this.pools.get(descriptor.signature);
    const pooled = pool?.pop();
    if (pooled) {
      this.visualReuses += 1;
      pooled.root.name = `RenderNote:${String(note.id)}`;
      pooled.root.visible = true;
      return pooled;
    }
    const visual = this.createVisual(note, descriptor);
    this.visualAllocations += 1;
    this.meshAllocations += visual.materials.length;
    return visual;
  }

  private createVisual(note: RenderNote, descriptor: NoteDescriptor): NoteVisual {
    const { parts, signature, decorationName, arrowName } = descriptor;
    const root = new Group();
    root.name = `RenderNote:${String(note.id)}`;
    const materials: MeshBasicMaterial[] = [];

    // The five body quads (left edge, three sliced strips, right edge) share
    // one geometry and one material over the raw atlas, with each quad's UV
    // baked to its own atlas region. That collapses what used to be five
    // meshes/materials (five draw calls) into one. Positions are filled by
    // layout(); UVs and the index are fixed for the visual's lifetime.
    const bodyGeometry = new BufferGeometry();
    const bodyPositions = new BufferAttribute(new Float32Array(BODY_QUADS * 4 * 3), 3);
    bodyPositions.setUsage(DynamicDrawUsage);
    const bodyUv = new BufferAttribute(new Float32Array(BODY_QUADS * 4 * 2), 2);
    const bodyIndex = new Uint16Array(BODY_QUADS * 6);
    for (let quad = 0; quad < BODY_QUADS; quad += 1) {
      const base = quad * 4;
      const offset = quad * 6;
      bodyIndex[offset] = base;
      bodyIndex[offset + 1] = base + 1;
      bodyIndex[offset + 2] = base + 2;
      bodyIndex[offset + 3] = base;
      bodyIndex[offset + 4] = base + 2;
      bodyIndex[offset + 5] = base + 3;
    }
    const mainRegion = this.atlas?.region(parts.mainSpriteName);
    const mainSlices = mainRegion ? noteSkinTightHorizontalSlices(mainRegion) : undefined;
    const bodyUvTransforms = [
      this.atlas?.regionUvTransform(parts.left.spriteName),
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[0]) : undefined,
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[1]) : undefined,
      mainSlices ? this.atlas?.regionUvTransform(parts.mainSpriteName, mainSlices[2]) : undefined,
      this.atlas?.regionUvTransform(parts.right.spriteName),
    ];
    const uvArray = bodyUv.array as Float32Array;
    for (let quad = 0; quad < BODY_QUADS; quad += 1) {
      NoteLayer.bakeQuadUv(uvArray, quad * 8, bodyUvTransforms[quad]);
    }
    bodyUv.needsUpdate = true;
    bodyGeometry.setAttribute("position", bodyPositions);
    bodyGeometry.setAttribute("uv", bodyUv);
    bodyGeometry.setIndex(new BufferAttribute(bodyIndex, 1));

    const bodyMaterial = this.bodyMaterial();
    materials.push(bodyMaterial);
    const body = new Mesh(bodyGeometry, bodyMaterial);
    // A missing endpoint or main slice must not turn into the full atlas via
    // identity UVs. Keep the note closed until every native body part exists.
    body.visible = bodyUvTransforms.every(Boolean);
    // Positions are rewritten by layout(); disable culling so a stale bounding
    // sphere never hides the note. Active notes are always in the view window.
    body.frustumCulled = false;
    body.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.note;
    root.add(body);

    let decoration: NoteVisual["decoration"];
    if (decorationName) {
      const material = this.material(decorationName);
      materials.push(material);
      decoration = new Mesh(this.plane, material);
      decoration.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteDecoration;
      root.add(decoration);
    }

    let arrow: NoteVisual["arrow"];
    if (arrowName) {
      const material = this.material(arrowName);
      materials.push(material);
      arrow = new Mesh(this.plane, material);
      arrow.name = "flick-arrow";
      arrow.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.noteArrow;
      root.add(arrow);
    }

    return {
      root,
      signature,
      materials,
      body,
      bodyPositions,
      decoration,
      arrow,
      parts,
      decorationName,
      arrowName,
      lastSeen: 0,
      layoutWidth: Number.NaN,
      layoutScale: Number.NaN,
      lastAlpha: Number.NaN,
    };
  }

  /** One shared material over the raw atlas; regions are selected by baked UVs. */
  private bodyMaterial(): MeshBasicMaterial {
    if (this.atlas) {
      const material = new MeshBasicMaterial({
        map: this.atlas.texture,
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: NormalBlending,
        side: DoubleSide,
        toneMapped: false,
      });
      material.forceSinglePass = true;
      return material;
    }
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    return material;
  }

  /** Write one body quad's four baked UV corners for base uv (0,0)(1,0)(1,1)(0,1). */
  private static bakeQuadUv(
    uv: Float32Array,
    offset: number,
    transform: { a: number; b: number; c: number; d: number; e: number; f: number } | undefined,
  ): void {
    if (!transform) {
      uv[offset] = 0;
      uv[offset + 1] = 0;
      uv[offset + 2] = 1;
      uv[offset + 3] = 0;
      uv[offset + 4] = 1;
      uv[offset + 5] = 1;
      uv[offset + 6] = 0;
      uv[offset + 7] = 1;
      return;
    }
    const { a, b, c, d, e, f } = transform;
    uv[offset] = e;
    uv[offset + 1] = f;
    uv[offset + 2] = a + e;
    uv[offset + 3] = c + f;
    uv[offset + 4] = a + b + e;
    uv[offset + 5] = c + d + f;
    uv[offset + 6] = b + e;
    uv[offset + 7] = d + f;
  }

  /** Write one body quad's four vertex positions from a center and a size. */
  private static bakeQuadPositions(
    positions: Float32Array,
    offset: number,
    centerX: number,
    centerY: number,
    sizeX: number,
    sizeY: number,
  ): void {
    const halfX = sizeX / 2;
    const halfY = sizeY / 2;
    positions[offset] = centerX - halfX;
    positions[offset + 1] = centerY - halfY;
    positions[offset + 2] = 0;
    positions[offset + 3] = centerX + halfX;
    positions[offset + 4] = centerY - halfY;
    positions[offset + 5] = 0;
    positions[offset + 6] = centerX + halfX;
    positions[offset + 7] = centerY + halfY;
    positions[offset + 8] = 0;
    positions[offset + 9] = centerX - halfX;
    positions[offset + 10] = centerY + halfY;
    positions[offset + 11] = 0;
  }

  private material(spriteName: string): MeshBasicMaterial {
    const atlasMaterial = this.atlas?.createMaterial(spriteName);
    if (atlasMaterial) {
      atlasMaterial.side = DoubleSide;
      atlasMaterial.blending = NormalBlending;
      atlasMaterial.forceSinglePass = true;
      return atlasMaterial;
    }
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    return material;
  }

  private spriteBounds(spriteName: string | undefined): NoteSkinSpriteBounds | undefined {
    if (!spriteName) return undefined;
    const cached = this.bounds.get(spriteName);
    if (cached) return cached;
    const region = this.atlas?.region(spriteName);
    if (!region) return undefined;
    const bounds = noteSkinSpriteBounds(region);
    this.bounds.set(spriteName, bounds);
    return bounds;
  }

  private layout(visual: NoteVisual, note: RenderNote): void {
    const scale = Math.max(0.05, note.scale ?? 1);
    if (visual.layoutWidth !== note.width || visual.layoutScale !== scale) {
      const viewWidth = this.projector.widthToWorld(note.width) * scale;
      const leftBounds = this.spriteBounds(visual.parts.left.spriteName);
      const rightBounds = this.spriteBounds(visual.parts.right.spriteName);
      const mainBounds = this.spriteBounds(visual.parts.mainSpriteName);
      const mainRegion = this.atlas?.region(visual.parts.mainSpriteName);
      const bodyLayout =
        leftBounds && rightBounds && mainBounds && mainRegion
          ? layoutNoteSkinBody({
              parts: visual.parts,
              leftBounds,
              rightBounds,
              mainBounds,
              mainRegion,
              viewWidth,
              scale,
            })
          : undefined;
      if (!bodyLayout) {
        visual.body.visible = false;
      } else if (visual.body.visible) {
        const positions = visual.bodyPositions.array as Float32Array;
        const quads = [
          bodyLayout.left,
          bodyLayout.mainLeft,
          bodyLayout.mainMiddle,
          bodyLayout.mainRight,
          bodyLayout.right,
        ];
        quads.forEach((quad, index) => {
          NoteLayer.bakeQuadPositions(positions, index * 12, quad.centerX, quad.centerY, quad.width, quad.height);
        });
        visual.bodyPositions.needsUpdate = true;
      }

      if (visual.decoration) {
        const bounds = this.spriteBounds(visual.decorationName);
        visual.decoration.visible = Boolean(bounds);
        if (bounds) {
          const layout = layoutNoteSkinDecoration(bounds, scale);
          visual.decoration.scale.set(layout.width, layout.height, 1);
          visual.decoration.position.set(layout.centerX, layout.centerY, 0);
        }
      }
      if (visual.arrow) {
        const bounds = this.spriteBounds(visual.arrowName);
        visual.arrow.visible = Boolean(bounds && visual.arrowName);
        if (bounds && visual.arrowName) {
          const layout = layoutNoteSkinArrow(visual.arrowName, noteSkinEffectiveDirection(note), bounds, scale);
          visual.arrow.scale.set(layout.width, layout.height, 1);
          visual.arrow.rotation.z = layout.rotation;
          visual.arrow.position.set(layout.centerX, layout.centerY, 0);
        }
      }
      visual.layoutWidth = note.width;
      visual.layoutScale = scale;
    }

    const alpha = Math.max(0, Math.min(1, note.alpha ?? 1));
    if (visual.lastAlpha !== alpha) {
      for (const material of visual.materials) material.opacity = alpha;
      visual.lastAlpha = alpha;
    }
    // LiveNoteViewBase.UpdateView multiplies every component of Vector3.one by
    // the converted view progress before Transform.set_localScale. Width is
    // already authored at judgement size.
    const viewProgress = this.projector.viewProgress(note.approach);
    visual.root.scale.setScalar(viewProgress);
    this.projector.pointAtViewProgress(note.lane, note.width, viewProgress, 0, visual.root.position);
    visual.root.visible = alpha > 0.001 && visual.body.visible;
  }

  private releaseVisual(id: RenderNote["id"], visual: NoteVisual): void {
    this.group.remove(visual.root);
    visual.root.visible = false;
    this.visuals.delete(id);
    const pool = this.pools.get(visual.signature);
    if (pool) pool.push(visual);
    else this.pools.set(visual.signature, [visual]);
    this.visualReleases += 1;
  }

  private disposeVisual(visual: NoteVisual): void {
    visual.body.geometry.dispose();
    for (const material of visual.materials) {
      if (material.map && this.atlas) this.atlas.releaseMaterial(material);
      else material.dispose();
    }
  }

  private destroyVisuals(): void {
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const pool of this.pools.values()) {
      for (const visual of pool) this.disposeVisual(visual);
    }
    this.pools.clear();
    this.group.clear();
  }

  get stats(): {
    activeVisuals: number;
    pooledVisuals: number;
    visualAllocations: number;
    visualReuses: number;
    visualReleases: number;
    meshAllocations: number;
    cachedDescriptors: number;
    cachedBounds: number;
  } {
    let pooledVisuals = 0;
    for (const pool of this.pools.values()) pooledVisuals += pool.length;
    return {
      activeVisuals: this.visuals.size,
      pooledVisuals,
      visualAllocations: this.visualAllocations,
      visualReuses: this.visualReuses,
      visualReleases: this.visualReleases,
      meshAllocations: this.meshAllocations,
      cachedDescriptors: this.descriptors.size,
      cachedBounds: this.bounds.size,
    };
  }

  dispose(): void {
    this.destroyVisuals();
    this.descriptors.clear();
    this.bounds.clear();
    this.plane.dispose();
  }
}
