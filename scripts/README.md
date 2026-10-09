# Haneoka resource pipeline

Builds a verified, immutable Haneoka release from an authorized Android package
and its referenced resources. The pipeline processes Unity, CRI, Live2D,
catalog, runtime, and Sonolus data and can publish releases to Cloudflare R2.

Operators must have permission to access and process every input. Do not commit
packages, credentials, authorization headers, or generated releases.

## Setup

Requirements: Python 3.13, FFmpeg, `vgmstream-cli`, Node.js 24, and pnpm.

```sh
python3.13 -m venv scripts/.venv
source scripts/.venv/bin/activate
python -m pip install --require-hashes --requirement scripts/requirements.txt
corepack enable
pnpm install --frozen-lockfile
```

Accepted inputs are an APK, an APKS/XAPK archive, or a directory containing a
complete split-APK set.

## Production package discovery

The scheduled GitHub Actions run checks jp, intl, and intl-test at
04:05, 12:05, and 20:05 Asia/Tokyo (03:05, 11:05, and 19:05 Asia/Taipei). When the publisher fingerprint
(versionCode/versionName from the mirror page) still matches the published
source's package, the run reuses the stored R2 package instead of
re-downloading from the publisher; only a real update pays that transfer. `scripts/acquire_package.py` discovers the package using the selected environment's private acquisition settings, downloads the current file, and stores it under a SHA-256 content-addressed R2 key. Package updates create new keys; large uploads use multipart transfer.

Intl package discovery reads the official website's live JSON download
configuration (`publisher-json`) using the private `sourceUrl`, `discoveryHosts`,
`urlPath` field sequence, and `downloadPattern` allowlist. It keeps the package
filename/version fingerprint independent of website script layout changes.

### Private runtime configuration

Each `scripts/config/servers/<server>.json` contains only its identity and a reference to `RESOURCE_PIPELINE_CONFIG`. Set that JSON secret in the matching `resource-<server>` GitHub Environment. It contains the validated server settings, acquisition URLs and allowlists, CRI key, Master crypto parameters, and `bundleCrypto` (`key`, `nonceSeed`). Never place these values in repository variables or browser build variables.

For local operation, use a private JSON file with mode 0600:

```sh
export RESOURCE_PIPELINE_CONFIG_FILE=/absolute/path/to/private/server.json
PYTHONPATH=scripts python -m core.config --server intl-test
```

`RESOURCE_PIPELINE_CONFIG` and `RESOURCE_PIPELINE_CONFIG_FILE` are mutually exclusive; missing, mismatched, or malformed settings fail before acquisition. CI masks private fields and diagnostics redact configured values. The `intl-test` server is included in scheduled and manual resource builds and cross-server content browsing; it is absent from the default Settings server choices. Formal JP/Intl availability takes precedence over its test-only badge.

Keep readable local copies under the ignored `.secrets/resource-pipeline/` directory. Validate and synchronize them with:

```sh
python scripts/sync_pipeline_config.py --server intl-test --check
python scripts/sync_pipeline_config.py --server intl-test
# Validate or synchronize all configured servers with --all.
```

The helper validates the private file, uploads compact JSON through standard input, and records its checksum in the local manifest. GitHub must receive a single-line secret: pretty JSON registers standalone braces and brackets as masked values, which can suppress matrix job outputs. Reusable workflow callers must explicitly forward `RESOURCE_PIPELINE_CONFIG`, including when its value comes from the selected Environment.

`probe-source` downloads only the current Addressables catalog and computes the
source identity before the expensive bundle download. A scheduled run skips the
build when both this identity and the pipeline fingerprint equal the published
release. An APK update or catalog hot update starts a new build automatically.
With `ingest --reuse`, a new source first restores every bundle name already
present in a prior published source from the R2 CAS (verified by size and
SHA-256, CDN download as fallback), so hot updates only fetch what actually
changed.

Live identity discovery using a retained package has a five-minute total limit;
package-based source probing has a ten-minute limit. A failed live catalog or
Master lookup stops that server's run and leaves its published release intact.
It does not repeat the same lookup after downloading the unchanged package.
Embedded-only servers can still fall back to inspecting their package.

Intl and intl-test read their live resource version from the Master version
service and download that exact catalog generation. This follows version jumps
and rollbacks without scanning a configured floor or requiring old catalogs to
remain published. Catalog hashes and contents still participate in the source
identity, so an update within the same version is detected. If the announced
catalog is unavailable, the run fails and retains the published release.

Their private `cdnDiscovery` block specifies the server-list endpoint, client
version, exact environment name, allowed host suffixes, and asset/Master path
suffixes. Before acquisition, `resolve-server` selects only that environment's
announced CDN/API roots, reads its live Master resource version, and checks a
32-byte catalog hash with a bounded request. It can try the announced mirror if
the first node fails. The resolved settings remain in a mode-0600 runner file;
new roots are masked in diagnostics. CDN directory changes and Master API host
changes no longer require replacing those roots in GitHub Secrets. Resuming an
immutable source explicitly with `source_id` skips live endpoint discovery.

Servers without a usable live resource-version pointer use the configured
catalog version as a floor. This fallback catalog scan
stops after three consecutive missing versions, searches at most 128 higher
build numbers on each line, and checks higher lines starting at build zero.
Larger gaps or removed floors can require a fallback configuration update;
changed version schemes or bootstrap interfaces require maintenance.
The schedule and discovery rules provide periodic update checks; they do not
guarantee that every future version can be discovered without maintenance.

### Delta builds

When only a fraction of the corpus changes — the common hot-update case — the
pipeline runs a *delta build* end to end. It is driven by one plan file that
`prepare-unity-reuse` publishes next to the per-shard reuse manifests:

- `unity-delta-plan.json` pins the base release id and, for every Unity bundle
  in the new source, either validated reuse references into the base release
  (report, object archive, media outputs) or marks it *pending* for fresh
  extraction. The plan records the extractor identity; every consumer rejects
  a plan produced by a different extractor.

Each stage then handles only what changed:

- `ingest --base-source <id>` adopts unchanged bundle records from the base
  source manifest without transferring any bytes (content, size, and catalog
  addressables must match exactly); only new or changed bundles are
  downloaded, and Unity CAB indexing parses only the local files. Local
  package-embedded copies whose size disagrees with the live catalog are
  refreshed from the CDN first, so a hot-updated bundle is never shadowed by
  the stale copy inside the package.
- Unity shard jobs fetch just their pending originals and run
  `extract-unity --delta-plan`, skipping reusable bundles entirely; shards
  with nothing pending do not run at all.
- `merge-unity --delta-plan` fetches the reusable bundles' reports from the
  base release, skips materialization and runtime projections for them, and
  adopts their descriptors after cross-checking the recomputed source
  identity.
- The CRI, Live2D, Spine, and Home Spot stages declare reusable sources,
  models, and scenes from the pinned base release documents instead of
  restoring their bytes; anything that cannot be declared is decoded,
  rendered, or rebuilt locally, restoring its inputs from CAS on demand.
- `build-release --delta-plan` composes the release manifest from the local
  delta plus the base release entries, so unchanged bytes never reach the
  runner. The composed manifest stays flat and explicit (path, sha256, bytes,
  mediaType, role per entry), which keeps the CDN, prune, and GC contracts
  unchanged.
- `publish-release` verifies the delta files locally and cross-checks every
  composed entry against the previous release manifest before uploading only
  the CAS delta and switching the pointer.

Every transfer remains hash-verified and every fallback degrades to the
full build path: if the plan is unavailable, the run proceeds exactly as
before. Because per-run verification now covers the delta plus the base
manifest identity rather than every byte, the weekly storage maintenance runs
`verify-remote` over the current release's objects in the store.

### Live server version discovery (jp)

Japanese production catalogs live behind a per-platform directory that only
the game service hands out at runtime. The `jp` configuration therefore asks
the service directly, resolves the live resource
version, and anchors every catalog and bundle download under `remoteRoot`. The
lookup needs HTTP/2 (`curl --http2-prior-knowledge`) and its endpoint is
operational configuration: supply it in the environment-scoped
`RESOURCE_PIPELINE_CONFIG` secret, never in committed files.

The international server keeps its flat `catalog_{version}.bin` layout, so it
still discovers new versions by probing. The CBT CDNs remain reachable: the
international CBT CDN currently serves without authorization, while the
Japanese CBT CDN requires its original credential (the
`RESOURCE_CDN_AUTHORIZATION` secret) — its API host answers
`UNDER_MAINTENANCE`, so the password can no longer be re-derived there.

### Credential fallback and secret refresh

The server-issued CDN password is short-lived, so it is fetched fresh on every
run and never persisted by the pipeline. When a server stops delivering one
(maintenance, shutdown), the pipeline falls back to the
`RESOURCE_CDN_AUTHORIZATION` secret, which is exactly how the CBT servers keep
building. To keep that shared secret young, the reusable workflow's
*Refresh shared CDN credential secret* step stores the credential from a
successful server lookup back into the `RESOURCE_CDN_AUTHORIZATION` repo
secret — this requires a classic PAT (or fine-grained token with **Secrets:
write**) stored as the `SECRET_WRITER_GH_TOKEN` repo secret; without it the
step just logs a notice and the pipeline proceeds with the credentials it
already resolved. `python scripts/pipeline.py --server jp cdn-credential`
prints the same report locally (set `HANEOKA_VERSION_ENDPOINT` first).

### Closed servers and data retention

When a server eventually shuts down, set `"closed": true` in its
`scripts/config/servers/*.json`. Network ingestion then refuses to run with a
pointer to the retained snapshots, while `fetch-source` and
`run --offline` keep rebuilding every release ever published — R2 sources and
releases are immutable, so closed servers lose nothing.

## Build a local release

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt run \
  --input /absolute/path/to/package.apks
```

The selected release pointer is written to
`data/servers/<server>/current.json`. Use `--ktx2` for optional texture
derivatives. `--publish` writes to remote R2 and should only be used for an
intended publication.

## Rebuild without the game CDN

An immutable source snapshot contains the original package, Addressables
catalogs, Unity bundles, and CRI payloads needed by the resource build. Once a
source exists locally, rebuild it without querying the game's CDN or R2:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server intl run \
  --offline --source <source-id>
```

Offline mode verifies that every manifest-listed local input is present and
matches its SHA-256 before any build stage starts. It does not fall back to
ingestion, a cached package, the game CDN, R2, or publication; a missing or
corrupt source fails with a restore command rather than silently downloading
anything.

To restore a source from R2 first, use a separate explicit read operation, then
run the offline build:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server intl fetch-source \
  --source <source-id>
PYTHONPATH=scripts python scripts/pipeline.py --server intl run \
  --offline --source <source-id>
```

`fetch-source` without `--role`, `--shard-index`, or `--shard-count` restores
the complete source snapshot. Use `verify-source --fast` for a quick local
presence/size inventory; `run --offline` always performs the full hash check.

Run command-specific help for all options:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --help
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt <command> --help
```

## Commands

| Command                                               | Purpose                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ingest`                                              | Normalize an APK, APKS/XAPK, or split-APK directory                                                         |
| `verify-source`                                       | Verify source sizes, hashes, and identity                                                                   |
| `index-source`                                        | Build Unity CAB dependency metadata                                                                         |
| `extract-master`                                      | Decode Master data                                                                                          |
| `extract-unity` / `merge-unity`                       | Process and merge Unity shards                                                                              |
| `extract-cri`                                         | Decode CRI media                                                                                            |
| `build-live2d`                                        | Build Live2D indexes and runtime derivatives                                                                |
| `build-home-spots`                                    | Build Home Spot models and previews                                                                         |
| `build-api`                                           | Build catalog documents                                                                                     |
| `build-ktx2`                                          | Build optional GPU texture derivatives                                                                      |
| `build-sonolus`                                       | Build Sonolus resources                                                                                     |
| `build-release`                                       | Assemble and select a local release                                                                         |
| `run`                                                 | Run the complete local pipeline; `--offline --source` rebuilds a verified local source without the game CDN |
| `verify-release` / `verify-remote`                    | Verify local or published releases                                                                          |
| `publish-source` / `publish-release`                  | Publish verified data to R2                                                                                 |
| `fetch-package` / `fetch-source` / `fetch-home-spots` | Restore stored inputs (`fetch-source` supports shard and digest filtering)                                     |
| `fetch-release-document`                              | Fetch one verified JSON document from a published release                                                        |
| `prune-sources` / `prune-releases` / `prune-uploads`  | Apply retention policies                                                                                    |
| `gc-r2`                                               | Remove unreferenced R2 objects                                                                              |

## Configuration and output

Server configuration lives in `scripts/config/servers/` and is validated
against `scripts/config/server.schema.json`. Generated data is ignored by Git
and stored under:

```text
data/servers/<server>/
  current.json
  sources/<source-id>/
  builds/<build-id>/
  releases/<release-id>/
```

Set `RESOURCE_RELEASE_ROOT` to select an immutable release directly, or
`RESOURCE_BUILD_ROOT` to use a prepared build workspace.

## R2 publication

Configure R2 through environment variables or an approved credential profile:

- `CLOUDFLARE_ACCOUNT_ID` or `R2_ACCOUNT_ID`
- `R2_ENDPOINT` when overriding the endpoint
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`
- `R2_BUCKET` when overriding the configured bucket
- `RESOURCE_CDN_AUTHORIZATION` when the selected server requires it

The publisher uploads immutable objects and indexes before switching
`current.json`. Never expose credentials in logs or shell tracing.

GitHub Actions uses `resource-pipeline.yml`, `resource-pipeline-run.yml`, and
`resource-storage-maintenance.yml`. Configure `CLOUDFLARE_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` as repository secrets. Create a
`resource-<server>` environment for each server and set its authorization value
when required.

Maintenance commands should be reviewed in dry-run mode before deleting remote
objects. Retries with the same source and transformation reuse deterministic
identities; failed stages must remain visible rather than publishing partial
success.

## License

Haneoka-authored pipeline files are licensed under [MPL-2.0](../LICENSE).
Inputs, generated resources, and third-party tools retain their own terms; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
