# Haneoka resource pipeline

Builds a verified, immutable Haneoka release from an authorized Android package
and its referenced resources. The pipeline processes Unity, CRI, Live2D,
catalog, runtime, and Sonolus data and can publish releases to Cloudflare R2.

Operators must have permission to access and process every input. Do not commit
packages, credentials, authorization headers, or generated releases.

## Static render transport and entity projections

`seal-render --inputs <frozen-manifest>` emits render manifest v2. Only shared,
unplanned files with matching path, bytes and SHA-256 may refer to verified
frozen common content. `merge-render` requires the same manifest, restores those
references and verifies the full route and client-asset sets. Without `--inputs`,
sealing emits the original fully carried v1 transport. A merge rejects mixed
transport versions. To roll back transport, omit `--inputs` from both render
commands and regenerate every partition; never publish an unverified sparse part.

Prepare captures base entity/story payloads individually in the existing input
store. Frozen rendering reads those records directly and fails on a missing or
mismatched record. Old captures do not contain these records and must be prepared
again. Reverting this change requires regenerating inputs under the reverted
source identity rather than mixing captures across revisions.

The final entity projector supplies SSR full mode and an explicit core mode.
Core mode requires a base payload from the four-resource core builder and does
not generate chart rates. Both paths share the final entity assembly; collections
reuse `catalogCollectionData`.

Offline acceptance commands (Node 24, no game input or production credentials):

```sh
node scripts/verify/static-render-transport.mjs .output/build-speed/transport.json
node scripts/verify/catalog-page-projector.mjs
node scripts/verify/frozen-entity-projection.mjs
node scripts/verify/catalog-page-snapshot.mjs
```

The transport comparison uses separate empty output trees and the same fixed
inputs. OS file caching is uncontrolled. Its compressed byte count uses a
deterministic gzip fixture encoding, not the workflow's tar.zst artifacts.
The captured f173 run in `verify/fixtures/build-speed-baseline.json` is an
observation from the supplied plan, not a controlled performance comparison.
Measure real tar.zst bytes and prepare-plus-render cost with the same released
input before attributing production savings to these changes.

## Core page snapshots

`catalog-pages.yml` follows successful complete public resource publication. It
builds the current candidate and the deployed producer's actual source commit
separately. Each execution covers jp/intl, all four core kinds and all five
locales; a locale cannot publish a partial collection or detail index. The job
checks authoritative R2 pointers again after publishing and catches up at most
three times. A continuously changing vector fails visibly rather than reporting
that a stale snapshot is current.

With the existing R2 environment and locked dependencies installed:

```sh
export PYTHONPATH=scripts
python scripts/publish/catalog_pages.py stage
export CATALOG_PAGE_RELEASE_ROOTS="$(cat .output/catalog-page-inputs/roots.json)"
STATIC_BUILD_INPUT_MODE= node scripts/build/catalog-pages.mjs --publish
python scripts/publish/catalog_pages.py check-current
```

Staging downloads catalog/metadata JSON from completed release CAS entries,
validating each size and digest. It does not download game bundles or media.
The producer requires explicit immutable local roots and does not fall back to
online current when a local dependency is missing. Inputs and source trees are
separate from generated snapshots. R2 writes use conditional creation; content,
indexes and manifest are read back before the immutable readiness object.

The scoped API adds `projection=page-data&contract=catalog-page-v1`. Discovery at
`/api/v1/servers/{server}/release` takes locale/resource and optional id; its small
descriptor gives a fixed snapshot URL and digest. Fixed reads validate the full
selector, resource release, revision and snapshot. Current reads revalidate with
ETag; immutable payloads can be cached for one year. Missing readiness returns
pending; deletion requires a verified complete index. Source failure, corrupt
page data, unsupported contract and explicit source unavailability remain
different errors. The decompressed page limit is 64 MiB and each browser request
has an eight-second timeout. Visible pages check every 60 seconds and on return
to visibility. A core change uses descriptor/body/recheck; computed data is
checked independently. Hidden, cancelled or superseded reads cannot commit.

The full build exports existing chart-rate capture records with
`publish-page-computed.mjs`; it does not recompute them in the fast job. Receipts
bind server, source, release, engine and the v6 recipe. Core snapshots remain
immutable when computations become ready. In-progress chart-player pages stay
on their existing data.

`STATIC_BUILD_INPUT_ROOT` points to the capture directory containing `capture.json`
and `content/`. Run `node scripts/build/publish-page-computed.mjs --verify-only`
to validate these real captured records and construct receipts in memory without
R2 credentials or publication. This does not verify remote bucket permissions.

`config/catalog-page-rollout.json` selects enabled kinds. A new frontend backfills
its executing projector revision before exposing the matching registration in
ASSETS. To disable adoption, deploy an empty enabledKinds list, or revert the
client integration; static first paint remains available. To roll back resource
data, use the existing verified resource-pointer rollback. The old vector selects
its retained ready snapshot; never overwrite a readiness key to simulate rollback.
Retain page snapshots and their referenced resource releases for the intended
rollback window. Existing CAS and static-document GC namespaces do not sweep
`catalog-pages/v1/`; no automatic page snapshot deletion is introduced here.

Set `PIPELINE_MEASUREMENTS_DIR` to save per-command resource measurements, and
`PIPELINE_INITIAL_CACHE` to declare the actual initial cache condition. Reports
include command/source identity, source revision, options, wall time, process
CPU and the existing stage's reported transfer/reuse fields. Missing counters
are not synthesized. Invocation identity is not a content digest of game input.
These reports are separate artifacts and do not affect release identities.

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

The scheduled GitHub Actions run checks jp and intl at
04:05, 12:05, and 20:05 Asia/Tokyo (03:05, 11:05, and 19:05 Asia/Taipei). When the publisher fingerprint
(versionCode/versionName from the mirror page) still matches the published
source's package, the run reuses the stored R2 package instead of
re-downloading from the publisher; only a real update pays that transfer. `scripts/acquire_package.py` discovers the package using the selected environment's private acquisition settings, downloads the current file, and stores it under a SHA-256 content-addressed R2 key. Package updates create new keys; large uploads use multipart transfer.

`current-package --from-server jp` (or `intl`) reads the selected base server's
latest published package identity and CAS key. It validates the source manifest
and package name before reuse. Resource and Master discovery still use the
target server; an unavailable base package stops the lookup.

Intl package discovery reads the official website's live JSON download
configuration (`publisher-json`) using the private `sourceUrl`, `discoveryHosts`,
`urlPath` field sequence, and `downloadPattern` allowlist. It keeps the package
filename/version fingerprint independent of website script layout changes.

### Private runtime configuration

Each `scripts/config/servers/<server>.json` contains only its identity and a reference to `RESOURCE_PIPELINE_CONFIG`. Set that JSON secret in the matching `resource-<server>` GitHub Environment. It contains the validated server settings, acquisition URLs and allowlists, CRI key, Master crypto parameters, and `bundleCrypto` (`key`, `nonceSeed`). Never place these values in repository variables or browser build variables.

For local operation, use a private JSON file with mode 0600:

```sh
export RESOURCE_PIPELINE_CONFIG_FILE=/absolute/path/to/private/server.json
PYTHONPATH=scripts python -m core.config --server intl
```

`RESOURCE_PIPELINE_CONFIG` and `RESOURCE_PIPELINE_CONFIG_FILE` are mutually exclusive; missing, mismatched, or malformed settings fail before acquisition. CI masks private fields and diagnostics redact configured values.

Keep readable local copies under the ignored `.secrets/resource-pipeline/` directory. Validate and synchronize them with:

```sh
python scripts/sync_pipeline_config.py --server intl --check
python scripts/sync_pipeline_config.py --server intl
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

Intl reads its live resource version from the Master version
service and downloads that exact catalog generation. This follows version jumps
and rollbacks without scanning a configured floor or requiring old catalogs to
remain published. Catalog hashes and contents still participate in the source
identity, so an update within the same version is detected. If the announced
catalog is unavailable, the run fails and retains the published release.

The private `cdnDiscovery` block specifies the server-list endpoint, client
version, exact environment name, allowed host suffixes, and asset/Master path
suffixes. Before acquisition, `resolve-server` selects only that environment's
announced CDN/API roots, reads its live Master resource version, and checks a
32-byte catalog hash with a bounded request. It can try the announced mirror if
the first node fails. The resolved settings remain in a mode-0600 runner file;
new roots are masked in diagnostics. CDN directory changes and Master API host
changes no longer require replacing those roots in GitHub Secrets. Resuming an
immutable source explicitly with `source_id` skips live endpoint discovery.
Announced asset and Master mirrors are also retained for individual downloads,
so a later object failure can recover on the peer node. Known-object HTTP 400
responses receive the normal retry budget; only exploratory catalog-version
probes treat 400 as an absent candidate. Length and hash verification remain in
place when a mirror supplies the original bytes.

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

JP's asset and Master services publish independent generations. The Master
service returns a storage path such as `1.0.0.500/<hash>`; its leading version
does not declare a minimum asset catalog version. The pipeline uses the
catalog selected by the asset service together with the verified live Master
manifest, including both content identities in the source id. Thus a Master
update can build while the asset catalog remains at `1.0.0.400`. Versioned
catalog servers such as Intl continue to select the exact catalog announced
by Master. Asset and Master version request timeouts share the existing
three-attempt retry budget.

Master can announce stamps before the selected resource catalog ships their
images. These records retain their metadata and report `assetAvailability`
instead of blocking the release. If the catalog includes the image but the
extractor failed to produce it, production builds still fail.

Download size/hash mismatches, truncated HTTP/gzip bodies, and HTTP 408/429
responses use the bounded retry budget and announced mirrors. Live Master
table downloads verify SHA-256 before accepting a transfer. Reuse candidates
whose size differs from the current catalog are skipped in favor of a fresh
download. Refreshing the shared CDN credential secret is best effort because
the active build already resolved its credential.

### Credential fallback and secret refresh

The server-issued CDN password is short-lived, so it is fetched fresh on every
run and never persisted by the pipeline. When a server stops delivering one
(maintenance, shutdown), the pipeline falls back to the
`RESOURCE_CDN_AUTHORIZATION` secret. To refresh the shared secret, the reusable
workflow's *Refresh shared CDN credential secret* step stores the credential from a
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
PYTHONPATH=scripts python scripts/pipeline.py --server jp run \
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
PYTHONPATH=scripts python scripts/pipeline.py --server jp <command> --help
```

## Commands

`build-api` compares every available official song chart's converted judged-note
count with `MasterLiveMusicScore._fullComboCount`. The build's `reports/api.json`
includes `sonolusComboAudit` with matched counts, per-chart mismatches, unavailable
charts and missing references. Inspect this report before publishing a release;
an incomplete audit is reported separately from matching counts.

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
| `current-package`                                    | Read the published package identity; `--from-server jp\|intl` selects a shared base package                  |
| `fetch-release-document`                              | Fetch one verified JSON document from a published release                                                        |
| `prune-sources` / `prune-releases` / `prune-uploads`  | Apply retention policies                                                                                    |
| `gc-r2`                                               | Remove unreferenced R2 objects                                                                              |

## Configuration and output

Character voices follow the game's Master order: Comment, Training, Gacha and LIVE, followed by map interactions and startup calls. Each release keeps its source catalogue; character pages merge JP and Intl, fill translated text and join identical recording hashes. Short post-live and map conversations retain their authored speaker order and text. Package-owned CRI adds Intl's Bilibili and Bushiroad Games calls alongside the shared Bushimo and FromTokyo recordings. Multiple outputs for one native cue remain in `recordings`; the archive uses its first declared stream as the preferred recording and counts the line once.

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

### App downloads and native story downloads

`wrangler.downloads.jsonc` deploys the independent download Worker on
`haneoka.org/downloads/*`. This specific route takes precedence over the site's
wildcard route and retains its existing DNS, TLS and preferred network routing.
The private `haneoka-downloads` bucket holds app distributions. Game resources
remain in `hotdori-assets`; the download Worker only exposes objects listed by
the corresponding formal release's offline manifest.

`python scripts/publish/app_downloads.py` verifies each stable GitHub attachment,
preserves signed package bytes, rewrites distribution feeds, regenerates their
checksums and uploads a versioned mirror. It promotes `app/latest.json` after
every attachment succeeds and the source release is checked again. The web and
native update readers share `/downloads/app/latest.json`. The fifteen-minute
`app-downloads.yml` workflow skips an unchanged source release.

`python scripts/publish/story_offline.py --server jp` compiles chapter dependency
manifests from one complete release, including native source descriptors and
object archives, model data, media and the runtime catalogue. Generated files
live under that release's `offline/` prefix. Their referenced bytes already belong
to the release's CAS roots. The independent `servers/{server}/offline/current.json`
pointer advances after a complete snapshot; resource updates keep the previous
snapshot downloadable. Release cleanup retains the active offline release.
Root and chapter manifests are addressed by their own hashes; producer updates
can refresh the small pointer without invalidating earlier manifests. Small
objects travel in bounded `HNPK1` streams (up to 32 objects and 4 MiB per request).
The App verifies each object's SHA-256 and retains only its shared object file;
large or partially downloaded objects use individual range requests.
`story-offline.yml` runs after full formal releases and checks for subsequent
projection releases every fifteen minutes. It leaves the resource current pointer
unchanged. Fully downloaded App snapshots retain their own metadata and objects.

The story publisher uses the existing resource S3 credentials. The app mirror
workflow uses `--cloudflare-token` with the existing deployment identity, deriving
S3 credentials in memory through Cloudflare's documented token mapping. It does
not expand the resource bucket token's access or save additional credentials.
For an operator's local bootstrap, `--wrangler` explicitly uses the configured
Wrangler identity; `--directory DIR` retains verified input files across retries.
Deploy the service with `pnpm exec wrangler deploy --config wrangler.downloads.jsonc`.


Static document collection uses `python scripts/publish/static_documents.py collect
--plan .output/static-gc-plan.json --report .output/static-gc-report.json`. It keeps
the active publication, the latest three successfully deployed publication roots,
and roots from the last seven days. While the registry covers fewer than three
distinct publications, it also keeps the latest three uploaded roots. Successful Worker deployments register
their actual version and publication SHA in one small R2 receipt. Roots served
entirely by Worker assets retain their versioned asset binding; legacy R2 roots
mark every referenced compressed object.

`apply --plan .output/static-gc-plan.json` consumes the same complete plan under
the shared `cloudflare-production-publish` workflow lock, after rechecking the
active root and root/receipt snapshots. Candidates must be unreferenced and older
than seven days. Collection scans `static-documents/v1/` once. Apply relists the
candidate content shards, skips changed or missing objects, rechecks the active
root, and uses batched deletion. Other namespaces and unrecognized keys remain stored.

The weekly `static-document-gc.yml` workflow creates and applies a plan. Set the
repository variable `STATIC_DOCUMENT_GC_APPLY=false` to keep scheduled runs in
dry-run mode. Manual runs default to dry-run; their `apply` input enables deletion.
`offline-plan --inventory-directory DIR --active-manifest FILE
--plan FILE` reuses recorded Cloudflare LIST pages for inspection; these partial
plans support reporting and cannot be applied.

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

### 页面快照的成本与启用

`config/catalog-page-rollout.json` 默认 `enabledKinds: []`。默认整站构建、资源更新和 PR 验证不发布页面快照或计算 receipt，不产生这条链路的 R2 写入与新增存储。PR CI 复用五语分片构建，使用 `verification_only`，不读取生产 R2 凭据，也不生成可部署 Worker publication。生产构建继续保留授权 runtime 与 publication 校验。

快照需要显式配置启用的核心类型。发布前先复用同一版本的完整 ready；已存在的内容对象只读验证，不重复 PUT，也不列举 bucket。新增正文以确定性 gzip 写入 `.json.gz`，摘要仍绑定解压后的原始 JSON；旧 `.json` 保持可读。先上传内容并远端回读，最后写入 ready。

新资源向量或投影版本仍可能使整批快照更新，压缩不会减少首次发布的对象数量。启用前应以实际输入测量新增 PUT 数和压缩字节数；当前保持关闭。重复完整发布不新增对象；本地验证不向生产 R2 写入对象。

PR 的公开完整前端校验使用 optional Cubism 策略；没有 Core 时跳过原生模型 metadata 提取，生产部署仍要求完整授权运行时。

## Reward catalog projection

The `rewards` option in `band-description-projection.yml` reads each explicit
current release, adds `chat-customizations`, and repairs reward references in
the nine selected game-system catalogs. Home Spot rewards target the existing
home story. Raw Masters, media and other catalogs retain their original entries.

Run with `publish=false` and a `projection_json` object keyed by `jp` and `intl`,
each containing `identity: {server, sourceId, releaseId}`. Review the emitted
chat catalog, changed reward counts and candidate manifest. To publish, retain
those exact inputs and add each receipt's `candidateReleaseId` and
`candidateManifestSha256`; set `publish=true`. A changed parent requires a new
dry-run. Publication reuses the existing conditional current-pointer update.
