// Kept as a no-op archetype for level-data compatibility. Source-derived lane
// and note particles replace the unrelated PJS slot glow.
export abstract class SlotGlowEffect extends SpawnableArchetype({
    startTime: Number,
    lane: Number,
    size: Number,
}) {
    abstract sprite: SkinSprite

    initialize() {
        this.despawn = true
    }
}
