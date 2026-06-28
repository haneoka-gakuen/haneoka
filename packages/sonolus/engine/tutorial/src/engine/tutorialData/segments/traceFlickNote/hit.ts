import { effect } from '../../effect.js'
import { particle, playNoteEffect } from '../../particle.js'

export const traceFlickNoteHit = {
    enter() {
        effect.clips.flickPerfect.play(0)

        playNoteEffect(particle.effects.flickNote, 5 / 12)
    },
}
