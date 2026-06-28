import { skin } from '../../../../../skin.js'
import { TraceFlickNote } from './TraceFlickNote.js'

export class NormalTraceFlickNote extends TraceFlickNote {
    sprites = {
        left: skin.sprites.traceFlickNoteLeft,
        middle: skin.sprites.traceFlickNoteMiddle,
        right: skin.sprites.traceFlickNoteRight,
        diamond: skin.sprites.traceFlickNoteDiamond,
        fallback: skin.sprites.traceFlickNoteFallback,
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
}
