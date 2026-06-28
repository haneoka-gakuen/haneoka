# Haneoka resource pipeline

The resource pipeline turns an authorized Android package input and its referenced remote resources into a verified, immutable Haneoka release. It is responsible for ingestion, Unity and CRI processing, catalog generation, runtime derivatives, Sonolus resources, integrity verification, Cloudflare R2 publication, retention, and garbage collection.

`scripts/pipeline.py` is the only supported command-line entry point. Implementation modules are split by stage so ingestion, resource processing, release construction, verification, and publication do not share mutable global state.

## Legal and operational prerequisites

The pipeline does not acquire entitlement to game packages, CDN resources, artwork, music, or other third-party data. Operators must provide a lawfully obtained package and any authorization they are permitted to use. Do not commit packages, authorization headers, cloud credentials, or generated release data.

Generated resources are not covered by Haneoka's root MPL-2.0 license. Review the repository [third-party notices](../THIRD_PARTY_NOTICES.md) before storing or distributing an output release.

Publication and cleanup commands modify external object storage. Run them only against an account and bucket you are authorized to administer. Maintenance commands support dry-run or verification-first workflows; preserve that safety boundary when changing them.

## Supported environment

Production uses ordinary GitHub-hosted Ubuntu runners with:

- Python 3.13;
- the direct dependency policy in `scripts/requirements.in` and the hashed transitive lock in `scripts/requirements.txt`;
- FFmpeg;
- `vgmstream-cli` r2117 for CRI HCA/ACB audio;
- Node.js 24 and the pnpm release pinned by the root `package.json` for Sonolus release builders;
- Basis Universal at commit `1aab02ba2df16ad873229030ea191ea8c10e3fc9` only when KTX2 output is requested.

macOS, self-hosted runners, and long-lived Linux hosts are not part of the production execution contract. Local development on another platform may work, but platform-specific behavior must not be assumed equivalent to the production pipeline.

## Local setup

Create an isolated Python 3.13 environment from the repository root:

```sh
python3.13 -m venv scripts/.venv
source scripts/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --require-hashes --requirement scripts/requirements.txt
```

When changing a direct Python dependency, edit `scripts/requirements.in` and regenerate the committed lock with Python 3.13 and `pip-tools`:

```sh
cd scripts
pip-compile --generate-hashes --no-emit-index-url --strip-extras --output-file=requirements.txt requirements.in
```

Renovate uses the same `pip-compile` relationship when preparing dependency PRs, and CI installs only artifacts accepted by the committed hashes.

Install FFmpeg and `vgmstream-cli` on `PATH` before running complete media stages. Install the root JavaScript workspace when building Sonolus outputs:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Verify the CLI entry point:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --help
```

Running `python3 scripts/pipeline.py` outside the virtual environment can fail with missing modules even when the repository itself is valid.

## Server configuration

Pass a server identifier with the global `--server` option before the stage command:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt <command> [options]
```

Server files live in `scripts/config/servers/` and are validated against `scripts/config/server.schema.json`. A configuration defines the package name, platform, Unity version, Unity processing shard count (`extractionShards`), R2 bucket, retention policy, authorization requirement, remote asset root, CRI key, and Master-table cryptographic parameters.

The committed `jp-cbt` configuration is Android-only and uses 32 deterministic Unity processing shards. Adding a server requires a schema-valid configuration and must not introduce secret account credentials or private authorization tokens into the repository.

## Accepted inputs

`ingest` and `run` accept one of:

- one APK containing the required Unity data;
- one APKS or XAPK archive containing `base.apk` and its splits;
- a directory containing split APK files.

All forms are normalized into the same immutable source-manifest model. A package that references a missing required asset-pack split fails explicitly; the pipeline does not treat a partial package as complete.

Ingestion records the internal CAB identity of Unity bundles. Cross-bundle Sprite and atlas references are represented as exact dependency paths in `source.json`, allowing shard jobs to fetch the dependency closure without treating dependency objects as primary members of a shard.

## Complete local run

With the virtual environment active and external tools installed:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt run \
  --input /absolute/path/to/package.apks
```

The local run ingests the package, creates a deterministic source/build identity, performs the processing and build stages, verifies the release, and locally promotes the immutable release. The selected pointer is written under `data/servers/<server>/current.json`; the root `pnpm preview` server reads that pointer.

Use `--ktx2` to request optional texture derivatives. `--publish` additionally publishes source/release data and changes external R2 state; do not add it to an exploratory local command.

For a one-time migration, `--cache` may point to a flat directory of original downloads. A cache hit requires the exact catalog filename and byte size. The resulting source identity and hashes remain identical to a fresh download.

## Command reference

Run `python scripts/pipeline.py <command> --help` for command-specific arguments.

| Command            | Responsibility                                                           |
| ------------------ | ------------------------------------------------------------------------ |
| `ingest`           | Normalize an APK, APKS/XAPK, or split-APK directory                      |
| `build-id`         | Derive a deterministic build identity for a source                       |
| `verify-source`    | Verify local source identity, sizes, and hashes                          |
| `index-source`     | Rebuild exact Unity CAB dependency metadata                              |
| `extract-master`   | Preserve byte-exact encrypted Master blobs and build decoded Master JSON |
| `extract-unity`    | Process one deterministic Unity shard                                    |
| `merge-unity`      | Merge all shards and build the Unity index/database                      |
| `extract-cri`      | Decode original and embedded CRI payloads                                |
| `build-live2d`     | Index Live2D source paths and runtime derivatives                        |
| `build-home-spots` | Build Home Spot GLB and preview derivatives                              |
| `build-api`        | Build canonical catalog documents                                        |
| `build-ktx2`       | Build optional GPU texture derivatives                                   |
| `build-sonolus`    | Build the Sonolus repository into the runtime tree                       |
| `build-release`    | Assemble and locally promote an immutable release                        |
| `run`              | Execute the complete local pipeline                                      |
| `verify-release`   | Verify a complete local release manifest                                 |
| `verify-remote`    | Verify the selected release and its R2 objects                           |
| `publish-source`   | Upload original source artifacts to the R2 content-addressed store       |
| `fetch-package`    | Fetch and hash-check a private package artifact from R2                  |
| `fetch-source`     | Restore selected source roles or one Unity shard from R2                 |
| `fetch-home-spots` | Restore only Home Spot bundles and their Unity dependency closure        |
| `publish-release`  | Upload a verified release and switch `current.json` last                 |
| `prune-sources`    | Remove source manifests not referenced by retained releases              |
| `prune-releases`   | Apply the configured immutable-release retention policy                  |
| `prune-uploads`    | Remove completed and expired resumable-upload checkpoints                |
| `gc-r2`            | Remove unreferenced content-addressed objects, with dry-run support      |

## Local data layout

Generated data is written below `data/servers/<server>/` and is intentionally excluded from Git. The important identities are:

- a source ID for the normalized package and original artifacts;
- a build ID derived from the source plus output-producing code/configuration;
- a release ID derived from public provenance and the paths, hashes, sizes, media types, and metadata of the finished output.

The selected local release follows this shape:

```text
data/servers/<server>/
  current.json
  sources/<source-id>/source.json
  builds/<build-id>/...
  releases/<release-id>/
    release.json
    api/v1/catalog/
      manifest.json
      summary.json
      <resource>/index.json
      <resource>/entities/<shard>.json
      <resource>/relations/<relation>/<shard>.json
      <resource>/views/<view>/index.json
      <resource>/views/<view>/entities/<shard>.json
    assets/...
    runtime/...
    objects/...
    game-client/
      manifest.json
      master/MasterDataSystemVersion.txt
      master/Master*.bin
      addressables/index/<00..ff>.json
    metadata/
      source-index/manifest.json
      source-index/tree.json
      source-index/sources/<shard>.json
      source-index/serialized-files/<shard>.json
      ...
```

`RESOURCE_RELEASE_ROOT` can select an explicit immutable release, and `RESOURCE_BUILD_ROOT` can select a prepared build workspace for the local preview and release builders.

## R2 JSON read models

`build-api` continues to write one canonical document per catalog resource. Those build-local documents are the source of truth for validation and future projections; they are not copied into R2 releases. During `build-release`, `scripts/build/catalog_storage.py` compiles them into the versioned `haneoka-catalog-storage-v2` read model.

The generated `api/v1/catalog/manifest.json` is the only storage contract the Worker needs for a release. It binds the model to `server` and `sourceId`, declares the partition algorithm, and describes every resource's kind, count, dependencies, index, entity shards, named views, and relation shards. `RESOURCE_SPECS` is the single pipeline registry for collection paths, stable IDs, explicit projections, dependencies, views, and relations; adding a catalog resource requires updating that registry and the canonical `CATALOG_RESOURCES` contract together.

Catalog storage has four read shapes:

- `<resource>/index.json` preserves the existing collection/document response shape while replacing large entity details with list projections where appropriate;
- `<resource>/entities/<00..ff>.json` stores complete entities, partitioned by the UTF-8 FNV-1a hash of the stable entity ID;
- `<resource>/views/<view>/index.json` and its entity shards expose independently consumable subcollections such as audio master sounds and progression tables without forcing the primary resource document to be fetched;
- `<resource>/relations/<relation>/<00..ff>.json` stores precomputed adjacency maps such as character-to-card and band-to-song, avoiding whole-catalog scans on detail pages. Relations with compact rows store projected records directly; high-fan-out voice and friendship relations store sorted entity IDs and let the Worker join the canonical entity shards, so full records are never duplicated across relation keys.

Only non-empty shards are written, and their exact names and record counts are declared in the manifest. The fixed 256-way partition keeps URLs and placement stable as more resources and servers are added. Explicit allow-list projections keep cards, support cards, songs, audio, progression, and other list-facing rows stable even when build-local enrichment grows. `summary.json` provides counts and feature state without fetching catalog indexes. The Worker exposes release-stable routes for the manifest, summary, indexes, named views, individual entities, repeated-`id` batches, and relations; cache keys include the immutable release ID. A release without the v2 manifest is read through the old monolithic adapter so Worker/frontend deployment can safely precede R2 publication.

The potentially large build-local `metadata/source-index.json` is compiled separately into a small manifest, a directly consumable tree, and FNV-partitioned `sources` and `serializedFiles` maps. Its size depends on the selected source release; `/sources/tree` therefore never loads the monolith. Individual `metadata/sources/**.json` and bundle reports remain atomic because each already represents one independently addressed Unity object; splitting inside a typetree would add joins without reducing the number of records a caller needs. `metadata/cri.json` and `metadata/live2d.json` likewise remain whole because pipeline reuse consumes each as one consistency snapshot rather than as a browser collection.

Generated files enter the release manifest and the existing CAS directly. The
publisher uploads the delta and release indexes before switching the selected
release as its final operation.

## Media processing

Original CRI payloads remain byte-identical source objects in the content-addressed store. Runtime delivery media is a reproducible projection:

- standalone ACB audio is decoded to 320 kbps MP3 for web and Sonolus playback;
- USM VP9 video is copied into WebM without video re-encoding, while embedded audio is encoded as 256 kbps Opus;
- legacy MPEG-1 video is selectively converted to H.264/MP4 with 256 kbps AAC because it cannot use the same browser delivery container;
- music-video audio is joined only through the Master-table relationships between music, video, sound, and cue-sheet records;
- WebM uses 256 kbps Opus and MP4 uses 256 kbps AAC when a decoded song track is muxed into its matching video.

`metadata/cri.json` records the binding and the ffprobe-derived `hasAudio` result. An existing build can repeat only the music-video remux pass:

```sh
PYTHONPATH=scripts python -c \
  'from pathlib import Path; from extract.cri import remux_music_videos; remux_music_videos(Path("data/servers/jp-cbt/builds/<build-id>"))'
```

Production CRI processing uses `--reuse-current`. A reusable task binds the transform identity, source-payload hash, runtime path, kind, and embedded-payload hash when applicable. Restored objects are checked again by size and SHA-256. A missing or invalid object rebuilds only that task; changing the transform identity intentionally creates a new baseline.

## Reproducibility and content addressing

Source artifacts and release outputs share an immutable SHA-256 content-addressed store:

```text
cas/v1/sha256/<first-two-hex>/<digest>
servers/<server>/sources/<source-id>/source.json
servers/<server>/releases/<release-id>/release.json
servers/<server>/releases/<release-id>/index/<00..ff>.json
servers/<server>/current.json
private/v1/package-leases/<server>/<package-digest>.json
```

The build identity includes source identity and output-producing transformations. It excludes storage location, credentials, shard count, and retention settings. The release identity is independent of the local build ID and is based on server/source provenance plus public output metadata.

The publisher reads a verified release, requires the exact source manifest to be present in R2, uploads only missing content-addressed objects, writes 256 FNV-1a path-index shards, and writes `current.json` last. The final pointer update is the atomic visibility boundary. The Worker resolves stable API and media routes through the selected release and one index shard.

The original-client contract adds a second 256-shard index beneath `game-client/addressables/index/`. Its entries reference byte-exact catalog/hash/bundle objects from the immutable source CAS rather than copying them into the release tree. Encrypted Master blobs are small release-owned objects. Local and remote verification check the Master hashes and sizes, the complete source-to-index mapping, catalog identity, shard placement, and referenced CAS object metadata. Each resource server keeps an independent release pointer under `data/servers/<server>/` and is exposed through its own `static-<server>.haneoka.org` compatibility host; adding a server does not reuse or replace another server's release namespace. Worker host parsing already follows that naming convention, while each exact custom domain remains an explicit `wrangler.jsonc` deployment allowlist entry.

## Local R2 credentials

Publication and remote verification use the S3-compatible R2 API. Configure credentials in the process environment or an approved local credential profile; never place them in a server JSON file.

| Variable                                      | Purpose                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` or `R2_ACCOUNT_ID`    | Derive the R2 endpoint                                  |
| `R2_ENDPOINT`                                 | Explicit S3-compatible endpoint override                |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | R2 S3 API credentials                                   |
| `AWS_PROFILE` or `R2_AWS_PROFILE`             | Credential profile alternative                          |
| `R2_BUCKET`                                   | Bucket override; otherwise server configuration is used |
| `RESOURCE_CDN_AUTHORIZATION`                  | Server-scoped upstream `Authorization` header value     |

Avoid verbose shell tracing around authorization or credential-bearing commands.

## GitHub Actions operation

The repository defines three related workflow files:

- `resource-pipeline.yml`: manual entry point;
- `resource-pipeline-run.yml`: source preparation, Unity matrix, and release publication;
- `resource-storage-maintenance.yml`: retention, upload cleanup, and R2 garbage collection.

Configure these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`;
- `R2_ACCESS_KEY_ID`;
- `R2_SECRET_ACCESS_KEY`.

The deployed administrator resource publisher additionally requires a Worker secret named `GITHUB_ACTIONS_TOKEN`. It is used only to dispatch the allow-listed resource workflow in this repository and should be a fine-grained token with the minimum repository Actions write permission required for that dispatch. Configure it with `pnpm wrangler secret put GITHUB_ACTIONS_TOKEN`; do not put it in `.dev.vars`, committed configuration, command output, or logs. This token is not needed for local resource processing or for manually dispatching the workflow in GitHub.

Create one GitHub Environment per committed server configuration, named `resource-<server>`. Each environment owns the same canonical `RESOURCE_CDN_AUTHORIZATION` **variable**, while its value remains server-specific. A value without a scheme is treated as legacy Basic credentials and receives the `Basic ` prefix; other authentication schemes must store the complete header value, such as `Bearer <token>`. Servers that do not require an `Authorization` header may omit the variable. The entry workflow accepts only a safe server slug backed by `scripts/config/servers/<server>.json`; the reusable workflow then binds its source-preparation job to the corresponding environment, so values and approval rules remain isolated per server. GitHub Variables are not encrypted, so workflow commands must never print this value.

Dispatch **Resource pipeline** with a server and exactly one source selector:

- `package_r2_key`: private canonical R2 CAS key of the form `cas/v1/sha256/<first-two-hex>/<digest>`;
- `source_id`: existing immutable source identity for retry/resume.

New packages are uploaded through the authenticated administrator dashboard, verified against the declared SHA-256 digest, and stored under a private R2 key before this workflow is dispatched. Resuming from `source_id` does not poll the upstream CDN; an authorized operator must decide when a remote package changed.

### Add a server or publish a package

A server exists in two deliberately separate registries: the committed JSON controls parsing, storage, and authentication requirements; the D1 row controls whether the Worker may serve or dispatch it. To add one:

1. add and review `scripts/config/servers/<server>.json` against `scripts/config/server.schema.json`;
2. create the GitHub Environment `resource-<server>` and set its server-specific `RESOURCE_CDN_AUTHORIZATION` variable when required;
3. deploy the committed configuration, then create the same slug as a draft under **Admin → Resources & publishing**;
4. verify the generated immutable prefix `servers/<server>` and activate the row.

Updating an existing server does not require another config change when its package/parser contract is unchanged. In the administrator dashboard, select the active server, choose the APK/APKS/XAPK file, enter its SHA-256 digest, complete the multipart upload, and dispatch the ready package. The Worker converts the verified upload id to its private CAS key; operators cannot supply an arbitrary download URL, workflow, repository, branch, or R2 path. Use the existing-source form only to rebuild an immutable `source_id` that is already present under that server prefix.

## Publication and maintenance

The reusable pipeline materializes and publishes the source, decodes Master
data, runs Unity processing shards, restores or builds the engine in the
release job, builds the CRI/Live2D/Home Spot/KTX2 stages, assembles the release,
and uploads the CAS delta.

Large release trees are not relayed through a multi-gigabyte GitHub artifact.
The release runner publishes its delta directly. Only the intermediate Master
and Unity shards use short-lived artifacts.

`releaseRetention` removes older release manifests and indexes. The separate
storage-maintenance workflow also prunes unreferenced sources, legacy upload
checkpoints, and CAS objects. Manual maintenance defaults to dry-run behavior;
the weekly schedule applies cleanup.

## Failure and recovery rules

- Never switch `current.json` before all referenced release/source objects and indexes are uploaded.
- A retry with the same source and transformation should reuse the same deterministic identities.
- A failed source, shard, media task, or release publication must remain observable; do not replace it with a partial success marker.
- Use `source_id` to resume an immutable source without repeating ingestion.
- Run destructive maintenance in dry-run mode first unless executing the reviewed scheduled policy.
- Do not infer package URLs, CDN authorization, or account credentials from R2 or committed configuration.

## License

Haneoka-authored pipeline code and documentation are covered by the repository [Mozilla Public License 2.0](../LICENSE). Input packages, processed third-party resources, generated media, vendor tools, and Python dependencies retain their own terms. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
