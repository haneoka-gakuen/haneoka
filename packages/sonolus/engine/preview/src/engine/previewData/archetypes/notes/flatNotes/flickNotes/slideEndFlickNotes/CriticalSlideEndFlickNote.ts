import { skin } from '../../../../../skin.js'
import { SlideEndFlickNote } from './SlideEndFlickNote.js'

export class CriticalSlideEndFlickNote extends SlideEndFlickNote {
    sprites = {
        left: skin.sprites.criticalNoteLeft,
        middle: skin.sprites.criticalNoteMiddle,
        right: skin.sprites.criticalNoteRight,
        fallback: skin.sprites.criticalNoteEndFallback,
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
}
