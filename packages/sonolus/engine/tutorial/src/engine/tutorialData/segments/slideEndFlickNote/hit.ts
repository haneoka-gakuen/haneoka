import { effect } from '../../effect.js'
import {
    particle,
    playLaneEffect,
    playNoteEffect,
} from '../../particle.js'

export const slideEndFlickNoteHit = {
    enter() {
        effect.clips.flickPerfect.play(0)

        playNoteEffect(particle.effects.flickNote, 5 / 12)
        playLaneEffect(particle.effects.laneFlick)
    },
}
