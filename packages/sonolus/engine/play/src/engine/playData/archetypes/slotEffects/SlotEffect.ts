// Kept as a no-op archetype for level-data compatibility. The former
// implementation drew PJS-style rectangular slots that have no Our Notes
// source counterpart.
export abstract class SlotEffect extends SpawnableArchetype({
    startTime: Number,
    lane: Number,
}) {
    abstract sprite: SkinSprite

    initialize() {
        this.despawn = true
    }
}
