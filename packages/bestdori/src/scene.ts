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
  characterCanvasWorldHeight: number;
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

/**
 * The published viewer uses a fixed 16:9 canvas and assigns model `y=-0.12`
 * and `scale=1.25` after loading. Its Cubism 2 matrix maps those values and
 * `sideToX` directly into clip space. The adapter preserves that composition,
 * but unprojects it onto the neutral ADV engine's authored character plane so
 * every model generation and static portrait shares one perspective camera.
 *
 * `fovYDegrees`, `characterPlaneZ`, and `backgroundPlaneZ` are properties of
 * the target ADV scene. They are deliberately not presented as values from
 * the source viewer, which has no perspective camera.
 */
export const BESTDORI_PERSPECTIVE_SCENE: Readonly<BestdoriPerspectiveScene> = Object.freeze({
  aspect: 16 / 9,
  fovYDegrees: 39.6,
  cameraPosition: Object.freeze({ x: 0, y: 0, z: 0 }),
  characterPlaneZ: 5.5,
  backgroundPlaneZ: 16,
  characterCenterNdcY: -0.12,
  characterCanvasScale: 1.25,
  backgroundOverscan: 1.1,
});

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const halfHeightAtPlane = (planeZ: number, scene: BestdoriPerspectiveScene): number => {
  const depth = Math.max(0.001, planeZ - scene.cameraPosition.z);
  return depth * Math.tan((scene.fovYDegrees * Math.PI) / 360);
};

/** Map the source viewer's model-centre NDC point onto a real world plane. */
export const bestdoriNdcToWorld = (
  ndcX: number,
  ndcY: number,
  planeZ = BESTDORI_PERSPECTIVE_SCENE.characterPlaneZ,
  scene: BestdoriPerspectiveScene = BESTDORI_PERSPECTIVE_SCENE,
): BestdoriSceneVector3 => {
  const halfHeight = halfHeightAtPlane(planeZ, scene);
  const halfWidth = halfHeight * scene.aspect;
  return {
    x: scene.cameraPosition.x + finite(ndcX) * halfWidth,
    y: scene.cameraPosition.y + finite(ndcY) * halfHeight,
    z: planeZ,
  };
};

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

/**
 * Runtime values are derived from one perspective frustum. In particular,
 * the legacy canvas height is fixed in world units; later camera movement and
 * zoom therefore behave exactly like ordinary 3D scene changes.
 */
export const createBestdoriSceneRuntime = (
  scene: BestdoriPerspectiveScene = BESTDORI_PERSPECTIVE_SCENE,
): BestdoriSceneRuntime => {
  const characterHalfHeight = halfHeightAtPlane(scene.characterPlaneZ, scene);
  const backgroundHalfHeight = halfHeightAtPlane(scene.backgroundPlaneZ, scene);
  const characterCanvasWorldHeight = 2 * characterHalfHeight * scene.characterCanvasScale;
  const backgroundWidth = 2 * backgroundHalfHeight * scene.aspect * scene.backgroundOverscan;
  const backgroundHeight = backgroundWidth / scene.aspect;
  const ndcAnchors = [-1.2, -0.77, -0.34, -0.17, 0, 0.17, 0.34, 0.77, 1.2];
  const characterFieldPosition = bestdoriNdcToWorld(0, scene.characterCenterNdcY, scene.characterPlaneZ, scene);
  const focusAnchors: Record<number, BestdoriSceneVector3> = {};
  for (let index = 0; index < ndcAnchors.length; index += 1) {
    const world = bestdoriNdcToWorld(ndcAnchors[index]!, scene.characterCenterNdcY, scene.characterPlaneZ, scene);
    // Stage slots use the same field-local basis as native ADV. The adapter's
    // command positions remain absolute world points and are resolved against
    // this field by the generic renderer.
    focusAnchors[index + 1] = {
      x: world.x - characterFieldPosition.x,
      y: world.y - characterFieldPosition.y,
      z: world.z - characterFieldPosition.z,
    };
  }
  const positions = {
    1: focusAnchors[1]!,
    3: focusAnchors[3]!,
    5: focusAnchors[5]!,
    7: focusAnchors[7]!,
    9: focusAnchors[9]!,
  };
  const minX = positions[1].x;
  const maxX = positions[9].x;
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
    characterFieldScale: 1,
    backgroundFieldScale: 1,
    characterCanvasWorldHeight,
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
