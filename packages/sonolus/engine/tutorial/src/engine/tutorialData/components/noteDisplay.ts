import { approach, note } from '../../../../../shared/src/engine/data/note.js'
import { perspectiveLayout } from '../../../../../shared/src/engine/data/utils.js'
import { segment } from '../segment.js'
import { layer, skin } from '../skin.js'

const noteSprites = {
    normal: {
        left: skin.sprites.normalNoteLeft,
        middle: skin.sprites.normalNoteMiddle,
        right: skin.sprites.normalNoteRight,
    },
    trace: {
        left: skin.sprites.normalTraceNoteLeft,
        middle: skin.sprites.normalTraceNoteMiddle,
        right: skin.sprites.normalTraceNoteRight,
    },
    traceFlick: {
        left: skin.sprites.traceFlickNoteLeft,
        middle: skin.sprites.traceFlickNoteMiddle,
        right: skin.sprites.traceFlickNoteRight,
    },
    slide: {
        left: skin.sprites.slideNoteLeft,
        middle: skin.sprites.slideNoteMiddle,
        right: skin.sprites.slideNoteRight,
    },
    slideEnd: {
        left: skin.sprites.slideEndNoteLeft,
        middle: skin.sprites.slideEndNoteMiddle,
        right: skin.sprites.slideEndNoteRight,
    },
    flick: {
        left: skin.sprites.flickNoteLeft,
        middle: skin.sprites.flickNoteMiddle,
        right: skin.sprites.flickNoteRight,
    },
    flickEnd: {
        left: skin.sprites.flickNoteLeft,
        middle: skin.sprites.flickNoteMiddle,
        right: skin.sprites.flickNoteRight,
    },
}

enum Mode {
    None,
    Overlay,
    Fall,
    Frozen,
}

let mode = tutorialMemory(DataType<Mode>)
let available = tutorialMemory(Boolean)

const ids = tutorialMemory({
    left: SkinSpriteId,
    middle: SkinSpriteId,
    right: SkinSpriteId,
})

export const noteDisplay = {
    update() {
        if (!mode) return
        if (!available) return

        if (mode === Mode.Overlay) {
            const a = Math.unlerpClamped(1, 0.75, segment.time)

            const l = -3
            const r = 3

            const ml = l + 0.6
            const mr = r - 0.6

            const t = 0.5 - note.h * 3
            const b = 0.5 + note.h * 3

            skin.sprites.draw(ids.left, new Rect({ l, r: ml, t, b }), [layer.note.body], a)
            skin.sprites.draw(
                ids.middle,
                new Rect({ l: ml, r: mr, t, b }),
                [layer.note.body],
                a,
            )
            skin.sprites.draw(ids.right, new Rect({ l: mr, r, t, b }), [layer.note.body], a)
        } else {
            const y = mode === Mode.Fall ? approach(0, 2, segment.time) : 1

            const l = -2
            const r = 2

            const ml = l + 0.3
            const mr = r - 0.3

            const t = 1 - note.h
            const b = 1 + note.h

            skin.sprites.draw(
                ids.left,
                perspectiveLayout({ l, r: ml, t, b }).mul(y),
                [layer.note.body],
                1,
            )
            skin.sprites.draw(
                ids.middle,
                perspectiveLayout({ l: ml, r: mr, t, b }).mul(y),
                [layer.note.body],
                1,
            )
            skin.sprites.draw(
                ids.right,
                perspectiveLayout({ l: mr, r, t, b }).mul(y),
                [layer.note.body],
                1,
            )
        }
    },

    showOverlay(type: keyof typeof noteSprites) {
        mode = Mode.Overlay
        this.setType(type)
    },

    showFall(type: keyof typeof noteSprites) {
        mode = Mode.Fall
        this.setType(type)
    },

    showFrozen(type: keyof typeof noteSprites) {
        mode = Mode.Frozen
        this.setType(type)
    },

    clear() {
        mode = Mode.None
    },

    setType(type: keyof typeof noteSprites) {
        available = false

        for (const [key, sprites] of Object.entries(noteSprites)) {
            if (key !== type) continue
            if (!sprites.left.exists || !sprites.middle.exists || !sprites.right.exists) continue

            available = true
            ids.left = sprites.left.id
            ids.middle = sprites.middle.id
            ids.right = sprites.right.id
        }
    },
}
