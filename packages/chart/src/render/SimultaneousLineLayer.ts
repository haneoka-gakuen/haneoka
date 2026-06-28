import { DoubleSide, Group, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry } from "three";
import { OUR_NOTES_LIVE_GEOMETRY } from "../assets/manifest";
import type { RenderSimultaneousLine } from "./types";
import { StageProjector } from "./stageGeometry";

interface SimultaneousLineVisual {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  lastSeen: number;
}

/** Pooled rendering of LivePairNoteLineView's fixed-height sliced sprite. */
export class SimultaneousLineLayer {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
  });
  private readonly visuals = new Map<RenderSimultaneousLine["id"], SimultaneousLineVisual>();
  private readonly pool: SimultaneousLineVisual[] = [];
  private epoch = 0;

  constructor(projector: StageProjector) {
    this.projector = projector;
    // The pair line is a single flat plane, so one unculled pass preserves its
    // pixels while avoiding Three's transparent DoubleSide back/front draws.
    this.material.forceSinglePass = true;
    this.group.name = "OurNotesSimultaneousLines";
  }

  update(lines: ReadonlyArray<RenderSimultaneousLine> | undefined): void {
    const epoch = ++this.epoch;
    for (const line of lines ?? []) {
      if (line.visible === false || line.rightCenter <= line.leftCenter) continue;
      let visual = this.visuals.get(line.id);
      if (!visual) {
        visual = this.pool.pop() ?? this.createVisual();
        this.visuals.set(line.id, visual);
        this.group.add(visual.mesh);
      }
      visual.lastSeen = epoch;

      const viewProgress = this.projector.viewProgress(line.approach);
      const left = this.projector.laneEdgeToXAtViewProgress(line.leftCenter, viewProgress);
      const right = this.projector.laneEdgeToXAtViewProgress(line.rightCenter, viewProgress);
      visual.mesh.position.set((left + right) / 2, this.projector.yAtViewProgress(viewProgress), 0);
      // SetProgress scales only SpriteRenderer.size.x. The serialized 0.025
      // Unity-unit Y size remains fixed at every approach position.
      visual.mesh.scale.set(right - left, OUR_NOTES_LIVE_GEOMETRY.simultaneousLineSize[1], 1);
      visual.mesh.visible = true;
    }

    for (const [id, visual] of this.visuals) {
      if (visual.lastSeen === epoch) continue;
      this.visuals.delete(id);
      this.group.remove(visual.mesh);
      visual.mesh.visible = false;
      this.pool.push(visual);
    }
  }

  private createVisual(): SimultaneousLineVisual {
    const mesh = new Mesh(this.geometry, this.material);
    mesh.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.simultaneousLine;
    mesh.frustumCulled = false;
    return { mesh, lastSeen: 0 };
  }

  dispose(): void {
    this.visuals.clear();
    this.pool.length = 0;
    this.group.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
