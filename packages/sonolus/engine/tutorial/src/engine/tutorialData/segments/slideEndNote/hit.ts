import { effect } from '../../effect.js'
import {
    particle,
    playLaneEffect,
    playNoteEffect,
} from '../../particle.js'

export const slideEndNoteHit = {
    enter() {
        effect.clips.normalPerfect.play(0)

        playNoteEffect(particle.effects.slideNote, 7 / 12)
        playLaneEffect(particle.effects.laneSlide)
    },
}
