import { ease } from '../../../../../../../shared/src/engine/data/EaseType.js'
import { archetypes } from '../../index.js'

export const getAttached = (ref: number, targetTime: number) => {
    const attachImport = archetypes.NormalSlideConnector.import.get(ref)

    const imports = {
        head: archetypes.NormalSlideStartNote.import.get(attachImport.headRef),
        tail: archetypes.NormalSlideStartNote.import.get(attachImport.tailRef),
    }

    const t = {
        min: bpmChanges.at(imports.head.beat).time,
        max: bpmChanges.at(imports.tail.beat).time,
    }

    const st = {
        min: timeScaleChanges.at(t.min).scaledTime,
        max: timeScaleChanges.at(t.max).scaledTime,
        tick: timeScaleChanges.at(targetTime).scaledTime,
    }

    const progress = Math.unlerpClamped(st.min, st.max, st.tick)
    const scaleL = ease(attachImport.easeL, progress)
    const scaleR = ease(attachImport.easeR, progress)
    const l = Math.lerp(
        imports.head.lane - imports.head.size,
        imports.tail.lane - imports.tail.size,
        scaleL,
    )
    const r = Math.lerp(
        imports.head.lane + imports.head.size,
        imports.tail.lane + imports.tail.size,
        scaleR,
    )

    return {
        lane: (l + r) / 2,
        size: (r - l) / 2,
    }
}
