export const note = {
    // Tight native body rect: tap/slide/end/flick are 79 px high.
    h: 79 / 850 / 2,
}

export const getNoteHalfHeight = (operateType: number) =>
    // Trace/guide bodies use the 59 px notes_trace_side_0 sprite.
    operateType === 60 ||
    operateType === 61 ||
    operateType === 62 ||
    operateType === 63 ||
    operateType === 104 ||
    operateType === 105
        ? 59 / 850 / 2
        : note.h

export const approach = (fromTime: number, toTime: number, now: number) =>
    // LiveNoteView.UpdatePosition: powf(1.065, (progress - 1) * 45).
    // Keep this literal in sync with the native curve; 1.06 was inherited
    // from the PJS engine and makes notes visibly too fast near the line.
    1.065 ** (45 * Math.remap(fromTime, toTime, -1, 0, now))
