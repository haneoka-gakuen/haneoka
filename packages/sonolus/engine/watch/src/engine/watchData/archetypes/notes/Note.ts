import { EngineArchetypeDataName } from '@sonolus/core'
import { options } from '../../../configuration/options.js'

export abstract class Note extends Archetype {
    hasInput = true

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
        originalJudgment: { name: 'ourNotesJudgment', type: Number },
        judgment: { name: EngineArchetypeDataName.Judgment, type: DataType<Judgment> },
        accuracy: { name: EngineArchetypeDataName.Accuracy, type: Number },
    })

    targetTime = this.entityMemory(Number)

    preprocess() {
        if (options.mirror) this.import.lane *= -1

        this.targetTime = bpmChanges.at(this.import.beat).time

        if (this.hasInput) this.result.time = this.targetTime
    }
}
