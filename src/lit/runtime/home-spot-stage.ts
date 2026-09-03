type Value = Record<string, unknown>;
type Controller = {
  dispose(): void;
  replay(): void;
  pointerMove(x: number, y: number): void;
  pointerLeave(): void;
  selectAt(x: number, y: number): number | undefined;
};

export class HomeSpotStage {
  private controller?: Controller;
  private generation = 0;

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
    const controller = (await createHaneokaThreeSpineHomeSpotScene({
      host: this.host,
      descriptor: { ...descriptor, layers: (descriptor.layers as Value[]).map((layer) => ({ ...layer })) } as never,
      modules: {
        three,
        GLTFLoader,
        spine: {
          AssetManager: spine.AssetManager,
          AtlasAttachmentLoader: spine.AtlasAttachmentLoader,
          SkeletonBinary: spine.SkeletonBinary,
          SkeletonJson: spine.SkeletonJson,
          SkeletonMesh: spine.SkeletonMesh,
        },
      },
      clearColor: "#18202a",
      ariaLabel: "Home story scene",
    })) as Controller;
    if (generation !== this.generation) {
      controller.dispose();
      return;
    }
    this.controller = controller;
  }

  replay() {
    this.controller?.replay();
  }
  pointerMove(x: number, y: number) {
    this.controller?.pointerMove(x, y);
  }
  pointerLeave() {
    this.controller?.pointerLeave();
  }
  selectAt(x: number, y: number) {
    return this.controller?.selectAt(x, y);
  }
  dispose() {
    this.generation += 1;
    this.controller?.dispose();
    this.controller = undefined;
    this.host.replaceChildren();
  }
}
