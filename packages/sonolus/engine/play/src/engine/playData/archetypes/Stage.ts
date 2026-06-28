import { perspectiveLayout } from '../../../../../shared/src/engine/data/utils.js'
import {
    laneBase,
    nativeLaneEffectLifetime,
    nativeJudgmentLineHalfHeight,
    nativeStage,
    projectLaneZ,
} from '../../../../../shared/src/engine/data/lane.js'
import { options } from '../../configuration/options.js'
import { effect, sfxDistance } from '../effect.js'
import { getHitbox, lane } from '../lane.js'
import { particle } from '../particle.js'
import { layer, skin } from '../skin.js'
import { canEmpty } from './InputManager.js'

export class Stage extends Archetype {
    hitbox = this.entityMemory(Rect)
    slotHitbox = this.entityMemory(Rect)

    spawnOrder() {
        return 1
    }

    shouldSpawn() {
        return entityInfos.get(0).state === EntityState.Despawned
    }

    initialize() {
        getHitbox({ l: lane.hitbox.l, r: lane.hitbox.r, leniency: 0 }).copyTo(this.hitbox)
        getHitbox({ l: lane.slots.l, r: lane.slots.r, leniency: 0 }).copyTo(this.slotHitbox)
    }

    touchOrder = 2
    touch() {
        for (const touch of touches) {
            if (!this.hitbox.contains(touch.position)) continue
            if (!canEmpty(touch)) continue

            if (touch.started) {
                this.onEmptyStart(touch)
            } else {
                this.onEmptyMove(touch)
            }
        }
    }

    updateParallel() {
        // lane_base is the authored Unity stage mesh baked into the native
        // skin. A generic six-lane PJS stage has different perspective and
        // must not be presented as an approximation when that asset is absent.
        if (skin.sprites.sekaiStage.exists) this.drawSekaiStage()

        this.drawLaneDetails()
    }

    onEmptyStart(touch: Touch) {
        this.playEmptyEffects(this.xToL(touch.position.x))
    }

    onEmptyMove(touch: Touch) {
        const l = this.xToL(touch.position.x)
        const oldL = this.xToL(touch.lastPosition.x)
        if (l === oldL) return

        this.playEmptyEffects(l)
    }

    xToL(x: number) {
        return Math.clamp(
            Math.floor(Math.unlerp(this.slotHitbox.l, this.slotHitbox.r, x) * 12 - 6),
            -6,
            5,
        )
    }

    playEmptyEffects(l: number) {
        streams.set(-9999, time.now, 0)
        streams.set(l, time.now, 0)

        if (options.sfxEnabled) this.playEmptySFX()
        if (options.laneEffectEnabled) this.playEmptyLaneEffects(l)
    }

    playEmptySFX() {
        effect.clips.stage.play(sfxDistance)
    }

    playEmptyLaneEffects(l: number) {
        particle.effects.laneInVain.spawn(
            perspectiveLayout({ l, r: l + 1, b: lane.b, t: lane.t }),
            nativeLaneEffectLifetime,
            false,
        )
    }

    drawSekaiStage() {
        skin.sprites.sekaiStage.draw(
            new Rect(laneBase.layout),
            [layer.stage],
            laneBase.materialOpacity * options.laneOpacity,
        )
    }

    drawLaneDetails() {
        this.drawGuidelines()
        this.drawTapArea()
        this.drawJudgmentLine()
    }

    drawTapArea() {
        if (!skin.sprites.laneTapArea.exists) return

        const halfWidth = (nativeStage.tapAreaWidth / nativeStage.laneWidth) * 6
        const halfLength = nativeStage.tapAreaLength / 2
        const innerHalfLength = halfLength - nativeStage.tapAreaBorder
        const borderX = (nativeStage.tapAreaBorder / nativeStage.laneWidth) * 12
        const x0 = -halfWidth
        const x1 = x0 + borderX
        const x2 = halfWidth - borderX
        const x3 = halfWidth
        const y0 = projectLaneZ(nativeStage.judgmentZ + halfLength)
        const y1 = projectLaneZ(nativeStage.judgmentZ + innerHalfLength)
        const y2 = projectLaneZ(nativeStage.judgmentZ - innerHalfLength)
        const y3 = projectLaneZ(nativeStage.judgmentZ - halfLength)

        if (
            !skin.sprites.laneTapAreaTopLeft.exists ||
            !skin.sprites.laneTapAreaTop.exists ||
            !skin.sprites.laneTapAreaTopRight.exists ||
            !skin.sprites.laneTapAreaLeft.exists ||
            !skin.sprites.laneTapAreaCenter.exists ||
            !skin.sprites.laneTapAreaRight.exists ||
            !skin.sprites.laneTapAreaBottomLeft.exists ||
            !skin.sprites.laneTapAreaBottom.exists ||
            !skin.sprites.laneTapAreaBottomRight.exists
        ) {
            skin.sprites.laneTapArea.draw(
                perspectiveLayout({ l: x0, r: x3, b: y3, t: y0 }),
                [layer.tapArea],
                options.laneOpacity,
            )
            return
        }

        this.drawTapAreaPart(skin.sprites.laneTapAreaTopLeft, x0, x1, y1, y0)
        this.drawTapAreaPart(skin.sprites.laneTapAreaTop, x1, x2, y1, y0)
        this.drawTapAreaPart(skin.sprites.laneTapAreaTopRight, x2, x3, y1, y0)
        this.drawTapAreaPart(skin.sprites.laneTapAreaLeft, x0, x1, y2, y1)
        this.drawTapAreaPart(skin.sprites.laneTapAreaCenter, x1, x2, y2, y1)
        this.drawTapAreaPart(skin.sprites.laneTapAreaRight, x2, x3, y2, y1)
        this.drawTapAreaPart(skin.sprites.laneTapAreaBottomLeft, x0, x1, y3, y2)
        this.drawTapAreaPart(skin.sprites.laneTapAreaBottom, x1, x2, y3, y2)
        this.drawTapAreaPart(skin.sprites.laneTapAreaBottomRight, x2, x3, y3, y2)
    }

    drawTapAreaPart(sprite: SkinSprite, l: number, r: number, b: number, t: number) {
        sprite.draw(perspectiveLayout({ l, r, b, t }), [layer.tapArea], options.laneOpacity)
    }

    drawJudgmentLine() {
        if (!options.showJudgmentLine || !skin.sprites.nativeJudgmentLine.exists) return

        const halfWidth = (nativeStage.judgmentLineWidth / nativeStage.laneWidth) * 6
        skin.sprites.nativeJudgmentLine.draw(
            new Rect({
                l: -halfWidth,
                r: halfWidth,
                b: 1 + nativeJudgmentLineHalfHeight,
                t: 1 - nativeJudgmentLineHalfHeight,
            }),
            [layer.guideline],
            options.guidelineOpacity,
        )
    }

    drawGuidelines() {
        if (!skin.sprites.guideline.exists || options.guidelineOpacity <= 0) return

        const count =
            options.guidelineCount === 1
                ? 4
                : options.guidelineCount === 2
                  ? 6
                  : options.guidelineCount === 3
                    ? 8
                    : options.guidelineCount === 4
                      ? 12
                      : 0
        const mainDivisor = count ? 24 / count : 0
        const spaceDivisor = count <= 6 ? 2 : 0

        for (let index = 1; index < 24; index++) {
            const main = mainDivisor > 0 && index % mainDivisor === 0
            const space = !main && spaceDivisor > 0 && index % spaceDivisor === 0
            if (!main && !space) continue

            const x = index / 2 - 6
            if (space) {
                const halfWidth = (0.15 / nativeStage.laneWidth) * 6
                const halfLength = 1.3 / 2
                skin.sprites.guidelineSpace.draw(
                    perspectiveLayout({
                        l: x - halfWidth,
                        r: x + halfWidth,
                        b: projectLaneZ(nativeStage.judgmentZ - halfLength),
                        t: projectLaneZ(nativeStage.judgmentZ + halfLength),
                    }),
                    [layer.guideline],
                    options.guidelineOpacity * 0.5019608,
                )
            } else {
                this.drawFullLaneLine(x, 0.15, 0.3, options.guidelineOpacity)
            }
        }

        const outsideX = 6 + (nativeStage.outsideLineWidth / 2 / nativeStage.laneWidth) * 12
        this.drawOutsideLine(-outsideX, options.guidelineOpacity)
        this.drawOutsideLine(outsideX, options.guidelineOpacity)
    }

    drawFullLaneLine(x: number, nearWidth: number, farWidth: number, alpha: number) {
        const nearHalfWidth = (nearWidth / 2 / nativeStage.laneWidth) * 12
        const farHalfWidth = (farWidth / 2 / nativeStage.laneWidth) * 12
        skin.sprites.guideline.draw(
            new Quad({
                x1: x - nearHalfWidth,
                x2: (x - farHalfWidth) * lane.t,
                x3: (x + farHalfWidth) * lane.t,
                x4: x + nearHalfWidth,
                y1: 1,
                y2: lane.t,
                y3: lane.t,
                y4: 1,
            }),
            [layer.guideline],
            alpha,
        )
    }

    drawOutsideLine(x: number, alpha: number) {
        if (!skin.sprites.outsideLine.exists) return

        const halfWidth = (nativeStage.outsideLineWidth / 2 / nativeStage.laneWidth) * 12
        skin.sprites.outsideLine.draw(
            new Quad({
                x1: x - halfWidth,
                x2: (x - halfWidth) * lane.t,
                x3: (x + halfWidth) * lane.t,
                x4: x + halfWidth,
                y1: 1,
                y2: lane.t,
                y3: lane.t,
                y4: 1,
            }),
            [layer.guideline],
            alpha,
        )
    }
}
