export const simLine = {
    // Pair-note line: a Sliced SpriteRenderer with a fixed height of
    // 0.02500000037252903 Unity units. Its progress update only replaces
    // size.x; the authored Y size remains fixed throughout the approach.
    // Notes are 0.79 Unity units high and map to 79/850 in this engine, so
    // all world-space Y values use the same /8.5 scale.
    h: 0.025 / 8.5 / 2,
}
