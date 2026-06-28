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

    spriteLayout = this.entityMemory(Quad)
    z = this.entityMemory(Number)

    y = this.entityMemory(Number)

    preprocess() {
        super.preprocess()

        this.visualTime.copyFrom(
            Range.l.mul(note.duration).add(timeScaleChanges.at(this.targetTime).scaledTime),
        )

        this.spawnTime = Math.min(
            this.visualTime.min,
            timeScaleChanges.at(this.inputTime).scaledTime,
        )

        if (this.shouldScheduleSFX) this.scheduleSFX()
    }

    initialize() {
        super.initialize()

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

    updateParallel() {
        super.updateParallel()
        if (this.despawn) return

        if (time.scaled < this.visualTime.min) return
        if (options.hidden > 0 && time.scaled > this.hiddenTime) return

        this.render()
    }

    get shouldScheduleSFX() {
        return options.sfxEnabled && options.autoSFX
    }

    get shouldPlaySFX() {
        return options.sfxEnabled && !options.autoSFX
    }

    get useFallbackSprite() {
        return !this.sprites.tick.exists
    }

    get useFallbackClip() {
        return !this.clips.tick.exists
    }

    scheduleSFX() {
        if (this.useFallbackClip) {
            this.clips.fallback.schedule(this.targetTime, sfxDistance)
        } else {
            this.clips.tick.schedule(this.targetTime, sfxDistance)
        }
    }

    render() {
        if (time.now >= this.targetTime) return

        this.y = approach(this.visualTime.min, this.visualTime.max, time.scaled)

        if (this.useFallbackSprite) return

        this.sprites.tick.draw(this.spriteLayout.mul(this.y), [this.z], 1)
    }

    playHitEffects() {
        if (this.shouldPlaySFX) this.playSFX()
        if (options.noteEffectEnabled) this.playNoteEffect()
    }

    playSFX() {
        if (this.useFallbackClip) {
            this.clips.fallback.play(sfxDistance)
        } else {
            this.clips.tick.play(sfxDistance)
        }
    }

    playNoteEffect() {
        this.effect.spawn(
            linearEffectLayout({ lane: this.import.lane, size: this.import.size, shear: 0 }),
            5 / 12,
            false,
        )
    }
}
