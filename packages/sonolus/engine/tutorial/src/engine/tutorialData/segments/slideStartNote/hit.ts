import { connector } from '../../components/connector.js'
import { slide } from '../../components/slide.js'
import { effect } from '../../effect.js'
import { drawHand } from '../../instruction.js'
import {
    particle,
    playLaneEffect,
    playNoteEffect,
    spawnHoldEffect,
} from '../../particle.js'

let sfxInstanceId = tutorialMemory(LoopedEffectClipInstanceId)
let effectInstanceId = tutorialMemory(ParticleEffectInstanceId)

export const slideStartNoteHit = {
    enter() {
        slide.show()
        connector.showActive()

        effect.clips.normalPerfect.play(0)

        playNoteEffect(particle.effects.slideNote, 7 / 12)
        playLaneEffect(particle.effects.laneSlide)

        sfxInstanceId = effect.clips.normalHold.loop()
        effectInstanceId = spawnHoldEffect()
    },

    update() {
        drawHand(Math.PI / 3, 0, 1)
    },

    exit() {
        slide.clear()
        connector.clear()

        effect.clips.stopLoop(sfxInstanceId)
        particle.effects.destroy(effectInstanceId)
    },
}
