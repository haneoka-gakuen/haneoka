import { options } from '../configuration/options.js'
import { scaledScreen } from './scaledScreen.js'

// Sonolus particles are sprite quads. effect001's custom wall mesh, HDR
// material and sub-emitter graph cannot be represented faithfully, so their
// names are intentionally absent from particle.data and `exists` stays false.
const unsupportedUnityMesh = 'Our Notes Unsupported Unity Wall Mesh'

export const particle = defineParticle({
    effects: {
        laneInVain: 'Our Notes Lane In Vain',
        laneNormal: 'Our Notes Lane Normal',
        laneSlide: 'Our Notes Lane Slide',
        laneFlick: 'Our Notes Lane Flick',
        laneFlickLeft: 'Our Notes Lane Flick Left',
        laneFlickRight: 'Our Notes Lane Flick Right',

        normalNoteCircular: 'Our Notes Native Normal',
        normalNoteGreat: 'Our Notes Native Normal Great',
        normalNoteGood: 'Our Notes Native Normal Good',
        normalNoteBad: 'Our Notes Native Normal Bad',
        normalNoteLinear: unsupportedUnityMesh,

        slideNoteCircular: 'Our Notes Native Slide',
        slideNoteGreat: 'Our Notes Native Slide Great',
        slideNoteGood: 'Our Notes Native Slide Good',
        slideNoteBad: 'Our Notes Native Slide Bad',
        slideNoteLinear: unsupportedUnityMesh,

        flickNoteCircular: 'Our Notes Native Flick',
        flickNoteGreat: 'Our Notes Native Flick Great',
        flickNoteGood: 'Our Notes Native Flick Good',
        flickNoteBad: 'Our Notes Native Flick Bad',
        flickNoteLinear: unsupportedUnityMesh,
        flickNoteDirectional: unsupportedUnityMesh,
        flickLeftWall: 'Our Notes Native Flick Left',
        flickLeftGreat: 'Our Notes Native Flick Left Great',
        flickLeftGood: 'Our Notes Native Flick Left Good',
        flickLeftBad: 'Our Notes Native Flick Left Bad',
        flickLeftSparks: unsupportedUnityMesh,
        flickLeftDirectional: unsupportedUnityMesh,
        flickRightWall: 'Our Notes Native Flick Right',
        flickRightGreat: 'Our Notes Native Flick Right Great',
        flickRightGood: 'Our Notes Native Flick Right Good',
        flickRightBad: 'Our Notes Native Flick Right Bad',
        flickRightSparks: unsupportedUnityMesh,
        flickRightDirectional: unsupportedUnityMesh,

        // Our Notes Critical changes selected judgment windows; it has no
        // PJS-style yellow visual/effect unit. Keep these aliases ordinary.
        criticalNoteCircular: 'Our Notes Native Normal',
        criticalNoteLinear: unsupportedUnityMesh,
        criticalNoteDirectional: unsupportedUnityMesh,

        normalTraceNoteCircular: 'Our Notes Native Connect',
        normalTraceNoteGreat: 'Our Notes Native Connect Great',
        normalTraceNoteGood: 'Our Notes Native Connect Good',
        normalTraceNoteBad: 'Our Notes Native Connect Bad',
        normalTraceNoteLinear: unsupportedUnityMesh,

        criticalTraceNoteCircular: 'Our Notes Native Connect',
        criticalTraceNoteLinear: unsupportedUnityMesh,

        normalSlideTickNote: 'Our Notes Native Connect',

        criticalSlideTickNote: 'Our Notes Native Connect',

        normalSlideConnectorCircular: 'Our Notes Native Slide Loop',
        normalSlideConnectorLinear: unsupportedUnityMesh,

        criticalSlideConnectorCircular: 'Our Notes Native Slide Loop',
        criticalSlideConnectorLinear: unsupportedUnityMesh,
    },
})

export const linearEffectLayout = ({
    lane,
    size,
    shear,
}: {
    lane: number
    size: number
    shear: number
}) => {
    const w = size * options.noteEffectSize
    const h = options.noteEffectSize * scaledScreen.wToH
    const p = 1 + 0.125 * options.noteEffectSize

    const b = 1
    const t = 1 - 2 * h

    shear *= size * options.noteEffectSize

    return {
        x1: lane - w,
        x2: lane * p - w + shear,
        x3: lane * p + w + shear,
        x4: lane + w,
        y1: b,
        y2: t,
        y3: t,
        y4: b,
    }
}
