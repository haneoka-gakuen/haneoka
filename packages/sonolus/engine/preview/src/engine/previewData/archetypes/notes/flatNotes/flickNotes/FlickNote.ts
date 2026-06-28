import { FlickDirection } from '../../../../../../../../shared/src/engine/data/FlickDirection.js'
import {
    getPreviewArrowLayout,
    getArrowSpriteId,
} from '../../../../../../../../shared/src/engine/data/arrowSprites.js'
import { options } from '../../../../../configuration/options.js'
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

    flickImport = this.defineImport({
        direction: { name: 'direction', type: DataType<FlickDirection> },
    })

    preprocess() {
        super.preprocess()

        if (options.mirror) this.flickImport.direction *= -1
    }

    render() {
        const { time, pos } = super.render()

        const z = getZ(layer.note.arrow, time, this.import.lane)

        const arrowSpriteId = getArrowSpriteId(
            this.arrowSprites,
            this.import.size,
            this.flickImport.direction,
        )

        if (skin.sprites.exists(arrowSpriteId)) {
            skin.sprites.draw(
                arrowSpriteId,
                getPreviewArrowLayout(
                    this.import.size,
                    this.flickImport.direction,
                    this.import.lane,
                    0,
                    scaledScreen.wToH,
                ).add(pos),
                [z],
                1,
            )
        }

        return { time, pos }
    }

    renderBody(l: number, r: number, b: number, t: number, pos: Vec, z: number) {
        const ml = l + 0.3
        const mr = r - 0.3

        if (
            this.flickImport.direction === FlickDirection.Left &&
            skin.sprites.flickLeftNoteLeft.exists &&
            skin.sprites.flickLeftNoteMiddle.exists &&
            skin.sprites.flickLeftNoteRight.exists
        ) {
            skin.sprites.flickLeftNoteLeft.draw(new Rect({ l, r: ml, b, t }).add(pos), [z], 1)
            skin.sprites.flickLeftNoteMiddle.draw(
                new Rect({ l: ml, r: mr, b, t }).add(pos),
                [z],
                1,
            )
            skin.sprites.flickLeftNoteRight.draw(new Rect({ l: mr, r, b, t }).add(pos), [z], 1)
        } else if (
            this.flickImport.direction === FlickDirection.Right &&
            skin.sprites.flickRightNoteLeft.exists &&
            skin.sprites.flickRightNoteMiddle.exists &&
            skin.sprites.flickRightNoteRight.exists
        ) {
            skin.sprites.flickRightNoteLeft.draw(new Rect({ l, r: ml, b, t }).add(pos), [z], 1)
            skin.sprites.flickRightNoteMiddle.draw(
                new Rect({ l: ml, r: mr, b, t }).add(pos),
                [z],
                1,
            )
            skin.sprites.flickRightNoteRight.draw(new Rect({ l: mr, r, b, t }).add(pos), [z], 1)
        } else {
            super.renderBody(l, r, b, t, pos, z)
        }
    }
}
