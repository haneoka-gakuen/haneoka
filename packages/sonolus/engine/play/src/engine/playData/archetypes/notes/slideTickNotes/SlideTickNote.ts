import { getHitbox, getNativeJudgmentLeniency } from '../../../lane.js'
import { disallowEmpty } from '../../InputManager.js'
import { Note } from '../Note.js'

export abstract class SlideTickNote extends Note {
    leniency = 1

    inputTime = this.entityMemory(Number)

    preprocess() {
        super.preprocess()

        if (this.hasInput) this.archetypeLife.miss = -100

        this.inputTime = this.targetTime + input.offset

        this.spawnTime = timeScaleChanges.at(this.inputTime).scaledTime
    }

    initialize() {
        getHitbox({
            l: this.import.lane - this.import.size,
            r: this.import.lane + this.import.size,
            leniency: getNativeJudgmentLeniency({
                operateType: this.import.operateType,
                originalCritical: this.import.originalCritical,
                // Hidden attached Combo (120) ticks replace lane/size during
                // preprocess. Convert their live half-width back to the
                // chart's 24-lane width. Ordinary nodes retain originalSize so
                // a legal source width below 2 is not polluted by the legacy
                // visual minimum in chartToLevelData.
                originalSize:
                    this.import.operateType === 120
                        ? this.import.size * 4
                        : this.import.originalSize,
            }),
        }).copyTo(this.fullHitbox)

        this.result.accuracy = 0.125
    }

    touch() {
        if (time.now < this.inputTime) return

        for (const touch of touches) {
            if (!this.fullHitbox.contains(touch.position)) continue

            this.complete(touch)
            return
        }
    }

    updateParallel() {
        if (time.now > this.inputTime) this.despawn = true
    }

    complete(touch: Touch) {
        disallowEmpty(touch)

        this.result.judgment = Judgment.Perfect
        this.result.accuracy = 0

        this.playHitEffects()

        this.despawn = true
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    playHitEffects() {}
}
