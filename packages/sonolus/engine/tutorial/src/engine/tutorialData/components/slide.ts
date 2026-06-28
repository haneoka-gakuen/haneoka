import { note } from '../../../../../shared/src/engine/data/note.js'
import { perspectiveLayout } from '../../../../../shared/src/engine/data/utils.js'
import { layer, skin } from '../skin.js'

const sprites = {
    left: skin.sprites.slideNoteLeft,
    middle: skin.sprites.slideNoteMiddle,
    right: skin.sprites.slideNoteRight,
}

let mode = tutorialMemory(Boolean)

export const slide = {
    update() {
        if (!mode) return
        if (!sprites.left.exists || !sprites.middle.exists || !sprites.right.exists) return

        const l = -2
        const r = 2

        const ml = l + 0.25
        const mr = r - 0.25

        const t = 1 - note.h
        const b = 1 + note.h

        sprites.left.draw(perspectiveLayout({ l, r: ml, t, b }), [layer.note.slide], 1)
        sprites.middle.draw(
            perspectiveLayout({ l: ml, r: mr, t, b }),
            [layer.note.slide],
            1,
        )
        sprites.right.draw(perspectiveLayout({ l: mr, r, t, b }), [layer.note.slide], 1)
    },

    show() {
        mode = true
    },

    clear() {
        mode = false
    },
}
