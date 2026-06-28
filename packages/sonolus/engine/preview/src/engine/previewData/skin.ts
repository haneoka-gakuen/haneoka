import { SkinSpriteName } from '@sonolus/core'
import { panel } from './panel.js'

export const skin = defineSkin({
    sprites: {
        previewStage: 'Our Notes Preview Stage',
        previewBorder: 'Our Notes Preview Border',
        previewDivider: 'Our Notes Preview Divider',

        simLine: 'Our Notes Simultaneous Line',
        normalNoteLeft: 'Our Notes Note Cyan Left',
        normalNoteMiddle: 'Our Notes Note Cyan Middle',
        normalNoteRight: 'Our Notes Note Cyan Right',
        normalNoteFallback: SkinSpriteName.NoteHeadCyan,

        slideNoteLeft: 'Our Notes Note Green Left',
        slideNoteMiddle: 'Our Notes Note Green Middle',
        slideNoteRight: 'Our Notes Note Green Right',
        slideNoteFallback: SkinSpriteName.NoteHeadGreen,
        slideNoteEndFallback: SkinSpriteName.NoteTailGreen,

        flickNoteLeft: 'Our Notes Note Red Left',
        flickNoteMiddle: 'Our Notes Note Red Middle',
        flickNoteRight: 'Our Notes Note Red Right',
        flickNoteFallback: SkinSpriteName.NoteHeadRed,
        flickNoteEndFallback: SkinSpriteName.NoteTailRed,

        flickLeftNoteLeft: 'Our Notes Note Red Leftward Left',
        flickLeftNoteMiddle: 'Our Notes Note Red Leftward Middle',
        flickLeftNoteRight: 'Our Notes Note Red Leftward Right',
        flickRightNoteLeft: 'Our Notes Note Red Rightward Left',
        flickRightNoteMiddle: 'Our Notes Note Red Rightward Middle',
        flickRightNoteRight: 'Our Notes Note Red Rightward Right',

        criticalNoteLeft: 'Our Notes Note Yellow Left',
        criticalNoteMiddle: 'Our Notes Note Yellow Middle',
        criticalNoteRight: 'Our Notes Note Yellow Right',
        criticalNoteFallback: SkinSpriteName.NoteHeadYellow,
        criticalNoteEndFallback: SkinSpriteName.NoteTailYellow,

        traceFlickNoteLeft: 'Our Notes Trace Note Red Left',
        traceFlickNoteMiddle: 'Our Notes Trace Note Red Middle',
        traceFlickNoteRight: 'Our Notes Trace Note Red Right',
        traceFlickNoteDiamond: 'Our Notes Trace Diamond Red',
        traceFlickNoteFallback: SkinSpriteName.NoteTickRed,

        normalTraceNoteLeft: 'Our Notes Trace Note Green Left',
        normalTraceNoteMiddle: 'Our Notes Trace Note Green Middle',
        normalTraceNoteRight: 'Our Notes Trace Note Green Right',
        normalTraceNoteDiamond: 'Our Notes Trace Diamond Green',
        normalTraceNoteFallback: SkinSpriteName.NoteTickGreen,

        criticalTraceNoteLeft: 'Our Notes Trace Note Yellow Left',
        criticalTraceNoteMiddle: 'Our Notes Trace Note Yellow Middle',
        criticalTraceNoteRight: 'Our Notes Trace Note Yellow Right',
        criticalTraceNoteDiamond: 'Our Notes Trace Diamond Yellow',
        criticalTraceNoteFallback: SkinSpriteName.NoteTickYellow,

        normalSlideTickNote: 'Our Notes Diamond Green',
        normalSlideTickNoteFallback: SkinSpriteName.NoteTickGreen,

        criticalSlideTickNote: 'Our Notes Diamond Yellow',
        criticalSlideTickNoteFallback: SkinSpriteName.NoteTickYellow,

        normalSlideConnectorNormal: 'Our Notes Slide Connection Green',
        normalSlideConnectorFallback: SkinSpriteName.NoteConnectionGreenSeamless,

        criticalSlideConnectorNormal: 'Our Notes Slide Connection Yellow',
        criticalSlideConnectorFallback: SkinSpriteName.NoteConnectionYellowSeamless,

        normalActiveSlideConnectorNormal: 'Our Notes Active Slide Connection Green',
        normalActiveSlideConnectorFallback: SkinSpriteName.NoteConnectionGreenSeamless,

        criticalActiveSlideConnectorNormal: 'Our Notes Active Slide Connection Yellow',
        criticalActiveSlideConnectorFallback: SkinSpriteName.NoteConnectionYellowSeamless,

        flickArrowUp1: 'Our Notes Flick Arrow Red Up 1',
        flickArrowUp2: 'Our Notes Flick Arrow Red Up 2',
        flickArrowUp3: 'Our Notes Flick Arrow Red Up 3',
        flickArrowUp4: 'Our Notes Flick Arrow Red Up 4',
        flickArrowUp5: 'Our Notes Flick Arrow Red Up 5',
        flickArrowUp6: 'Our Notes Flick Arrow Red Up 6',
        flickArrowUp7: 'Our Notes Flick Arrow Red Up 7',
        flickArrowUp8: 'Our Notes Flick Arrow Red Up 8',
        flickArrowLeft1: 'Our Notes Flick Arrow Red Left 1',
        flickArrowLeft2: 'Our Notes Flick Arrow Red Left 2',
        flickArrowLeft3: 'Our Notes Flick Arrow Red Left 3',
        flickArrowLeft4: 'Our Notes Flick Arrow Red Left 4',
        flickArrowLeft5: 'Our Notes Flick Arrow Red Left 5',
        flickArrowLeft6: 'Our Notes Flick Arrow Red Left 6',
        flickArrowLeft7: 'Our Notes Flick Arrow Red Left 7',
        flickArrowLeft8: 'Our Notes Flick Arrow Red Left 8',
        flickArrowRight1: 'Our Notes Flick Arrow Red Right 1',
        flickArrowRight2: 'Our Notes Flick Arrow Red Right 2',
        flickArrowRight3: 'Our Notes Flick Arrow Red Right 3',
        flickArrowRight4: 'Our Notes Flick Arrow Red Right 4',
        flickArrowRight5: 'Our Notes Flick Arrow Red Right 5',
        flickArrowRight6: 'Our Notes Flick Arrow Red Right 6',
        flickArrowRight7: 'Our Notes Flick Arrow Red Right 7',
        flickArrowRight8: 'Our Notes Flick Arrow Red Right 8',
        flickArrowFallback: SkinSpriteName.DirectionalMarkerRed,

        criticalArrowUp1: 'Our Notes Flick Arrow Yellow Up 1',
        criticalArrowUp2: 'Our Notes Flick Arrow Yellow Up 2',
        criticalArrowUp3: 'Our Notes Flick Arrow Yellow Up 3',
        criticalArrowUp4: 'Our Notes Flick Arrow Yellow Up 4',
        criticalArrowUp5: 'Our Notes Flick Arrow Yellow Up 5',
        criticalArrowUp6: 'Our Notes Flick Arrow Yellow Up 6',
        criticalArrowUp7: 'Our Notes Flick Arrow Yellow Up 7',
        criticalArrowUp8: 'Our Notes Flick Arrow Yellow Up 8',
        criticalArrowLeft1: 'Our Notes Flick Arrow Yellow Left 1',
        criticalArrowLeft2: 'Our Notes Flick Arrow Yellow Left 2',
        criticalArrowLeft3: 'Our Notes Flick Arrow Yellow Left 3',
        criticalArrowLeft4: 'Our Notes Flick Arrow Yellow Left 4',
        criticalArrowLeft5: 'Our Notes Flick Arrow Yellow Left 5',
        criticalArrowLeft6: 'Our Notes Flick Arrow Yellow Left 6',
        criticalArrowLeft7: 'Our Notes Flick Arrow Yellow Left 7',
        criticalArrowLeft8: 'Our Notes Flick Arrow Yellow Left 8',
        criticalArrowRight1: 'Our Notes Flick Arrow Yellow Right 1',
        criticalArrowRight2: 'Our Notes Flick Arrow Yellow Right 2',
        criticalArrowRight3: 'Our Notes Flick Arrow Yellow Right 3',
        criticalArrowRight4: 'Our Notes Flick Arrow Yellow Right 4',
        criticalArrowRight5: 'Our Notes Flick Arrow Yellow Right 5',
        criticalArrowRight6: 'Our Notes Flick Arrow Yellow Right 6',
        criticalArrowRight7: 'Our Notes Flick Arrow Yellow Right 7',
        criticalArrowRight8: 'Our Notes Flick Arrow Yellow Right 8',
        criticalArrowFallback: SkinSpriteName.DirectionalMarkerYellow,

        beatLine: SkinSpriteName.GridNeutral,
        bpmChangeLine: SkinSpriteName.GridPurple,
        timeScaleChangeLine: SkinSpriteName.GridYellow,
    },
})

export const layer = {
    note: {
        arrow: 102,
        tick: 101,
        body: 100,
        trace: 99,
        connector: 98,
    },

    simLine: 90,

    line: 10,

    stage: 0,
}

export const line = (sprite: SkinSprite, beat: number, a: number) => {
    const pos = panel.getPos(bpmChanges.at(beat).time)

    sprite.draw(
        new Rect({
            l: -6,
            r: 6,
            b: -panel.h * 0.0025,
            t: panel.h * 0.0025,
        }).add(pos),
        [layer.line],
        a,
    )
}

export const getZ = (layer: number, time: number, lane: number) =>
    layer - time / 1000 - lane / 100000
