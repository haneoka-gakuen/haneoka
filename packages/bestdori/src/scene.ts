import { DEFAULT_SCENE_GEOMETRY, scenePlaneSize, scenePointFromNdc } from "@haneoka/vega-protocol/coordinates";

/** Pure scene geometry used by the scenario adapter. */

export interface BestdoriSceneVector3 {
  x: number;
  y: number;
  z: number;
}

export interface BestdoriPerspectiveScene {
  aspect: number;
  fovYDegrees: number;
  cameraPosition: BestdoriSceneVector3;
  characterPlaneZ: number;
  backgroundPlaneZ: number;
  characterCenterNdcY: number;
  characterCanvasScale: number;
  backgroundOverscan: number;
}

export interface BestdoriStageRuntime {
  minX: number;
  maxX: number;
  width: number;
  backgroundSize: { width: number; height: number };
  positions: Record<number, BestdoriSceneVector3>;
  focusAnchors: Record<number, BestdoriSceneVector3>;
  initialCameraPosition: BestdoriSceneVector3;
  initialCameraRotation: BestdoriSceneVector3;
  characterFieldPosition: BestdoriSceneVector3;
  backgroundFieldPosition: BestdoriSceneVector3;
  characterFieldScale: number;
  backgroundFieldScale: number;
  backgroundFit: "authored" | "camera-width";
  backgroundOverscan: number;
  fov: number;
}

export interface BestdoriSceneRuntime {
  /** The published player reveals dialogue at a fixed 15 UTF-16 code units per second. */
  waitTalkTextUnitTime: number;
  minTalkDisplayTime: number;
  waitAfterVoiceTime: number;
  layout: {
    designViewportAspect: number;
    portraitTargetAspect: number;
    landscapeTargetAspect: number;
  };
  stage: BestdoriStageRuntime;
  stages: Record<string, BestdoriStageRuntime>;
}

export const BESTDORI_BACKGROUND_STAGE_REF = "bestdori:background:4x3";
export const BESTDORI_CARD_STILL_STAGE_REF = "bestdori:background:1334x1002";

export const bestdoriBackgroundStageRef = (aspectRatio: number): string =>
  Math.abs(aspectRatio - 1334 / 1002) < 0.000001 ? BESTDORI_CARD_STILL_STAGE_REF : BESTDORI_BACKGROUND_STAGE_REF;

/** Fixed calibration for imported model positions and canvas proportions. */
export const BESTDORI_PERSPECTIVE_SCENE: Readonly<BestdoriPerspectiveScene> = Object.freeze({
  aspect: 16 / 9,
  fovYDegrees: DEFAULT_SCENE_GEOMETRY.fov,
  cameraPosition: Object.freeze({ x: 0, y: 0, z: 0 }),
  characterPlaneZ: DEFAULT_SCENE_GEOMETRY.characterFieldPosition.z,
  backgroundPlaneZ: DEFAULT_SCENE_GEOMETRY.backgroundFieldPosition.z,
  characterCenterNdcY: -0.12,
  characterCanvasScale: 1.25,
  backgroundOverscan: 1.1,
});

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const coordinateReference = (scene: BestdoriPerspectiveScene) => ({
  width: scene.aspect,
  height: 1,
  fov: scene.fovYDegrees,
  position: scene.cameraPosition,
});

const halfHeightAtPlane = (planeZ: number, scene: BestdoriPerspectiveScene): number =>
  scenePlaneSize(coordinateReference(scene), planeZ - scene.cameraPosition.z).height / 2;

export const bestdoriNdcToWorld = (
  ndcX: number,
  ndcY: number,
  planeZ = BESTDORI_PERSPECTIVE_SCENE.characterPlaneZ,
  scene: BestdoriPerspectiveScene = BESTDORI_PERSPECTIVE_SCENE,
): BestdoriSceneVector3 =>
  scenePointFromNdc(coordinateReference(scene), finite(ndcX), finite(ndcY), planeZ - scene.cameraPosition.z);

/** Exact `sideToX` mapping from the published story viewer. */
export const bestdoriSideNdcX = (side?: number, offsetX?: number): number => {
  const base: Record<number, number> = {
    0: 0,
    1: -0.34,
    2: -1.2,
    3: -0.34,
    4: 0,
    5: 0.34,
    6: 1.2,
    7: 0.34,
    8: -0.34,
    9: -0.34,
    10: 0,
    11: 0.34,
    12: 0.34,
  };
  return (base[side ?? 4] ?? 0) + finite(offsetX) / 640;
};

export const bestdoriCharacterWorldPosition = (
  side?: number,
  offsetX?: number,
  scene: BestdoriPerspectiveScene = BESTDORI_PERSPECTIVE_SCENE,
): BestdoriSceneVector3 =>
  bestdoriNdcToWorld(bestdoriSideNdcX(side, offsetX), scene.characterCenterNdcY, scene.characterPlaneZ, scene);

export const bestdoriPositionTypeFromSide = (side?: number): number => {
  const map: Record<number, number> = {
    1: 1,
    2: 1,
    3: 3,
    4: 5,
    5: 9,
    6: 9,
    7: 7,
    8: 1,
    9: 3,
    10: 5,
    11: 9,
    12: 7,
  };
  return map[side ?? 4] ?? 5;
};

/** Retain the scene basis while applying source-specific background framing. */
export const createBestdoriSceneRuntime = (
  scene: BestdoriPerspectiveScene = BESTDORI_PERSPECTIVE_SCENE,
): BestdoriSceneRuntime => {
  const backgroundHalfHeight = halfHeightAtPlane(scene.backgroundPlaneZ, scene);
  const backgroundWidth = 2 * backgroundHalfHeight * scene.aspect * scene.backgroundOverscan;
  const backgroundHeight = backgroundWidth / scene.aspect;
  const characterFieldPosition = { ...DEFAULT_SCENE_GEOMETRY.characterFieldPosition, z: scene.characterPlaneZ };
  const focusAnchors = Object.fromEntries(
    Object.entries(DEFAULT_SCENE_GEOMETRY.focusAnchors).map(([key, point]) => [key, { ...point }]),
  );
  const positions = Object.fromEntries(
    Object.entries(DEFAULT_SCENE_GEOMETRY.positions).map(([key, point]) => [key, { ...point }]),
  );
  const minX = positions[1]!.x;
  const maxX = positions[9]!.x;
  const stage: BestdoriStageRuntime = {
    minX,
    maxX,
    width: maxX - minX,
    backgroundSize: { width: backgroundWidth, height: backgroundHeight },
    positions,
    focusAnchors,
    initialCameraPosition: { ...scene.cameraPosition },
    initialCameraRotation: { x: 0, y: 0, z: 0 },
    characterFieldPosition,
    backgroundFieldPosition: { x: 0, y: 0, z: scene.backgroundPlaneZ },
    characterFieldScale: DEFAULT_SCENE_GEOMETRY.characterFieldScale,
    backgroundFieldScale: 1,
    backgroundFit: "camera-width",
    backgroundOverscan: scene.backgroundOverscan,
    fov: scene.fovYDegrees,
  };
  const stageWithAspect = (aspectRatio: number): BestdoriStageRuntime => ({
    ...stage,
    backgroundSize: { width: backgroundWidth, height: backgroundWidth / aspectRatio },
    positions: { ...positions },
    focusAnchors: { ...focusAnchors },
    initialCameraPosition: { ...stage.initialCameraPosition },
    initialCameraRotation: { ...stage.initialCameraRotation },
    characterFieldPosition: { ...stage.characterFieldPosition },
    backgroundFieldPosition: { ...stage.backgroundFieldPosition },
    backgroundFit: "authored",
  });
  return {
    waitTalkTextUnitTime: 1 / 15,
    minTalkDisplayTime: 0,
    waitAfterVoiceTime: 0,
    layout: {
      designViewportAspect: scene.aspect,
      portraitTargetAspect: scene.aspect,
      landscapeTargetAspect: scene.aspect,
    },
    stage,
    stages: {
      [BESTDORI_BACKGROUND_STAGE_REF]: stageWithAspect(4 / 3),
      [BESTDORI_CARD_STILL_STAGE_REF]: stageWithAspect(1334 / 1002),
    },
  };
};
