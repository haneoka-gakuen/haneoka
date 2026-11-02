# Interfaces

## Read API

The prefix is `/api/v2/game/records/{region}`, with `region` one of `jp`, `tw`, `en` or `kr`. GET requests read saved data only. They never contact the game or refresh an observation. A locally run collector serves only its own region, on `127.0.0.1`.

| Path | Returns |
| --- | --- |
| `/status` | Collector state, age, poll hint and `pool` counts |
| `/events/current` | The current event, or `event: null` |
| `/events/{id}/challenges/{challenge}/latest` | Latest observation of one challenge song |
| `/events/{id}/total/latest` | Latest observation of the total board |
| `/events/{id}/latest` | Latest top 100 of the point board, when the event has one |
| `/events/{id}/points/ranking?start=` | One window of 100 of the point board |
| `/events/{id}/points/search?profileId=` | A player within the point board's top 2000 |
| `/arena/seasons/{season}/leagues/{band}/ranking?start=` | One window of 100 of a league |
| `/arena/seasons/{season}/leagues/{band}/population?thresholds=` | Players per division |
| `/arena/seasons/{season}/leagues/{band}/search?profileId=` | A player within a league's top 2000 |

Replace `latest` with `history?after={cursor}` for observations and `nextCursor`, 100 per page. Failures stay in the history.

Challenge and total boards have no rank parameter upstream, so they stop at 100. `GetRankingList` and `ArenaRanking` accept rank ranges.

Observations use `haneoka:ranking-observation/2`. Public responses use the website DTOs with `provider`, `snapshotId`, `observedAtMs`, `serverTimeMs` and normalised `rows`. Raw `players` stay in private R2. Every response is `Cache-Control: no-store`.

A board's freshness is its own `observedAtMs`, not the last success in `/status`. A missing catalogue or observation returns HTTP 503 `pending`. A disabled or unconfigured collector adds `collectorStatus` with `retryAfter: null`.

## Reading on a website

1. Poll while the page is visible and stop while it is hidden. Cancel old requests when the event changes.
2. Treat a board as new only when `snapshotId` changes. Show `observedAtMs`, and work out age from `serverTimeMs`.
3. On failure, keep the last data and its original time.
4. Boards are collected separately, so they are not one instant. Read the total board from `total`, never by adding songs.
5. With a 300-second cycle, data lags by about 300 seconds plus the run and the poll interval.

## Job contract

`POST /collect` takes a `haneoka:official-ranking-job/1` job, defined in `src/lib/official-ranking.ts`, with the region, run ID, credential generation, client version, private configuration, deadline and a one-run callback token. `GET /health` reports readiness only.

| Field | Contents |
| --- | --- |
| `capabilities` | See [README](README.md#arena-and-event-windows) |
| `arenaWindows` | Up to 20 `{seasonId, bandId, startRank, endRank}`, aligned to 100 |
| `eventWindows` | Up to 20 `{eventId, startRank, endRank}`, aligned to 100 |
| `arenaProgress` | Saved population progress, returned to the job |
| `playerLookups`, `songRankings`, `cardImages` | Bounded demand queues |

## Callback updates

`haneoka:official-ranking-update/1` posts these updates to `/api/internal/official-rankings/{region}/{runId}`. A failed callback is retried with the same payload up to three times, then the run stops.

| Update | Contents |
| --- | --- |
| `catalog` | Versions, event and `arena` |
| `attempt` | `snapshotId`, confirmed before each authenticated request |
| `observation` | One event board, or its failure |
| `arena-observation` | One league window with `maxRank` and raw `players` |
| `event-window` | One point window; `maxRank` only once the end is seen |
| `arena-population` | `atLeast: [{threshold, count}]`, sent once every boundary was read in this run or the five minutes before; `observedAtMs` is the oldest read |
| `arena-progress` | `{seasonId, bandId, thresholds, maxRank, counts, cursor, pending?, witnessedAtMs?}` |
| `player-profile`, `song-ranking`, `card-image` | Demand results |
| `complete` | Final status, with `failure: {stage, code, httpStatus?, grpcStatus?}` when it failed |

Failure fields use fixed stage and code lists. Exception text, headers, configuration and player data are never recorded.

## Storage

The regional Durable Object keeps the schedule, credential generation, checkpoints, pauses and queues. D1 keeps indexes, and private R2 keeps immutable bodies. The container's temporary directory is not used for recovery.

## Account pool format

A region secret holds a single account or `haneoka:official-ranking-account-pool/1`:

```text
{contract, region, selectedAccountId?, accounts: [{id, label?, source?, enabled, state, pauseReason?, nextRequestAtMs?, clientVersion, credentials, masterConfig}]}
```

Only enabled, ready entries are scheduled. Pauses are stored against the real identity and credential digest, so changing an ID, label or pool format does not clear them. `/status` exposes only the counts `{accounts, enabled, ready, paused, coolingDown, leased}`.
