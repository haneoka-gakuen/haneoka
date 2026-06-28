import { windows } from '../../../../../../../../../shared/src/engine/data/windows.js'
import { buckets } from '../../../../../buckets.js'
import { effect } from '../../../../../effect.js'
import { particle } from '../../../../../particle.js'
import { skin } from '../../../../../skin.js'
import { archetypes } from '../../../../index.js'
import { TraceFlickNote } from './TraceFlickNote.js'

export class CriticalTraceFlickNote extends TraceFlickNote {
    sprites = {
        left: skin.sprites.criticalTraceNoteLeft,
        middle: skin.sprites.criticalTraceNoteMiddle,
        right: skin.sprites.criticalTraceNoteRight,
        diamond: skin.sprites.criticalTraceNoteDiamond,
        fallback: skin.sprites.criticalTraceNoteFallback,
    }

    clips = {
        perfect: effect.clips.criticalFlick,
        fallback: effect.clips.flickPerfect,
    }

    effects = {
        circular: particle.effects.flickNoteCircular,
        linear: particle.effects.flickNoteLinear,
    }

    arrowSprites = {
        up: [
            skin.sprites.criticalArrowUp1,
            skin.sprites.criticalArrowUp2,
            skin.sprites.criticalArrowUp3,
            skin.sprites.criticalArrowUp4,
            skin.sprites.criticalArrowUp5,
            skin.sprites.criticalArrowUp6,
            skin.sprites.criticalArrowUp7,
            skin.sprites.criticalArrowUp8,
        ],
        left: [
            skin.sprites.criticalArrowLeft1,
            skin.sprites.criticalArrowLeft2,
            skin.sprites.criticalArrowLeft3,
            skin.sprites.criticalArrowLeft4,
            skin.sprites.criticalArrowLeft5,
            skin.sprites.criticalArrowLeft6,
            skin.sprites.criticalArrowLeft7,
            skin.sprites.criticalArrowLeft8,
        ],
        right: [
            skin.sprites.criticalArrowRight1,
            skin.sprites.criticalArrowRight2,
            skin.sprites.criticalArrowRight3,
            skin.sprites.criticalArrowRight4,
            skin.sprites.criticalArrowRight5,
            skin.sprites.criticalArrowRight6,
            skin.sprites.criticalArrowRight7,
            skin.sprites.criticalArrowRight8,
        ],
        fallback: skin.sprites.criticalArrowFallback,
    }

    directionalEffect = particle.effects.flickNoteDirectional

    windows = windows.traceFlickNote.critical

    bucket = buckets.criticalTraceFlickNote

    get slotEffect() {
        return archetypes.CriticalSlotEffect
    }

    get slotGlowEffect() {
        return archetypes.CriticalSlotGlowEffect
    }
}
