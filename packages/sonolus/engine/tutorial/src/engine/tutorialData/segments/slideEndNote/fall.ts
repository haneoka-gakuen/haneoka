import { connector } from '../../components/connector.js'
import { noteDisplay } from '../../components/noteDisplay.js'
import { slide } from '../../components/slide.js'
import { effect } from '../../effect.js'
import { drawHand } from '../../instruction.js'
import { particle, spawnHoldEffect } from '../../particle.js'

let sfxInstanceId = tutorialMemory(LoopedEffectClipInstanceId)
let effectInstanceId = tutorialMemory(ParticleEffectInstanceId)

export const slideEndNoteFall = {
    enter() {
        noteDisplay.showFall('slideEnd')
        slide.show()
        connector.showFallOut()

        sfxInstanceId = effect.clips.normalHold.loop()
        effectInstanceId = spawnHoldEffect()
    },

    update() {
        drawHand(Math.PI / 3, 0, 1)
    },

    exit() {
        noteDisplay.clear()
        slide.clear()
        connector.clear()

        effect.clips.stopLoop(sfxInstanceId)
        particle.effects.destroy(effectInstanceId)
    },
}
