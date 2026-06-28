import {
    getArrowLayout,
    getArrowSpriteId,
} from '../../../../../../../../shared/src/engine/data/arrowSprites.js'
import { FlickDirection } from '../../../../../../../../shared/src/engine/data/FlickDirection.js'
import { options } from '../../../../../configuration/options.js'
import { effect, sfxDistance } from '../../../../effect.js'
import { scaledScreen } from '../../../../scaledScreen.js'
import { getZ, layer, skin } from '../../../../skin.js'
import { FlatNote } from '../FlatNote.js'

export abstract class FlickNote extends FlatNote {
    abstract arrowSprites: {
        up: SkinSprite[]
        left: SkinSprite[]
        right: SkinSprite[]
        fallback: SkinSprite
    }

    abstract directionalEffect: ParticleEffect

    flickImport = this.defineImport({
        direction: { name: 'direction', type: DataType<FlickDirection> },
        accuracyDiff: { name: 'accuracyDiff', type: Number },
    })

    arrow = this.entityMemory({
        sprite: SkinSpriteId,
        layout: Quad,
        animation: Vec,
        z: Number,
    })

    preprocess() {
        super.preprocess()

        if (options.mirror) this.flickImport.direction *= -1
    }

    globalInitialize() {
        super.globalInitialize()

        this.arrow.sprite = getArrowSpriteId(
            this.arrowSprites,
            this.import.size,
            this.flickImport.direction,
        )

        if (skin.sprites.exists(this.arrow.sprite)) {
            getArrowLayout(
                this.import.size,
                this.flickImport.direction,
                this.import.lane,
                1,
            ).copyTo(this.arrow.layout)
        }

        if (options.markerAnimation)
            new Vec(
                this.flickImport.direction,
                this.flickImport.direction === FlickDirection.Up ? -2 * scaledScreen.wToH : 0,
            ).copyTo(this.arrow.animation)

        this.arrow.z = getZ(layer.note.arrow, this.targetTime, this.import.lane)
    }

    renderBody() {
        if (
            this.flickImport.direction === FlickDirection.Left &&
            skin.sprites.flickLeftNoteLeft.exists &&
            skin.sprites.flickLeftNoteMiddle.exists &&
            skin.sprites.flickLeftNoteRight.exists
        ) {
            skin.sprites.flickLeftNoteLeft.draw(this.spriteLayouts.left.mul(this.y), [this.z], 1)
            skin.sprites.flickLeftNoteMiddle.draw(this.spriteLayouts.middle.mul(this.y), [this.z], 1)
            skin.sprites.flickLeftNoteRight.draw(this.spriteLayouts.right.mul(this.y), [this.z], 1)
        } else if (
            this.flickImport.direction === FlickDirection.Right &&
            skin.sprites.flickRightNoteLeft.exists &&
            skin.sprites.flickRightNoteMiddle.exists &&
            skin.sprites.flickRightNoteRight.exists
        ) {
            skin.sprites.flickRightNoteLeft.draw(this.spriteLayouts.left.mul(this.y), [this.z], 1)
            skin.sprites.flickRightNoteMiddle.draw(this.spriteLayouts.middle.mul(this.y), [this.z], 1)
            skin.sprites.flickRightNoteRight.draw(this.spriteLayouts.right.mul(this.y), [this.z], 1)
        } else {
            super.renderBody()
        }
    }

    scheduleSFX() {
        if (
            !this.supportsJust &&
            this.flickImport.direction !== FlickDirection.Up &&
            effect.clips.flickSide.exists
        ) {
            effect.clips.flickSide.schedule(this.hitTime, sfxDistance)
        } else {
            super.scheduleSFX()
        }
    }

    scheduleReplaySFX() {
        if (!this.import.judgment) return

        if (
            !(this.supportsJust && Math.abs(this.import.accuracy) <= 0.001) &&
            this.import.judgment === Judgment.Perfect &&
            this.flickImport.direction !== FlickDirection.Up &&
            effect.clips.flickSide.exists
        ) {
            effect.clips.flickSide.schedule(this.hitTime, sfxDistance)
        } else {
            super.scheduleReplaySFX()
        }
    }

    get hitTime() {
        return (
            this.targetTime +
            (replay.isReplay ? this.import.accuracy + this.flickImport.accuracyDiff : 0)
        )
    }

    render() {
        super.render()

        if (!skin.sprites.exists(this.arrow.sprite)) return

        if (options.markerAnimation) {
            const s = Math.mod(time.now, 0.5) / 0.5

            skin.sprites.draw(
                this.arrow.sprite,
                this.arrow.layout.add(this.arrow.animation.mul(s)).mul(this.y),
                [this.arrow.z],
                1 - Math.ease('In', 'Cubic', s),
            )
        } else {
            skin.sprites.draw(this.arrow.sprite, this.arrow.layout.mul(this.y), [this.arrow.z], 1)
        }
    }

    playNoteEffects() {
        super.playNoteEffects()
    }
}
