import { effect } from '../../effect.js'
import { particle, playNoteEffect } from '../../particle.js'

export const traceNoteHit = {
    enter() {
        if (effect.clips.normalTrace.exists) {
            effect.clips.normalTrace.play(0)
        } else {
            effect.clips.normalPerfect.play(0)
        }

        playNoteEffect(particle.effects.connectNote, 7 / 12)
    },
}
