// L3 — GEB
// Input: A Home Spot descriptor, its scene host and page pointer events.
// Output: The native scene and a browser recording of its entrance.
// Pos: [Map](L2-2.md); Home Spot runtime owned by the story workspace.
// Effects/Dependencies: Loads the renderer once; exports its existing canvas with pointer tracking locked.
import type { MaterialWithMap } from "@esotericsoftware/spine-threejs";
import type { MaterialParameters } from "three";

type Value = Record<string, unknown>;
type Controller = {
  readonly canvas: HTMLElement;
  dispose(): void;
  replay(): void;
  pointerMove(x: number, y: number): void;
  pointerLeave(): void;
  selectAt(x: number, y: number): number | undefined;
};

export class HomeSpotStage {
  private controller?: Controller;
  private generation = 0;
  private recording?: AbortController;
  private entranceSeconds = 0;

  get ready() {
    return Boolean(this.controller);
  }

  constructor(private readonly host: HTMLElement) {}

  async load(spot: Value) {
    this.dispose();
    const generation = ++this.generation;
    const descriptor = spot.spine as Value | undefined;
    if (
      !descriptor?.supported ||
      !descriptor.atlas ||
      !descriptor.backgroundScene ||
      !Array.isArray(descriptor.backgroundTransform) ||
      !Array.isArray(descriptor.layers) ||
      !descriptor.layers.length
    )
      throw new Error("Home Spine scene is unavailable");

    const [{ createHaneokaThreeSpineHomeSpotScene }, three, { GLTFLoader }, spine] = await Promise.all([
      import("@haneoka/vega-plugin-haneoka"),
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("@esotericsoftware/spine-threejs"),
    ]);
    if (generation !== this.generation) return;
    const meshes: InstanceType<typeof spine.SkeletonMesh>[] = [];
    type SpineMeshArguments = ConstructorParameters<typeof spine.SkeletonMesh>;
    class TrackedSkeletonMesh extends spine.SkeletonMesh {
      constructor(configuration: {
        skeletonData: SpineMeshArguments[0];
        twoColorTint?: boolean;
        materialFactory?: (parameters: MaterialParameters) => MaterialWithMap;
      }) {
        super(configuration);
        meshes.push(this);
      }
    }
    const controller = await createHaneokaThreeSpineHomeSpotScene({
      host: this.host,
      descriptor: { ...descriptor, layers: (descriptor.layers as Value[]).map((layer) => ({ ...layer })) } as never,
      modules: {
        three,
        GLTFLoader,
        spine: {
          TextureAtlas: spine.TextureAtlas,
          ThreeJsTexture: spine.ThreeJsTexture,
          AtlasAttachmentLoader: spine.AtlasAttachmentLoader,
          SkeletonBinary: spine.SkeletonBinary,
          SkeletonJson: spine.SkeletonJson,
          SkeletonMesh: TrackedSkeletonMesh,
        },
      },
      clearColor: "#18202a",
      ariaLabel: "Home story scene",
    });
    if (generation !== this.generation) {
      controller.dispose();
      return;
    }
    this.controller = controller;
    const intro = Number((descriptor.camera as Value | undefined)?.introDuration) || 0;
    const fade = Number(descriptor.fadeInDuration) || 0;
    const animations = meshes.splice(0).map((mesh) => mesh.state.getCurrent(0)?.animation?.duration ?? 0);
    this.entranceSeconds = Math.min(30, Math.max(1, intro, fade, ...animations) + 0.5);
  }

  replay() {
    if (!this.recording) this.controller?.replay();
  }
  pointerMove(x: number, y: number) {
    if (!this.recording) this.controller?.pointerMove(x, y);
  }
  pointerLeave() {
    if (!this.recording) this.controller?.pointerLeave();
  }
  selectAt(x: number, y: number) {
    return this.recording ? undefined : this.controller?.selectAt(x, y);
  }
  async exportVideo() {
    const controller = this.controller;
    if (!controller || this.recording || !(controller.canvas instanceof HTMLCanvasElement))
      throw new Error("Scene recording unavailable");
    const recording = new AbortController();
    this.recording = recording;
    try {
      const { recordHomeSpot } = await import("./home-spot-video");
      return await recordHomeSpot(controller.canvas, this.entranceSeconds, () => controller.replay(), recording.signal);
    } finally {
      if (this.recording === recording) this.recording = undefined;
    }
  }
  cancelRecording() {
    this.recording?.abort();
  }
  dispose() {
    this.cancelRecording();
    this.generation += 1;
    this.controller?.dispose();
    this.controller = undefined;
  }
}
