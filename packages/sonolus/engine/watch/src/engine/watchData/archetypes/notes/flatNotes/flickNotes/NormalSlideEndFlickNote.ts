import { windows } from '../../../../../../../../shared/src/engine/data/windows.js'
import { buckets } from '../../../../buckets.js'
import { effect } from '../../../../effect.js'
import { particle } from '../../../../particle.js'
import { skin } from '../../../../skin.js'
import { archetypes } from '../../../index.js'
import { FlickNote } from './FlickNote.js'

export class NormalSlideEndFlickNote extends FlickNote {
    sprites = {
        left: skin.sprites.flickNoteLeft,
        middle: skin.sprites.flickNoteMiddle,
        right: skin.sprites.flickNoteRight,
        fallback: skin.sprites.flickNoteEndFallback,
    }

    clips = {
        perfect: effect.clips.flickPerfect,
        great: effect.clips.flickGreat,
        good: effect.clips.flickGood,
    }

    effects = {
        circular: particle.effects.flickNoteCircular,
        linear: particle.effects.flickNoteLinear,
    }

    arrowSprites = {
        up: [
            skin.sprites.flickArrowUp1,
            skin.sprites.flickArrowUp2,
            skin.sprites.flickArrowUp3,
            skin.sprites.flickArrowUp4,
            skin.sprites.flickArrowUp5,
            skin.sprites.flickArrowUp6,
            skin.sprites.flickArrowUp7,
            skin.sprites.flickArrowUp8,
        ],
        left: [
            skin.sprites.flickArrowLeft1,
            skin.sprites.flickArrowLeft2,
            skin.sprites.flickArrowLeft3,
            skin.sprites.flickArrowLeft4,
            skin.sprites.flickArrowLeft5,
            skin.sprites.flickArrowLeft6,
            skin.sprites.flickArrowLeft7,
            skin.sprites.flickArrowLeft8,
        ],
        right: [
            skin.sprites.flickArrowRight1,
            skin.sprites.flickArrowRight2,
            skin.sprites.flickArrowRight3,
            skin.sprites.flickArrowRight4,
            skin.sprites.flickArrowRight5,
            skin.sprites.flickArrowRight6,
            skin.sprites.flickArrowRight7,
            skin.sprites.flickArrowRight8,
        ],
        fallback: skin.sprites.flickArrowFallback,
    }

    directionalEffect = particle.effects.flickNoteDirectional

    windows = windows.slideEndFlickNote.normal

    bucket = buckets.normalSlideEndFlickNote

    get slotEffect() {
        return archetypes.FlickSlotEffect
    }

    get slotGlowEffect() {
        return archetypes.FlickSlotGlowEffect
    }
}
