# Official ranking collector

Reads official event, Arena and player rankings for `jp`, `tw`, `en` and `kr`. It builds its catalogue from the official Version and Master data, then stores each observation.

It runs in two modes. In the cloud, a regional Durable Object schedules a Cloudflare Container and the Worker stores the history. Locally, it keeps a per-region run directory and a SQLite history. It runs on Windows, Linux and macOS with Python 3.12 or later; 3.13 is recommended.

Endpoints and payloads are in [INTERFACES.md](INTERFACES.md).

## Cloud mode

The entry point is `cloud.py` and the image is defined by this directory's `Dockerfile`. Build it from the repository root:

```sh
docker build -t haneoka-official-ranking:local server/ranking-collector-official
```

| Setting | Purpose |
| --- | --- |
| `OFFICIAL_RANKING_ENABLED_REGIONS` | Regions to collect, comma separated |
| `OFFICIAL_RANKING_READ_REGIONS` | Regions the website reads from this collector |
| `OFFICIAL_RANKING_{JP,TW,EN,KR}_CONFIG` | Worker secret for each region |
| `OFFICIAL_CALLBACK_ORIGIN` | Callback origin, `https://haneoka.org` in production |

A region's secret holds one account or a pool:

```json
{
  "clientVersion": "1.1.0",
  "credentials": { "region": "jp", "origin": "https://api.bang-dream-on.jp", "credentials": {} },
  "masterConfig": {}
}
```

Pools use `haneoka:official-ranking-account-pool/1`, the output of `account-pool.mjs export-pool`. Save a verified configuration as a GitHub Actions secret of the same name and run `official-ranking-config.yml`. Secrets never go in `vars`, the image or the repository. The `tw` region uses `hk` in `credentials.region`.

A run lasts about two minutes. Each board request is checkpointed before it is sent, and the next one waits until the Worker has stored the last.

| Upstream response | Result |
| --- | --- |
| HTTP 401, gRPC 16, gRPC 2 `authentication failed` | Pauses that credential; another ready account can take over |
| HTTP 403, gRPC 7 | Pauses the region until the credential is renewed |
| HTTP 429, gRPC 8 | Cools down every account in the region |

A failed request is never replayed on another account. A run interrupted between request and observation stays in `auth_uncertain` until the credential changes. Restarting does not clear a pause.

## Arena and event windows

A job negotiates these capabilities:

| Capability | Adds |
| --- | --- |
| `arena-ranking-v1` | Ranks 1–100 of each league |
| `arena-demand-v1` | Up to 20 requested windows of 100 |
| `arena-population-v1` | Players per division, from each rank's `_lp` |
| `arena-progress-v1` | Population search progress kept across runs |
| `event-windows-v1` | Event point ranks past the top 100, when the event has a point board |

Page reads use saved snapshots. A missing window registers a bounded interest, and game requests run only in background jobs.

## Account pool

`account-pool.mjs` manages an encrypted private pool with Node 24. Only `query` goes online. It never logs in, registers or creates characters.

```sh
node account-pool.mjs status --directory <pool>
node account-pool.mjs import --directory <pool> --config <region-config.json> --label <label> --source sdk
node account-pool.mjs pause --directory <pool> --account <id>
node account-pool.mjs enable --directory <pool> --account <id>
node account-pool.mjs select --directory <pool> --region tw --account <id>
node account-pool.mjs query --directory <pool> --region tw --kind total --id 4 --python <python> --output <result.json>
node account-pool.mjs export-pool --directory <pool> --region tw --output <pool-config.json>
```

Output files are created with mode 0600 and never overwrite existing files. Stop local queries for an identity once it moves to the cloud.

## Local mode

Install from an offline package built on a connected machine:

```sh
python -m pip download --no-deps --only-binary=:all: --platform any --dest wheelhouse protobuf==6.33.0 h2==4.4.1 hpack==4.2.0 hyperframe==6.1.0 setuptools==80.9.0 wheel==0.45.1
python -m pip download --no-deps --no-binary=:all: --dest wheelhouse py3rijndael==0.3.3
python build.py --wheelhouse wheelhouse --output <package.zip>
python setup.py --python <python3.13>
.venv/bin/python collector.py doctor
```

Keep credentials and Master configuration outside the tool and run directories. The JP Master configuration holds `masterRemoteRoot`, `cdnUsername` and `masterCrypto`; other regions need only `masterCrypto`.

```sh
python collector.py catalog --region tw --output <dir> --master-config <master.json> --client-version 1.1.0
python collector.py init --region tw --output <run> --credentials <credentials.json> --master-config <master.json> --hours 0.2 --interval 300 --client-version 1.1.0
python collector.py start --output <run>
python collector.py status --output <run> --verify
python collector.py stop --output <run>
python collector.py resume --output <run>
python collector.py serve --output <run> --port 18779
python collector.py backup --output <run> --destination <new-path>
```

`catalog` reads no game credentials and requests no rankings. Each region needs its own run directory, and a directory cannot change region. `--proxy` accepts a loopback HTTP proxy. The read API binds to `127.0.0.1`, and GET requests never contact the game.
