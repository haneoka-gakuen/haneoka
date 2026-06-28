import {
    laneBase,
    nativeJudgmentLineHalfHeight,
    nativeStage,
} from '../../../../../shared/src/engine/data/lane.js'
import { layer, skin } from '../skin.js'

const sprites = {
    stage: skin.sprites.sekaiStage,
    judgmentLine: skin.sprites.nativeJudgmentLine,
}

export const stage = {
    update() {
        // Tutorial uses the same authored lane_base as play/watch. Rendering
        // six unrelated PJS lane rectangles here changes the stage silhouette.
        if (!sprites.stage.exists) return

        this.drawSekaiStage()
        this.drawJudgmentLine()
    },

    drawSekaiStage() {
        sprites.stage.draw(
            new Rect(laneBase.layout),
            [layer.stage],
            // Tutorial data cannot access runtime engine options. Match the
            // fresh-user LaneOpacity default used by play and watch.
            laneBase.materialOpacity * 0.8,
        )
    },

    drawJudgmentLine() {
        if (!sprites.judgmentLine.exists) return

        const halfWidth = (nativeStage.judgmentLineWidth / nativeStage.laneWidth) * 6
        sprites.judgmentLine.draw(
            new Rect({
                l: -halfWidth,
                r: halfWidth,
                b: 1 + nativeJudgmentLineHalfHeight,
                t: 1 - nativeJudgmentLineHalfHeight,
            }),
            [layer.judgmentLine],
            1,
        )
    },
}
