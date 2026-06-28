import { approach, getNoteHalfHeight } from '../../../../../../../shared/src/engine/data/note.js'
import { nativeLaneEffectLifetime } from '../../../../../../../shared/src/engine/data/lane.js'
import { perspectiveLayout } from '../../../../../../../shared/src/engine/data/utils.js'
import { toBucketWindows, Windows } from '../../../../../../../shared/src/engine/data/windows.js'
import { options } from '../../../../configuration/options.js'
import { sfxDistance } from '../../../effect.js'
import { getHitbox, getNativeJudgmentLeniency, lane } from '../../../lane.js'
import { note } from '../../../note.js'
import { linearEffectLayout, particle } from '../../../particle.js'
import { getZ, layer, skin } from '../../../skin.js'
import { Note } from '../Note.js'

export abstract class FlatNote extends Note {
    abstract sprites: {
        left: SkinSprite
        middle: SkinSprite
        right: SkinSprite
        fallback: SkinSprite
    }

    abstract clips: {
        perfect: EffectClip
        great?: EffectClip
        good?: EffectClip
        fallback?: EffectClip
    }

    abstract effects: {
        circular: ParticleEffect
        circularFallback?: ParticleEffect
        linear: ParticleEffect
        linearFallback?: ParticleEffect
    }

    abstract windows: Windows

    abstract bucket: Bucket

    originalExport = this.defineExport({
        judgment: { name: 'ourNotesJudgment', type: Number },
        accuracyMs: { name: 'ourNotesAccuracyMs', type: Number },
    })

    layer = layer.note.body

    visualTime = this.entityMemory(Range)
    hiddenTime = this.entityMemory(Number)

    inputTime = this.entityMemory(Range)

    spriteLayouts = this.entityMemory({
        left: Quad,
        middle: Quad,
        right: Quad,
    })
    z = this.entityMemory(Number)

    y = this.entityMemory(Number)
    // Sonolus has no Bad result enum, but the native effect state machine does.
    // Keep the original 1..6 judgment separately so Bad (2) does not collapse
    // into the same no-effect path as Miss (1).
    nativeJudgment = this.entityMemory(Number)

    preprocess() {
        super.preprocess()

        this.bucket.set(toBucketWindows(this.windows))
        this.archetypeLife.miss = -100

        this.visualTime.copyFrom(
            Range.l.mul(note.duration).add(timeScaleChanges.at(this.targetTime).scaledTime),
        )

        this.inputTime.copyFrom(this.windows.input.add(this.targetTime).add(input.offset))

        this.spawnTime = Math.min(
            this.visualTime.min,
            timeScaleChanges.at(this.inputTime.min).scaledTime,
        )

        if (this.shouldScheduleSFX) this.scheduleSFX()
    }

    initialize() {
        this.originalExport('judgment', 1)
        this.originalExport('accuracyMs', this.windows.input.max * 1000)
        this.nativeJudgment = 1

        if (options.hidden > 0)
            this.hiddenTime = this.visualTime.max - note.duration * options.hidden

        const l = this.import.lane - this.import.size
        const r = this.import.lane + this.import.size

        getHitbox({ l, r, leniency: 0 }).copyTo(this.hitbox)
        getHitbox({
            l,
            r,
            leniency: getNativeJudgmentLeniency({
                operateType: this.import.operateType,
                originalCritical: this.import.originalCritical,
                originalSize: this.import.originalSize,
            }),
        }).copyTo(this.fullHitbox)

        const h = getNoteHalfHeight(this.import.operateType)
        const b = 1 + h
        const t = 1 - h

        const ml = l + 0.3
        const mr = r - 0.3

        perspectiveLayout({ l, r: ml, b, t }).copyTo(this.spriteLayouts.left)
        perspectiveLayout({ l: ml, r: mr, b, t }).copyTo(this.spriteLayouts.middle)
        perspectiveLayout({ l: mr, r, b, t }).copyTo(this.spriteLayouts.right)

        this.z = getZ(this.layer, this.targetTime, this.import.lane)
        this.result.accuracy = this.windows.input.max
    }

    updateParallel() {
        if (time.now > this.inputTime.max) this.despawn = true
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

    get supportsJust() {
        return (
            this.import.judgementType === 1 ||
            this.import.judgementType === 2 ||
            this.import.judgementType === 5 ||
            this.import.judgementType === 10 ||
            this.import.judgementType === 12 ||
            this.import.judgementType === 15
        )
    }

    get useFallbackSprites() {
        return (
            !this.sprites.left.exists || !this.sprites.middle.exists || !this.sprites.right.exists
        )
    }

    get useFallbackClip() {
        return (
            !this.clips.perfect.exists ||
            ('great' in this.clips && !this.clips.great.exists) ||
            ('good' in this.clips && !this.clips.good.exists)
        )
    }

    get circularEffectId() {
        return 'circularFallback' in this.effects && !this.effects.circular.exists
            ? this.effects.circularFallback.id
            : this.effects.circular.id
    }

    get linearEffectId() {
        return 'linearFallback' in this.effects && !this.effects.linear.exists
            ? this.effects.linearFallback.id
            : this.effects.linear.id
    }

    get noteEffectDuration() {
        if (
            this.import.operateType === 40 ||
            this.import.operateType === 41 ||
            this.import.operateType === 42 ||
            this.import.operateType === 102
        ) {
            return this.nativeJudgment >= 5 ? 5 / 12 : 2 / 3
        }

        if (
            this.import.operateType === 20 ||
            this.import.operateType === 21 ||
            this.import.operateType === 22 ||
            this.import.operateType === 60 ||
            this.import.operateType === 61 ||
            this.import.operateType === 62 ||
            this.import.operateType === 63 ||
            this.import.operateType === 104 ||
            this.import.operateType === 105
        ) {
            return this.nativeJudgment >= 5 ? 7 / 12 : 5 / 12
        }

        return 5 / 12
    }

    get nativeNoteEffectId() {
        const judgment = this.nativeJudgment
        if (
            this.import.operateType === 40 ||
            this.import.operateType === 41 ||
            this.import.operateType === 42 ||
            this.import.operateType === 102
        ) {
            const direction = options.mirror
                ? this.import.originalDirection === 1
                    ? 2
                    : this.import.originalDirection === 2
                      ? 1
                      : 0
                : this.import.originalDirection
            if (direction === 1) {
                if (judgment === 4) return particle.effects.flickLeftGreat.id
                if (judgment === 3) return particle.effects.flickLeftGood.id
                if (judgment === 2) return particle.effects.flickLeftBad.id
                return particle.effects.flickLeftWall.id
            }
            if (direction === 2) {
                if (judgment === 4) return particle.effects.flickRightGreat.id
                if (judgment === 3) return particle.effects.flickRightGood.id
                if (judgment === 2) return particle.effects.flickRightBad.id
                return particle.effects.flickRightWall.id
            }
            if (judgment === 4) return particle.effects.flickNoteGreat.id
            if (judgment === 3) return particle.effects.flickNoteGood.id
            if (judgment === 2) return particle.effects.flickNoteBad.id
            return particle.effects.flickNoteCircular.id
        }

        if (this.import.operateType === 20 || this.import.operateType === 22) {
            if (judgment === 4) return particle.effects.slideNoteGreat.id
            if (judgment === 3) return particle.effects.slideNoteGood.id
            if (judgment === 2) return particle.effects.slideNoteBad.id
            return particle.effects.slideNoteCircular.id
        }

        if (
            this.import.operateType === 21 ||
            this.import.operateType === 60 ||
            this.import.operateType === 61 ||
            this.import.operateType === 62 ||
            this.import.operateType === 63 ||
            this.import.operateType === 104 ||
            this.import.operateType === 105
        ) {
            if (judgment === 4) return particle.effects.normalTraceNoteGreat.id
            if (judgment === 3) return particle.effects.normalTraceNoteGood.id
            if (judgment === 2) return particle.effects.normalTraceNoteBad.id
            return particle.effects.normalTraceNoteCircular.id
        }

        if (judgment === 4) return particle.effects.normalNoteGreat.id
        if (judgment === 3) return particle.effects.normalNoteGood.id
        if (judgment === 2) return particle.effects.normalNoteBad.id
        return particle.effects.normalNoteCircular.id
    }

    scheduleSFX() {
        // Sonolus auto SFX is scheduled before an input result exists. Routing
        // every source note type that supports Our Notes Just to the Just cue
        // therefore made ordinary autoplay hits sound like Just. Sonolus only
        // exposes Perfect here, so schedule the operation's native Perfect cue.
        if ('fallback' in this.clips && this.useFallbackClip) {
            this.clips.fallback.schedule(this.targetTime, sfxDistance)
        } else {
            this.clips.perfect.schedule(this.targetTime, sfxDistance)
        }
    }

    render() {
        this.y = approach(this.visualTime.min, this.visualTime.max, time.scaled)

        this.renderBody()
        this.renderDecoration()
    }

    renderBody() {
        // A standard Sonolus note head is not a visual substitute for a
        // missing skin001 slice. Preserve fidelity by omitting the body.
        if (this.useFallbackSprites) return

        this.sprites.left.draw(this.spriteLayouts.left.mul(this.y), [this.z], 1)
        this.sprites.middle.draw(this.spriteLayouts.middle.mul(this.y), [this.z], 1)
        this.sprites.right.draw(this.spriteLayouts.right.mul(this.y), [this.z], 1)
    }

    renderDecoration() {
        const layout = perspectiveLayout({
            l: this.import.lane - (25 * 6) / 1420,
            r: this.import.lane + (25 * 6) / 1420,
            b: 1 + 12.5 / 850,
            t: 1 - 12.5 / 850,
        }).mul(this.y)
        const z = getZ(layer.note.body + 0.5, this.targetTime, this.import.lane)
        const direction = options.mirror
            ? this.import.originalDirection === 1
                ? 2
                : this.import.originalDirection === 2
                  ? 1
                  : 0
            : this.import.originalDirection

        if (this.import.operateType === 1 || this.import.operateType === 101) {
            skin.sprites.tapDecoration.draw(layout, [z], 1)
        } else if (this.import.operateType === 20 || this.import.operateType === 22) {
            skin.sprites.slideDecoration.draw(layout, [z], 1)
        } else if (
            this.import.operateType === 40 ||
            this.import.operateType === 41 ||
            this.import.operateType === 42 ||
            this.import.operateType === 102
        ) {
            if (direction === 1) {
                skin.sprites.flickLeftDecoration.draw(layout, [z], 1)
            } else if (direction === 2) {
                skin.sprites.flickRightDecoration.draw(layout, [z], 1)
            } else {
                skin.sprites.flickDecoration.draw(layout, [z], 1)
            }
        }
    }

    playHitEffects(hitTime: number) {
        if (this.shouldPlaySFX) this.playSFX()
        // LiveGameNoteEffectBase.Play maps Miss to animator state 0, so no
        // authored effect animation is selected.
        if (options.noteEffectEnabled && this.nativeJudgment !== 1) this.playNoteEffects()
        if (options.laneEffectEnabled) this.playLaneEffects()
    }

    judge(hitTime: number) {
        const diff = hitTime - this.targetTime

        this.originalExport('accuracyMs', diff * 1000)

        if (this.supportsJust && Math.abs(diff) <= 0.001) {
            this.nativeJudgment = 6
            this.originalExport('judgment', 6)
            return Judgment.Perfect
        }

        if (this.windows.perfect.contains(diff)) {
            this.nativeJudgment = 5
            this.originalExport('judgment', 5)
            return Judgment.Perfect
        }
        if (this.windows.great.contains(diff)) {
            this.nativeJudgment = 4
            this.originalExport('judgment', 4)
            return Judgment.Great
        }
        if (this.windows.good.contains(diff)) {
            this.nativeJudgment = 3
            this.originalExport('judgment', 3)
            return Judgment.Good
        }
        if (this.windows.bad.contains(diff)) {
            this.nativeJudgment = 2
            this.originalExport('judgment', 2)
            return Judgment.Miss
        }

        // Our Notes Bad has no Sonolus result enum. Map it to Miss instead of
        // inflating it to Good; the original judgementType remains in LevelData.
        this.nativeJudgment = 1
        this.originalExport('judgment', 1)
        return Judgment.Miss
    }

    playSFX() {
        if ('fallback' in this.clips && this.useFallbackClip) {
            this.clips.fallback.play(sfxDistance)
        } else if ('great' in this.clips && 'good' in this.clips) {
            switch (this.result.judgment) {
                case Judgment.Perfect:
                    this.clips.perfect.play(sfxDistance)
                    break
                case Judgment.Great:
                    this.clips.great.play(sfxDistance)
                    break
                case Judgment.Good:
                    this.clips.good.play(sfxDistance)
                    break
            }
        } else {
            this.clips.perfect.play(sfxDistance)
        }
    }

    playNoteEffects() {
        // One Sonolus effect contains every representable effect001 billboard
        // and SpriteRenderer. The omitted second unit is Unity's custom wall
        // mesh, not a generic spark layer.
        this.playCircularNoteEffect()
    }

    playLinearNoteEffect() {
        particle.effects.spawn(
            this.linearEffectId,
            linearEffectLayout({
                lane: this.import.lane,
                size: this.import.size,
                shear: 0,
            }),
            this.noteEffectDuration,
            false,
        )
    }

    playCircularNoteEffect() {
        particle.effects.spawn(
            this.nativeNoteEffectId,
            linearEffectLayout({
                lane: this.import.lane,
                size: this.import.size,
                shear: 0,
            }),
            this.noteEffectDuration,
            false,
        )
    }

    playLaneEffects() {
        const layout = perspectiveLayout({
            l: this.import.lane - this.import.size,
            r: this.import.lane + this.import.size,
            b: lane.b,
            t: lane.t,
        })
        const direction = options.mirror
            ? this.import.originalDirection === 1
                ? 2
                : this.import.originalDirection === 2
                  ? 1
                  : 0
            : this.import.originalDirection

        if (this.import.operateType === 1 || this.import.operateType === 101) {
            particle.effects.laneNormal.spawn(layout, nativeLaneEffectLifetime, false)
        } else if (
            this.import.operateType === 40 ||
            this.import.operateType === 41 ||
            this.import.operateType === 42 ||
            this.import.operateType === 102
        ) {
            if (direction === 1) {
                particle.effects.laneFlickLeft.spawn(layout, nativeLaneEffectLifetime, false)
            } else if (direction === 2) {
                particle.effects.laneFlickRight.spawn(layout, nativeLaneEffectLifetime, false)
            } else {
                particle.effects.laneFlick.spawn(layout, nativeLaneEffectLifetime, false)
            }
        } else if (this.import.operateType === 20 || this.import.operateType === 22) {
            particle.effects.laneSlide.spawn(layout, nativeLaneEffectLifetime, false)
        }
    }
}
