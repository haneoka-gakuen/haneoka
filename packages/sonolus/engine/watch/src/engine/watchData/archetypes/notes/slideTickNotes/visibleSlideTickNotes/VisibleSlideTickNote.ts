import { approach } from '../../../../../../../../shared/src/engine/data/note.js'
import { options } from '../../../../../configuration/options.js'
import { sfxDistance } from '../../../../effect.js'
import { note } from '../../../../note.js'
import { linearEffectLayout } from '../../../../particle.js'
import { scaledScreen } from '../../../../scaledScreen.js'
import { getZ, layer } from '../../../../skin.js'
import { SlideTickNote } from '../SlideTickNote.js'

export abstract class VisibleSlideTickNote extends SlideTickNote {
    abstract sprites: {
        tick: SkinSprite
        fallback: SkinSprite
    }

    abstract clips: {
        tick: EffectClip
        fallback: EffectClip
    }

    abstract effect: ParticleEffect

    visualTime = this.entityMemory(Range)
    hiddenTime = this.entityMemory(Number)

    initialized = this.entityMemory(Boolean)

    spriteLayout = this.entityMemory(Quad)
    z = this.entityMemory(Number)

    preprocess() {
        super.preprocess()

        this.visualTime.copyFrom(
            Range.l.mul(note.duration).add(timeScaleChanges.at(this.targetTime).scaledTime),
        )

        if (options.sfxEnabled) {
            if (replay.isReplay) {
                this.scheduleReplaySFX()
            } else {
                this.scheduleSFX()
            }
        }
    }

    spawnTime() {
        return this.visualTime.min
    }

    despawnTime() {
        return this.visualTime.max
    }

    initialize() {
        if (this.initialized) return
        this.initialized = true

        this.globalInitialize()
    }

    updateParallel() {
        if (options.hidden > 0 && time.scaled > this.hiddenTime) return

        this.render()
    }

    terminate() {
        if (time.skip) return

        this.despawnTerminate()
    }

    get useFallbackSprite() {
        return !this.sprites.tick.exists
    }

    get useFallbackClip() {
        return !this.clips.tick.exists
    }

    globalInitialize() {
        if (options.hidden > 0)
            this.hiddenTime = this.visualTime.max - note.duration * options.hidden

        const h = 59 / 850 / 2
        const b = 1 + h
        const t = 1 - h

        const w = h / scaledScreen.wToH

        new Rect({
            l: this.import.lane - w,
            r: this.import.lane + w,
            b,
            t,
        })
            .toQuad()
            .copyTo(this.spriteLayout)

        this.z = getZ(layer.note.tick, this.targetTime, this.import.lane)
    }

    scheduleSFX() {
        if (this.useFallbackClip) {
            this.clips.fallback.schedule(this.targetTime, sfxDistance)
        } else {
            this.clips.tick.schedule(this.targetTime, sfxDistance)
        }
    }

    scheduleReplaySFX() {
        if (!this.import.judgment) return

        this.scheduleSFX()
    }

    render() {
        const y = approach(this.visualTime.min, this.visualTime.max, time.scaled)

        if (this.useFallbackSprite) return

        this.sprites.tick.draw(this.spriteLayout.mul(y), [this.z], 1)
    }

    despawnTerminate() {
        if (replay.isReplay && !this.import.judgment) return

        if (options.noteEffectEnabled) this.playNoteEffect()
    }

    playNoteEffect() {
        this.effect.spawn(
            linearEffectLayout({ lane: this.import.lane, size: this.import.size, shear: 0 }),
            5 / 12,
            false,
        )
    }
}
