# Garupa live Master synchronizer

This package fetches the Japanese game server's encrypted
`SuiteMasterGetResponse`, preserves it losslessly, decodes every table
described by the current client, and builds the web projections used by
the playlist pages.

It is separate from `scripts/extract/master.py`, which handles the NFO/CBT
package format under `assets/Master/*.bin`.

## Local decode

```sh
python -m scripts.garupa_master schema-candidate \
  --dump-cs /path/to/current-apk-dump.cs \
  --output /tmp/runtime-schema.json \
  --report /tmp/runtime-schema-report.json

python -m scripts.garupa_master sync \
  --schema /tmp/runtime-schema.json \
  --request-client-version <version-read-from-the-apk> \
  --output-dir /tmp/haneoka-garupa-master \
  --projection-dir /tmp/haneoka-garupa-projections
```

The archive contains the encrypted application and Suite responses, decrypted
protobuf, the compressed Suite, one exact protobuf file per top-level Suite
field, schema-aware JSON for known fields, and coverage reports. Unknown wire
fields retain their exact encoded bytes; the complete Suite protobuf remains
the replay source.

`archiveComplete` and `schemaComplete` are separate. A successful download can
be a complete wire archive while the current client still cannot name every
server field. A partial semantic decode is never reported as complete.

The projection directory contains five deterministic JSON files:
`manifest.json`, `bands.json`, `songs.json`, `stage-challenges.json`, and
`playlists.json`. They carry Bestdori asset references but do not fetch
Bestdori while being generated.

## Automated run

The workflow runs at `16 8 * * 0`. Every run:

- downloads the latest APK/XAPK;
- reads its version only into ephemeral job state;
- generates the runtime schema from the same package;
- fetches and decodes a complete fresh Suite;
- publishes the archive, runtime schema, and projections to R2 by SHA-256.

No game version, runtime schema, pointer, or generated projection is committed
to Git. Server-reported client, data, and Master versions remain diagnostic
fields inside the archived response only; they are not compatibility gates.
There is no manual review or fallback path.

R2 layout:

```text
cas/v1/sha256/<first-two-hex>/<sha256>
garupa-master/jp/snapshots/<snapshot-id>/manifest.json
garupa-master/jp/current.json
```

The publisher uploads missing CAS objects and the immutable manifest before
replacing `current.json`. Any earlier failure leaves the last correct pointer
unchanged. The site resolves its playlist projection from that pointer through
the Worker, so repository builds do not embed a particular Master snapshot.

## Decoder bounds

Wire decoding is bounded before JSON expansion: a message may contain at most
250,000 field occurrences, one length-delimited field may contain at most
64 MiB, and one Suite may produce at most 4,096 top-level table files. The
shared decode budget also caps recursively decoded fields and packed scalar
values.
