import { EngineArchetypeDataName } from '@sonolus/core'
import { options } from '../../../configuration/options.js'

export abstract class Note extends Archetype {
    hasInput = true

    abstract leniency: number

    import = this.defineImport({
        beat: { name: EngineArchetypeDataName.Beat, type: Number },
        lane: { name: 'lane', type: Number },
        size: { name: 'size', type: Number },
        operateType: { name: 'operateType', type: Number },
        judgementType: { name: 'judgementType', type: Number },
        originalDirection: { name: 'originalDirection', type: Number },
        originalTick: { name: 'originalTick', type: Number },
        originalTimeMs: { name: 'originalTimeMs', type: Number },
        originalPos: { name: 'originalPos', type: Number },
        originalSize: { name: 'originalSize', type: Number },
        originalCritical: { name: 'originalCritical', type: Number },
        originalVisible: { name: 'originalVisible', type: Number },
        originalLineId: { name: 'originalLineId', type: Number },
        originalLineIndex: { name: 'originalLineIndex', type: Number },
        originalEaseL: { name: 'originalEaseL', type: Number },
        originalEaseR: { name: 'originalEaseR', type: Number },
    })

    sharedMemory = this.defineSharedMemory({
        lastActiveTime: Number,
        exportStartTime: Number,
    })

    targetTime = this.entityMemory(Number)

    spawnTime = this.entityMemory(Number)

    hitbox = this.entityMemory(Rect)
    fullHitbox = this.entityMemory(Rect)

    preprocess() {
        this.sharedMemory.lastActiveTime = -1000
        this.sharedMemory.exportStartTime = -1000

        this.targetTime = bpmChanges.at(this.import.beat).time

        if (options.mirror) this.import.lane *= -1
    }

    spawnOrder() {
        return 1000 + this.spawnTime
    }

    shouldSpawn() {
        return time.scaled >= this.spawnTime
    }

    updateSequentialOrder = 2
}
