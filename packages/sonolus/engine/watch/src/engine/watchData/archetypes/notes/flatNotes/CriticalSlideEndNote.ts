import { windows } from '../../../../../../../shared/src/engine/data/windows.js'
import { buckets } from '../../../buckets.js'
import { effect } from '../../../effect.js'
import { particle } from '../../../particle.js'
import { skin } from '../../../skin.js'
import { archetypes } from '../../index.js'
import { FlatNote } from './FlatNote.js'

export class CriticalSlideEndNote extends FlatNote {
    sprites = {
        left: skin.sprites.slideEndNoteLeft,
        middle: skin.sprites.slideEndNoteMiddle,
        right: skin.sprites.slideEndNoteRight,
        fallback: skin.sprites.slideNoteEndFallback,
    }

    clips = {
        perfect: effect.clips.normalPerfect,
    }

    effects = {
        circular: particle.effects.slideNoteCircular,
        linear: particle.effects.slideNoteLinear,
    }

    windows = windows.slideEndNote.critical

    bucket = buckets.criticalSlideEndNote

    get slotEffect() {
        return archetypes.CriticalSlotEffect
    }

    get slotGlowEffect() {
        return archetypes.CriticalSlotGlowEffect
    }
}
