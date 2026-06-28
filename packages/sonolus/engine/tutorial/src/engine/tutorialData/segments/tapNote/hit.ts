import { effect } from '../../effect.js'
import {
    particle,
    playLaneEffect,
    playNoteEffect,
} from '../../particle.js'

export const tapNoteHit = {
    enter() {
        effect.clips.normalPerfect.play(0)

        playNoteEffect(particle.effects.normalNote, 5 / 12)
        playLaneEffect(particle.effects.laneNormal)
    },
}
