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

    spawnTime = this.entityMemory(Number)

    left = this.entityMemory(Number)
    right = this.entityMemory(Number)
    z = this.entityMemory(Number)

    y = this.entityMemory(Number)

    preprocess() {
        if (!options.simLineEnabled) return

        this.targetTime = bpmChanges.at(this.aImport.beat).time

        this.visualTime.copyFrom(
            Range.l.mul(note.duration).add(timeScaleChanges.at(this.targetTime).scaledTime),
        )

        this.spawnTime = this.visualTime.min
    }

    spawnOrder() {
        if (!options.simLineEnabled) return 999999

        return 1000 + this.spawnTime
    }

    shouldSpawn() {
        if (!options.simLineEnabled) return false

        return time.scaled >= this.spawnTime
    }

    initialize() {
        if (options.hidden > 0)
            this.hiddenTime = this.visualTime.max - note.duration * options.hidden

        this.left = Math.min(this.aImport.lane, this.bImport.lane)
        this.right = Math.max(this.aImport.lane, this.bImport.lane)

        this.z = getZ(layer.simLine, this.targetTime, this.left)
    }

    updateParallel() {
        if (
            time.scaled > this.visualTime.max ||
            this.aInfo.state === EntityState.Despawned ||
            this.bInfo.state === EntityState.Despawned
        )
            this.despawn = true
        if (this.despawn) return

        if (options.hidden > 0 && time.scaled > this.hiddenTime) return

        this.render()
    }

    get aImport() {
        return archetypes.NormalTapNote.import.get(this.import.aRef)
    }

    get aInfo() {
        return entityInfos.get(this.import.aRef)
    }

    get bImport() {
        return archetypes.NormalTapNote.import.get(this.import.bRef)
    }

    get bInfo() {
        return entityInfos.get(this.import.bRef)
    }

    render() {
        this.y = approach(this.visualTime.min, this.visualTime.max, time.scaled)

        // SetProgress scales the pair-line X size and interpolates its centre,
        // but never scales SpriteRenderer.size.y. Keep the converted 0.025
        // Unity-unit height fixed even near the horizon.
        const layout = new Rect({
            l: this.left * this.y,
            r: this.right * this.y,
            b: this.y + simLine.h,
            t: this.y - simLine.h,
        })

        if (!skin.sprites.simLine.exists) return

        skin.sprites.simLine.draw(layout, [this.z], 1)
    }
}
