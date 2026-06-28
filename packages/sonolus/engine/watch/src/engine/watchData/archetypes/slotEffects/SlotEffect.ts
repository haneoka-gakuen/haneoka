// Kept as an inert replay archetype so old level data remains loadable without
// rendering PJS-style rectangular slots.
export abstract class SlotEffect extends SpawnableArchetype({
    startTime: Number,
    lane: Number,
}) {
    abstract sprite: SkinSprite

    spawnTime() {
        return timeScaleChanges.at(this.spawnData.startTime).scaledTime
    }

    despawnTime() {
        return this.spawnTime()
    }
}
