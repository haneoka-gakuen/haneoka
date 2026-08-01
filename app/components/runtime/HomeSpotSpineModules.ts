import type { HaneokaHomeSpotRuntimeModules } from "@haneoka/vega-plugin-haneoka";

let runtimeModules: Promise<HaneokaHomeSpotRuntimeModules> | undefined;

/**
 * The Haneoka application owns and provisions the concrete rendering modules.
 * The public plugin receives only these constructors and never distributes an
 * Esoteric Software runtime.
 */
export const loadHomeSpotSpineModules = (): Promise<HaneokaHomeSpotRuntimeModules> => {
  runtimeModules ??= Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("@esotericsoftware/spine-threejs"),
  ]).then(([three, { GLTFLoader }, spine]) => ({
    three,
    GLTFLoader,
    spine: {
      AssetManager: spine.AssetManager,
      AtlasAttachmentLoader: spine.AtlasAttachmentLoader,
      SkeletonBinary: spine.SkeletonBinary,
      SkeletonJson: spine.SkeletonJson,
      SkeletonMesh: spine.SkeletonMesh,
    },
  }));
  return runtimeModules;
};
