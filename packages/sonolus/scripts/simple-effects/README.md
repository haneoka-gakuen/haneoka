# effect001Simple note effects

Builds `packages/sonolus/assets/simple-effects/particle.{data,texture.png}`: the game's "Simple" note effects
(`effect001simple` prefabs and judgement clips) as native Sonolus particles, plus the engine table
`.dependencies/sonolus-our-notes/shared/src/engine/data/nativeHitFxNames.generated.ts`.

Inputs are dumps of the decrypted Android bundles (`effect_assets_effect_live_noteeffect_effect001simple_*`,
decrypted with `scripts/ingest/bundle_crypto.py`): prefab hierarchies, particle systems, materials, textures and
animator clips, as written by the dump step (`full.py` in the effect research workspace) under
`out/effect001simple/<prefab>/`, with `transform_ids.json` mapping transform path ids to node paths. Paths in
`simple.py`, `simple2.py` and `gsim.py` point at that workspace; adjust them before rebuilding.

    python3 simple2.py OUT_DIR ENGINE_REPO   # needs numpy, scipy, pillow

- `gsim.py` simulates the prefab emitters (shapes, rate over time/distance, clip-animated nodes, rotations,
  limit velocity on own velocity only, separate-axis size, colour over lifetime, SetWidth rules).
- `simple.py` builds the frame (uniform strip + corner caps), the wall and the ground dot bursts (native random
  draws); `simple2.py` converts every other simulated particle into native particles and writes the pack.
- Camera: LiveGameCamera (0, 10, 0), pitch 29.6045 deg, vertical FOV 54; the projection is baked into each
  part's effect transform, so the engine spawns parts on (note centre, note width).
