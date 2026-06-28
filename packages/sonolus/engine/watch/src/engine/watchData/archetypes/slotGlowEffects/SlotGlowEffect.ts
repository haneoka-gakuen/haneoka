// Kept as an inert replay archetype so old level data remains loadable without
// rendering the unrelated PJS slot glow.
export abstract class SlotGlowEffect extends SpawnableArchetype({
    startTime: Number,
    lane: Number,
    size: Number,
}) {
    abstract sprite: SkinSprite

    spawnTime() {
        return timeScaleChanges.at(this.spawnData.startTime).scaledTime
    }

    despawnTime() {
        return this.spawnTime()
    }
}
