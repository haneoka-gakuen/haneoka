import { FlickDirection } from './FlickDirection.js'

type ArrowSprites = {
    up: { id: SkinSpriteId }[]
    left: { id: SkinSpriteId }[]
    right: { id: SkinSpriteId }[]
}

export const getArrowSpriteId = (
    arrowSprites: ArrowSprites,
    size: number,
    direction: FlickDirection,
) => {
    const index = getArrowSpriteIndex(size, direction)
    const getId = (up: SkinSpriteId, left: SkinSpriteId, right: SkinSpriteId) =>
        direction === FlickDirection.Left
            ? left
            : direction === FlickDirection.Right
              ? right
              : up

    // sonolus.js requires object/array keys to be compile-time constants.
    switch (index) {
        case 0:
            return getId(arrowSprites.up[0].id, arrowSprites.left[0].id, arrowSprites.right[0].id)
        case 1:
            return getId(arrowSprites.up[1].id, arrowSprites.left[1].id, arrowSprites.right[1].id)
        case 2:
            return getId(arrowSprites.up[2].id, arrowSprites.left[2].id, arrowSprites.right[2].id)
        case 3:
            return getId(arrowSprites.up[3].id, arrowSprites.left[3].id, arrowSprites.right[3].id)
        case 4:
            return getId(arrowSprites.up[4].id, arrowSprites.left[4].id, arrowSprites.right[4].id)
        case 5:
            return getId(arrowSprites.up[5].id, arrowSprites.left[5].id, arrowSprites.right[5].id)
        case 6:
            return getId(arrowSprites.up[6].id, arrowSprites.left[6].id, arrowSprites.right[6].id)
        default:
            return getId(arrowSprites.up[7].id, arrowSprites.left[7].id, arrowSprites.right[7].id)
    }
}

/**
 * Native LiveFlickNoteView/GetSprite thresholds. `size` is the Sonolus
 * half-width while the original comparisons use the 24-unit chart width, so
 * the compared value is `size * 4`. Exact threshold values advance to the
 * next entry because the native branch is strictly `<`.
 */
export const getArrowSpriteIndex = (size: number, direction: FlickDirection) => {
    const width = size * 4

    if (direction === FlickDirection.Up) {
        if (width < 5) return 0
        if (width < 12) return 1
        if (width < 17) return 2
        return 3
    }

    if (width < 5) return 0
    if (width < 7) return 1
    if (width < 10) return 2
    if (width < 13) return 3
    if (width < 16) return 4
    if (width < 19) return 5
    if (width < 21) return 6
    return 7
}

const getArrowWidth = (index: number, direction: FlickDirection) => {
    if (direction === FlickDirection.Up) {
        if (index === 0) return 204.84775
        if (index === 1) return 350.84778
        if (index === 2) return 479.84778
        return 602.84778
    }

    if (index === 0) return 221
    if (index === 1) return 337.923889
    if (index === 2) return 450
    if (index === 3) return direction === FlickDirection.Left ? 565 : 566
    if (index === 4) return 681
    if (index === 5) return 797
    if (index === 6) return 912
    return 1027
}

const getArrowHeight = (index: number, direction: FlickDirection) => {
    if (direction === FlickDirection.Up) {
        if (index === 0) return 236.91098
        if (index === 1) return 265.84778
        return 278
    }

    if (index === 0) return 200
    if (index === 1) return 203.8971
    return 203.9465
}

/** Tight Sprite bounds and prefab transform translated to Sonolus space. */
export const getArrowLayout = (
    size: number,
    direction: FlickDirection,
    lane: number,
    judgmentY: number,
) => {
    const index = getArrowSpriteIndex(size, direction)
    // The upper-arrow anim_root has serialized scale .8; directional arrows
    // use scale 1. Pixel-to-field conversion uses the authored 1420x850 view.
    const scale = direction === FlickDirection.Up ? 0.8 : 1
    const w = ((getArrowWidth(index, direction) * 12) / 1420 / 2) * scale
    const h = (getArrowHeight(index, direction) / 850) * scale
    // Prefab hierarchy: upper anim_root y=.35, scale=.8, child y=1;
    // directional anim_root y=0, scale=1, child y=1. At PPU=100 this places
    // the tight sprite center 1.15/1.0 world units above the note center.
    const centerOffset = ((direction === FlickDirection.Up ? 1.15 : 1) * 100) / 850

    return new Rect({ l: -w, r: w, b: h / 2, t: -h / 2 })
        .toQuad()
        // Both reference directional textures face the same way. The left
        // prefab child quaternion is (0, 0, 1, 0): 180 degrees around Z.
        .rotate(direction === FlickDirection.Left ? Math.PI : 0)
        .translate(lane, judgmentY - centerOffset)
}

/**
 * Orthographic chart-preview layout for the same native flick sprites.
 *
 * The live layout above is expressed in the 1420x850 play field. Preview Y
 * is chart time, so directly reusing its `pixel / 850` height made an arrow
 * roughly eight note bodies tall at the default panel scale, placed it below
 * the note, and vertically mirrored the upper chevron. Convert the sprite's
 * aspect into preview units through `wToH`, then place the native child-pivot
 * offset toward later time (above the note in the vertical chart).
 */
export const getPreviewArrowLayout = (
    size: number,
    direction: FlickDirection,
    lane: number,
    chartY: number,
    wToH: number,
) => {
    const index = getArrowSpriteIndex(size, direction)
    const scale = direction === FlickDirection.Up ? 0.8 : 1
    const w = ((getArrowWidth(index, direction) * 12) / 1420 / 2) * scale
    const h = ((getArrowHeight(index, direction) * 12) / 1420) * scale * wToH
    const centerOffset =
        (((direction === FlickDirection.Up ? 1.15 : 1) * 100 * 12) / 1420) *
        wToH

    return new Rect({ l: -w, r: w, b: -h / 2, t: h / 2 })
        .toQuad()
        .rotate(direction === FlickDirection.Left ? Math.PI : 0)
        .translate(lane, chartY + centerOffset)
}
