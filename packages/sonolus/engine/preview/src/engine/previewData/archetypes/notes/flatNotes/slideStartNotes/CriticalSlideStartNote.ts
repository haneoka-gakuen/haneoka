import { skin } from '../../../../skin.js'
import { SlideStartNote } from './SlideStartNote.js'

export class CriticalSlideStartNote extends SlideStartNote {
    sprites = {
        left: skin.sprites.slideNoteLeft,
        middle: skin.sprites.slideNoteMiddle,
        right: skin.sprites.slideNoteRight,
        fallback: skin.sprites.slideNoteFallback,
    }
}
