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

## Build a local release

```sh
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt run \
  --input /absolute/path/to/package.apks
```

The selected release pointer is written to
`data/servers/<server>/current.json`. Use `--ktx2` for optional texture
derivatives. `--publish` writes to remote R2 and should only be used for an
intended publication.

Run command-specific help for all options:

```sh
PYTHONPATH=scripts python scripts/pipeline.py --help
PYTHONPATH=scripts python scripts/pipeline.py --server jp-cbt <command> --help
```

## Commands

| Command | Purpose |
| --- | --- |
| `ingest` | Normalize an APK, APKS/XAPK, or split-APK directory |
| `verify-source` | Verify source sizes, hashes, and identity |
| `index-source` | Build Unity CAB dependency metadata |
| `extract-master` | Decode Master data |
| `extract-unity` / `merge-unity` | Process and merge Unity shards |
| `extract-cri` | Decode CRI media |
| `build-live2d` | Build Live2D indexes and runtime derivatives |
| `build-home-spots` | Build Home Spot models and previews |
| `build-api` | Build catalog documents |
| `build-ktx2` | Build optional GPU texture derivatives |
| `build-sonolus` | Build Sonolus resources |
| `build-release` | Assemble and select a local release |
| `run` | Run the complete local pipeline |
| `verify-release` / `verify-remote` | Verify local or published releases |
| `publish-source` / `publish-release` | Publish verified data to R2 |
| `fetch-package` / `fetch-source` / `fetch-home-spots` | Restore stored inputs |
| `prune-sources` / `prune-releases` / `prune-uploads` | Apply retention policies |
| `gc-r2` | Remove unreferenced R2 objects |

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
