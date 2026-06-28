import { approach } from '../../../../../shared/src/engine/data/note.js'
import { simLine } from '../../../../../shared/src/engine/data/simLine.js'
import { options } from '../../configuration/options.js'
import { note } from '../note.js'
import { getZ, layer, skin } from '../skin.js'
import { archetypes } from './index.js'

export class SimLine extends Archetype {
    import = this.defineImport({
        aRef: { name: 'a', type: Number },
        bRef: { name: 'b', type: Number },
    })

    targetTime = this.entityMemory(Number)

    visualTime = this.entityMemory(Range)
    hiddenTime = this.entityMemory(Number)

    initialized = this.entityMemory(Boolean)

    left = this.entityMemory(Number)
    right = this.entityMemory(Number)
    z = this.entityMemory(Number)

    preprocess() {
        if (!options.simLineEnabled) return

        this.targetTime = bpmChanges.at(this.aImport.beat).time

        this.visualTime.copyFrom(
            Range.l.mul(note.duration).add(timeScaleChanges.at(this.targetTime).scaledTime),
        )
    }

    spawnTime() {
        return this.visualTime.min
    }

    despawnTime(): number {
        return replay.isReplay
            ? Math.min(
                  this.visualTime.max,
                  this.aSharedMemory.despawnTime,
                  this.bSharedMemory.despawnTime,
              )
            : this.visualTime.max
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

    get aImport() {
        return archetypes.NormalTapNote.import.get(this.import.aRef)
    }

    get aSharedMemory() {
        return archetypes.NormalTapNote.sharedMemory.get(this.import.aRef)
    }

    get bImport() {
        return archetypes.NormalTapNote.import.get(this.import.bRef)
    }

    get bSharedMemory() {
        return archetypes.NormalTapNote.sharedMemory.get(this.import.bRef)
    }

    globalInitialize() {
        if (options.hidden > 0)
            this.hiddenTime = this.visualTime.max - note.duration * options.hidden

        this.left = Math.min(this.aImport.lane, this.bImport.lane)
        this.right = Math.max(this.aImport.lane, this.bImport.lane)

        this.z = getZ(layer.simLine, this.targetTime, this.left)
    }

    render() {
        const y = approach(this.visualTime.min, this.visualTime.max, time.scaled)

        // LivePairNoteLineView.SetProgress preserves the serialized Y size;
        // only its centre and X size follow view progress.
        const layout = new Rect({
            l: this.left * y,
            r: this.right * y,
            b: y + simLine.h,
            t: y - simLine.h,
        })

        if (!skin.sprites.simLine.exists) return

        skin.sprites.simLine.draw(layout, [this.z], 1)
    }
}
