# CPU card screenshot recognition

This processor proposes card identities and visible levels from uploaded images.
It does not download images, call a multimodal service, or save an account inventory.
The web adapter owns authentication, private uploads, cancellation and confirmation.

Use Python 3.11 or later and install `requirements.txt` in a virtual environment.
Keep reference thumbnails in a content-addressed cache. Supply an index whose
identity matches the selected server and release; there is no built-in gallery.

```sh
python scripts/recognize/card_inventory.py \
  --request /work/job/request.json --job-root /work/job \
  --reference-index /cache/release/index.json --reference-root /cache/release \
  --cache-root /cache/card-features --output /work/job/recognition.json
```

Request:

```json
{
  "schema": "haneoka-card-recognition-request-v1",
  "identity": {"server": "intl", "releaseId": "r-00000000000000000000"},
  "images": [{"id": "image0", "path": "inputs/image0.png"}]
}
```

The example release ID is a placeholder. The serving adapter must resolve and
pin the actual current release. Each image may include a `sha256`, a `kind`
(`members` or `snapshots`) and a crop `{x,y,width,height}` in EXIF-normalized
original pixels. Paths are relative to the private job directory. PNG, JPEG and
WebP are supported; the adapter can convert other formats before invocation.
Limits are 16 images, 16 MiB and 8 million pixels per image, 32 million pixels per
job, and 1024 observations. Enforce a subprocess deadline and queue limits too.

The reference index has schema `haneoka-card-recognition-index-v1`, an `identity`,
and `references` with `kind`, `cardId`, `variant`, relative `path` and exact PNG
`sha256`. There may be several variants of one card. Matching combines variants
before comparing the best two distinct card entities. Reference files must be
inside the supplied reference root; missing or changed files fail the job.

An optional `levelReader` supplies native `glyphs` as binary strings for 0–9,
L/v/period, and `allowedLevels` for each kind. If it is absent, levels are unknown.
The glyph recognizer checks the Lv prefix, white glyph geometry, competing digit
scores and threshold agreement. Weak, conflicting or cut text is rejected.
Training, awakening and skill levels remain unknown in this version.

Output has schema `haneoka-card-recognition-result-v1`: `identity`, `images`,
`observations`, `entities`, `warnings`, `engine` and `stats`. Observations carry
source image ID, bounding box, candidates, scores and nullable field values.
Bounding boxes use EXIF-normalized original pixels, including when the processor
internally downsamples. Scores are geometric evidence and similarity, not
probabilities. No private filesystem paths or image bodies are returned.

Entities aggregate observations by `(server, kind, cardId)`. Unknown IDs remain
observations for correction. A known level and an unknown observation retain the
known suggestion; different known readings yield `conflict`, a null value, and
candidate values. This is evidence aggregation, not an inventory update. The
caller must confirm proposals and preserve existing values for unknown fields.

`build_index.py` projects source thumbnails, their hashes, native level glyphs
and legal ranges from an existing selected build. It never re-extracts a package.
Its normal source artifact carries `server`/`sourceId`, not `releaseId`: embedding
the final release ID before hashing the release would be self-referential.
After selecting a real release, the serving adapter wraps that source artifact
with the actual release identity and fetches only verified thumbnails from its
release entries/CAS. Generated source/index/glyph data belong in deployment
artifacts and caches, not Git.

```sh
python scripts/recognize/build_index.py \
  --build-root /selected/build --server intl --output /staging/source.json
```

Feature files are keyed by thumbnail hash, OpenCV/Pillow versions and SIFT
parameters. Repeated images are recognized once per job. Content-identical
reference variants are deduplicated; no card ID list or user-specific templates
are part of the processor.

To ship card identity recognition before optional level assets are available, pass
`--without-levels` to the source projector. It needs only the selected source
index and two canonical card catalogs. Missing local thumbnail files do not block
projection: hashes are taken from verified source metadata and the serving cache
fetches those exact thumbnails later. Optional font/binding/level-range failures
produce `levelReader: null` and a bounded status, while card references remain.
