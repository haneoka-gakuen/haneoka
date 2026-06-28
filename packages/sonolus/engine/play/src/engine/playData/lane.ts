import { lane as _lane } from '../../../../shared/src/engine/data/lane.js'
import { skin } from './skin.js'

// ScreenTouchInputProvider expands the first/last judgement-position centers
// by max(master offset X) * 100 = 300 screen pixels. Sonolus exposes no device
// pixel resolution, so preserve the authored 1920 x 1080 reference
// viewport. One local lane unit is 126.92395667992498 px there.
const nativeProviderMarginX = 300 / 126.92395667992498

export const lane = {
    ..._lane,

    hitbox: {
        l: -5.75 - nativeProviderMarginX,
        r: 5.75 + nativeProviderMarginX,
    },

    slots: {
        l: -6,
        r: 6,
    },
}

/**
 * LiveJudgementAreaOffsetSettings.GetJudgementAreaOffset, assist level 0.
 * Native offsets use 24-lane chart coordinates while Sonolus uses 12 units,
 * hence the division already reflected in these returned values.
 */
export const getNativeJudgmentLeniency = ({
    operateType,
    originalCritical,
    originalSize,
}: {
    operateType: number
    originalCritical: number
    originalSize: number
}) => {
    // Normal: Default / EasyDefault.
    if (operateType === 1) return originalCritical ? 1.4 : 0.5

    // SlideBegin: SlideBegin / EasySlideBegin.
    if (operateType === 20) return originalCritical ? 1.4 : 1

    // Slide: 2 at width 4, decreasing linearly to 1 at width 5.
    if (operateType === 21 || operateType === 120)
        return Math.lerp(1, 0.5, Math.unlerpClamped(4, 5, originalSize))

    // SlideEnd and ordinary flick constructors.
    if (operateType === 22 || operateType === 40 || operateType === 41 || operateType === 42)
        return 1.5

    // Trace and hidden trace-backed nodes.
    if (
        operateType === 60 ||
        operateType === 61 ||
        operateType === 62 ||
        operateType === 63 ||
        operateType === 80 ||
        operateType === 82 ||
        operateType === 104 ||
        operateType === 105
    )
        return 1.4

    // GuideBeginFlick (102) deliberately receives Default in the native ctor.
    return 0.5
}

export const getHitbox = ({ l, r, leniency }: { l: number; r: number; leniency: number }) => {
    const hitbox = new Rect({
        l: l - leniency,
        r: r + leniency,
        b: 0,
        t: 0,
    }).transform(skin.transform)

    // ScreenTouchInputProvider.GetJudgmentLane rejects Y only beyond the
    // master-data maximum. Assist level 0 stores 9999 for every Y offset and
    // the native constructor multiplies it by 100, so gameplay input is
    // effectively unrestricted vertically. Clamp to the actual Sonolus
    // viewport instead of the old PJS judgment-strip approximation.
    hitbox.b = screen.b
    hitbox.t = screen.t

    return hitbox
}
