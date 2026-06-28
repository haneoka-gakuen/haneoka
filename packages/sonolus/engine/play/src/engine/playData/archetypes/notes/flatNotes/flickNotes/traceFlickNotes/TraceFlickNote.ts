import { minFlickVR } from '../../../../../flick.js'
import { note } from '../../../../../note.js'
import { scaledScreen } from '../../../../../scaledScreen.js'
import { getZ, layer } from '../../../../../skin.js'
import { disallowEmpty } from '../../../../InputManager.js'
import { FlickNote } from '../FlickNote.js'

export abstract class TraceFlickNote extends FlickNote {
    abstract sprites: {
        left: SkinSprite
        middle: SkinSprite
        right: SkinSprite
        diamond: SkinSprite
        fallback: SkinSprite
    }

    earlyInputTime = this.entityMemory(Number)
    earlyHitTime = this.entityMemory(Number)

    diamondLayout = this.entityMemory(Rect)

    diamondZ = this.entityMemory(Number)

    initialize() {
        super.initialize()

        this.earlyInputTime = this.targetTime + input.offset
        this.earlyHitTime = -9999

        if (!this.useFallbackSprites) {
            const w = note.h / scaledScreen.wToH

            new Rect({
                l: this.import.lane - w,
                r: this.import.lane + w,
                b: 1 + note.h,
                t: 1 - note.h,
            }).copyTo(this.diamondLayout)

            this.diamondZ = getZ(layer.note.tick, this.targetTime, this.import.lane)
        }
    }

    touch() {
        if (time.now < this.inputTime.min) return

        if (time.now < this.earlyInputTime) {
            this.earlyTouch()
        } else {
            this.lateTouch()
        }
    }

    updateParallel() {
        this.triggerEarlyTouch()

        super.updateParallel()
    }

    earlyTouch() {
        for (const touch of touches) {
            if (touch.vr < minFlickVR) continue
            if (!this.fullHitbox.contains(touch.position)) continue

            disallowEmpty(touch)
            this.earlyHitTime = touch.time
            return
        }
    }

    lateTouch() {
        for (const touch of touches) {
            if (touch.vr < minFlickVR) continue
            if (!this.fullHitbox.contains(touch.lastPosition)) continue

            disallowEmpty(touch)
            this.completeTraceFlick(Math.max(touch.time, this.targetTime))
            return
        }
    }

    triggerEarlyTouch() {
        if (this.despawn) return
        if (time.now < this.earlyInputTime) return
        if (this.earlyHitTime === -9999) return

        this.completeTraceFlick(this.earlyHitTime)
        this.despawn = true
    }

    render() {
        super.render()

        if (!this.useFallbackSprites) {
            this.sprites.diamond.draw(this.diamondLayout.mul(this.y), [this.diamondZ], 1)
        }
    }

    playNoteEffects() {
        super.playNoteEffects()
    }

    playSlotEffects() {
        // removed
    }

    playLaneEffects() {
        // removed
    }

    completeTraceFlick(hitTime: number) {
        this.result.judgment = this.judge(hitTime)
        this.result.accuracy = hitTime - this.targetTime

        this.result.bucket.index = this.bucket.index
        this.result.bucket.value = this.result.accuracy * 1000

        this.playHitEffects(time.now)

        this.despawn = true
    }

    get useFallbackSprites() {
        return (
            !this.sprites.left.exists ||
            !this.sprites.middle.exists ||
            !this.sprites.right.exists ||
            !this.sprites.diamond.exists
        )
    }
}
