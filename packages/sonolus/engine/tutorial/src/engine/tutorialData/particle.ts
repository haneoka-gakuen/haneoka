import { lane, nativeLaneEffectLifetime } from '../../../../shared/src/engine/data/lane.js'
import { perspectiveLayout } from '../../../../shared/src/engine/data/utils.js'
import { scaledScreen } from './scaledScreen.js'

export const particle = defineParticle({
    effects: {
        laneNormal: 'Our Notes Lane Normal',
        laneSlide: 'Our Notes Lane Slide',
        laneFlick: 'Our Notes Lane Flick',

        normalNote: 'Our Notes Native Normal',
        slideNote: 'Our Notes Native Slide',
        flickNote: 'Our Notes Native Flick',
        connectNote: 'Our Notes Native Connect',
        slideLoop: 'Our Notes Native Slide Loop',
    },
})

const noteEffectLayout = () => {
    const l = -2
    const r = 2

    const b = 1
    const t = 1 - 2 * scaledScreen.wToH

    return new Rect({ l, r, b, t })
}

export const playNoteEffect = (effect: ParticleEffect, duration: number) =>
    effect.spawn(noteEffectLayout(), duration, false)

export const playLaneEffect = (effect: ParticleEffect) =>
    effect.spawn(
        perspectiveLayout({ l: -2, r: 2, b: lane.b, t: lane.t }),
        nativeLaneEffectLifetime,
        false,
    )

export const spawnHoldEffect = () =>
    particle.effects.slideLoop.spawn(noteEffectLayout(), 1, true)
