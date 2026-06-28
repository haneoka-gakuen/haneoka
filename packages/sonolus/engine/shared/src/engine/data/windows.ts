export type Windows = {
    perfect: Range
    great: Range
    good: Range
    bad: Range
    miss: Range
    input: Range
}

const ms = (before: number, after = before) => new Range(-before / 1000, after / 1000)

export const toBucketWindows = (windows: Windows) => ({
    perfect: new Range(Math.round(windows.perfect.min * 1000), Math.round(windows.perfect.max * 1000)),
    great: new Range(Math.round(windows.great.min * 1000), Math.round(windows.great.max * 1000)),
    good: new Range(Math.round(windows.good.min * 1000), Math.round(windows.good.max * 1000)),
})

// MasterLiveJudgementTiming, assist level 0. Sonolus exposes only
// Perfect/Great/Good/Miss, but keeping Bad and the complete input range here
// lets the play archetypes reproduce the original timing boundaries and map
// the unsupported Bad result explicitly.
const normal = {
    perfect: ms(42),
    great: ms(83),
    good: ms(108),
    bad: ms(125),
    miss: ms(130),
    input: ms(130),
}

const flick = {
    perfect: ms(83, 58),
    great: ms(83, 83),
    good: ms(83, 108),
    bad: ms(83, 125),
    miss: ms(83, 130),
    input: ms(83, 130),
}

const slideEnd = {
    perfect: ms(42, 66),
    great: ms(99, 166),
    good: ms(124, 191),
    bad: ms(141, 208),
    // MasterLiveJudgementTiming stores Miss itself as symmetric +/-150 ms.
    // Late Bad remains valid to +208 ms, so input has its own outer range.
    miss: ms(150),
    input: ms(150, 208),
}

const easy = {
    perfect: ms(58, 66),
    great: ms(58, 66),
    good: ms(58, 66),
    bad: ms(58, 66),
    miss: ms(58, 130),
    input: ms(58, 130),
}

const trace = {
    perfect: ms(58, 66),
    great: ms(58, 66),
    good: ms(58, 66),
    bad: ms(58, 66),
    miss: ms(58, 130),
    input: ms(58, 130),
}

export const windows = {
    tapNote: { normal, critical: easy },
    flickNote: { normal: flick, critical: flick },
    traceNote: { normal: trace, critical: trace },
    traceFlickNote: { normal: flick, critical: flick },
    slideTraceNote: { normal: trace, critical: trace },
    slideStartNote: { normal, critical: easy },
    slideEndNote: { normal: slideEnd, critical: slideEnd },
    slideEndTraceNote: { normal: trace, critical: trace },
    slideEndFlickNote: { normal: flick, critical: flick },
    slideEndLockoutDuration: 0.25,
}
