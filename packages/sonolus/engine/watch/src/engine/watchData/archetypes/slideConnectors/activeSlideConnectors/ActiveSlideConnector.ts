import { perspectiveLayout } from '../../../../../../../shared/src/engine/data/utils.js'
import { options } from '../../../../configuration/options.js'
import { effect } from '../../../effect.js'
import { note } from '../../../note.js'
import { linearEffectLayout, particle } from '../../../particle.js'
import { getZ, layer } from '../../../skin.js'
import { SlideConnector, VisualType } from '../SlideConnector.js'

export abstract class ActiveSlideConnector extends SlideConnector {
    abstract slideSprites: {
        left: SkinSprite
        middle: SkinSprite
        right: SkinSprite
        fallback: SkinSprite
    }

    abstract clips: {
        hold: EffectClip
        fallback: EffectClip
    }

    abstract effects: {
        circular: ParticleEffect
        linear: ParticleEffect
    }

    effectInstanceIds = this.entityMemory({
        circular: ParticleEffectInstanceId,
        linear: ParticleEffectInstanceId,
    })

    slideZ = this.entityMemory(Number)

    preprocess() {
        super.preprocess()

        if (options.sfxEnabled) {
            if (replay.isReplay) {
                this.scheduleReplaySFX()
            } else {
                this.scheduleSFX(this.head.time, this.tail.time)
            }
        }
    }

    updateParallel() {
        super.updateParallel()

        if (time.skip) {
            if (this.shouldScheduleCircularEffect) this.effectInstanceIds.circular = 0

            if (this.shouldScheduleLinearEffect) this.effectInstanceIds.linear = 0
        }

        if (time.now < this.head.time) return

        if (this.visual === VisualType.Activated) {
            if (this.shouldScheduleCircularEffect) {
                if (!this.effectInstanceIds.circular) this.spawnCircularEffect()

                this.updateCircularEffect()
            }

            if (this.shouldScheduleLinearEffect) {
                if (!this.effectInstanceIds.linear) this.spawnLinearEffect()

                this.updateLinearEffect()
            }
        } else {
            if (this.shouldScheduleCircularEffect && this.effectInstanceIds.circular)
                this.destroyCircularEffect()

            if (this.shouldScheduleLinearEffect && this.effectInstanceIds.linear)
                this.destroyLinearEffect()
        }

        this.renderSlide()
    }

    terminate() {
        if (this.shouldScheduleCircularEffect && this.effectInstanceIds.circular)
            this.destroyCircularEffect()

        if (this.shouldScheduleLinearEffect && this.effectInstanceIds.linear)
            this.destroyLinearEffect()
    }

    get useFallbackSlideSprite() {
        return (
            !this.slideSprites.left.exists ||
            !this.slideSprites.middle.exists ||
            !this.slideSprites.right.exists
        )
    }

    get useFallbackClip() {
        return !this.clips.hold.exists
    }

    get shouldScheduleCircularEffect() {
        return options.noteEffectEnabled && this.effects.circular.exists
    }

    get shouldScheduleLinearEffect() {
        return options.noteEffectEnabled && this.effects.linear.exists
    }

    globalInitialize() {
        super.globalInitialize()

        this.slideZ = getZ(layer.note.slide, this.head.time, this.headImport.lane)
    }

    getAlpha() {
        return 1
    }

    renderSlide() {
        // Do not replace missing Our Notes slices with a generic green bar.
        if (this.useFallbackSlideSprite) return

        const s = this.getScale(time.scaled)

        const l = this.getL(s)
        const r = this.getR(s)

        const b = 1 + note.h
        const t = 1 - note.h

        const ml = l + 0.25
        const mr = r - 0.25

        this.slideSprites.left.draw(perspectiveLayout({ l, r: ml, b, t }), [this.slideZ], 1)
        this.slideSprites.middle.draw(
            perspectiveLayout({ l: ml, r: mr, b, t }),
            [this.slideZ],
            1,
        )
        this.slideSprites.right.draw(perspectiveLayout({ l: mr, r, b, t }), [this.slideZ], 1)
    }

    scheduleReplaySFX() {
        if (this.import.startRef !== this.import.headRef) return

        let key = -999999
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            const startTime = streams.getNextKey(this.import.startRef, key)
            if (startTime === key) break

            const endTime = streams.getValue(this.import.startRef, startTime)
            this.scheduleSFX(startTime, Math.min(endTime, this.end.time))

            key = startTime
        }
    }

    scheduleSFX(startTime: number, endTime: number) {
        const id =
            'fallback' in this.clips && this.useFallbackClip
                ? this.clips.fallback.scheduleLoop(startTime)
                : this.clips.hold.scheduleLoop(startTime)

        effect.clips.scheduleStopLoop(id, endTime)
    }

    spawnCircularEffect() {
        this.effectInstanceIds.circular = this.effects.circular.spawn(new Quad(), 1, true)
    }

    updateCircularEffect() {
        const s = this.getScale(time.scaled)
        const lane = this.getLane(s)
        const size = (this.getR(s) - this.getL(s)) / 2

        particle.effects.move(
            this.effectInstanceIds.circular,
            linearEffectLayout({
                lane,
                size,
                shear: 0,
            }),
        )
    }

    destroyCircularEffect() {
        particle.effects.destroy(this.effectInstanceIds.circular)
        this.effectInstanceIds.circular = 0
    }

    spawnLinearEffect() {
        this.effectInstanceIds.linear = this.effects.linear.spawn(new Quad(), 1, true)
    }

    updateLinearEffect() {
        const s = this.getScale(time.scaled)
        const lane = this.getLane(s)
        const size = (this.getR(s) - this.getL(s)) / 2

        particle.effects.move(
            this.effectInstanceIds.linear,
            linearEffectLayout({
                lane,
                size,
                shear: 0,
            }),
        )
    }

    destroyLinearEffect() {
        particle.effects.destroy(this.effectInstanceIds.linear)
        this.effectInstanceIds.linear = 0
    }
}
