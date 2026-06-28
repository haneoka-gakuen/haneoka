/**
 * Camera and lane measurements validated against the reference runtime data.
 * The precomputed trigonometric values keep the Sonolus runtime free from an
 * avoidable per-frame sin/cos evaluation while retaining the source camera
 * values alongside them.
 */
export const nativeStage = {
    targetAspectRatio: 16 / 9,

    cameraHeight: 10,
    cameraPitchDegrees: 29.60445665468814,
    cameraPitchSin: 0.49400949727308147,
    cameraPitchCos: 0.8694565064475608,
    verticalFovDegrees: 54,
    tanHalfVerticalFov: 0.5095254494944288,

    laneWidth: 19.12000084,
    laneLength: 217.6000061,
    judgmentZ: 9.62,
    // LiveLaneLineView derives this from out_side_line's 16 px width / 100.
    outsideLineWidth: 0.16,

    tapAreaWidth: 19.6,
    tapAreaLength: 1.7,
    tapAreaBorder: 0.46,

    judgmentLineWidth: 19.2,
    judgmentLineLength: 0.06,
}

// Every selected LiveLaneEffectView ParticleSystem serializes
// startLifetime=.45 and simulationSpeed=2.
export const nativeLaneEffectLifetime = 0.45 / 2

const judgmentDepth =
    nativeStage.cameraHeight * nativeStage.cameraPitchSin +
    nativeStage.judgmentZ * nativeStage.cameraPitchCos

/** Perspective scale on the ground plane, normalized to 1 at judgmentZ. */
export const projectLaneZ = (z: number) =>
    judgmentDepth /
    (nativeStage.cameraHeight * nativeStage.cameraPitchSin + z * nativeStage.cameraPitchCos)

// These are the Unity camera's horizontal/vertical NDC coordinates at the
// ground-plane vanishing point and judgment root. They are equivalent to:
//   horizonY = tan(pitch) / tan(verticalFov / 2)
//   judgmentY = cameraY(judgmentZ) / cameraDepth(judgmentZ) / tan(verticalFov / 2)
//   judgmentHalfX = (laneWidth / 2) / cameraDepth(judgmentZ)
//                   / tan(verticalFov / 2) / (16 / 9)
const horizonY = 1.115119873136453
const judgmentY = -0.5815420740473228
const judgmentHalfX = 0.7932747292495311

/**
 * Half-height in Sonolus lane coordinates for Unity's camera-facing
 * judgment LineRenderer. Unlike the tap area, this width is measured in the
 * camera plane and therefore must not be projected as a strip on XZ ground.
 */
export const nativeJudgmentLineHalfHeight =
    nativeStage.judgmentLineLength /
    2 /
    judgmentDepth /
    nativeStage.tanHalfVerticalFov /
    (horizonY - judgmentY)

export const getNativeVanishingPointY = (stageHeight: number) => (stageHeight / 2) * horizonY

export const getNativeJudgmentY = (stageHeight: number) => (stageHeight / 2) * judgmentY

export const getNativeLaneUnitWidth = (stageWidth: number) =>
    (stageWidth / 2) * (judgmentHalfX / 6)

export const lane = {
    // Camera-depth projection of the native spawn root (z = laneLength).
    t: 0.06853141540619755,
    // The native lane-base texture continues below the judgment root. Keep its
    // authored lower extent while the visible ground projection is corrected.
    b: 1176 / 850,
}

// lane_base is a 2048 x 1644 screen-space sprite authored for a 1920 x 1080
// canvas, centered at (960, 540 - 247). These local coordinates are the exact
// inverse of the native camera-derived skin transform, so the precomposed
// perspective in the texture keeps its authored screen bounds
// (-64..1984, -35..1609) on the 1920 x 1080 reference viewport.
export const laneBase = {
    layout: {
        l: -8.067822866429452,
        r: 8.067822866429452,
        t: 0.029649429224918766,
        b: 1.8240224624020942,
    },
    materialOpacity: 0.749019623,
}
