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
| `/events/{id}/points/search?query=` | Player ID or username matches across the complete point board |
| `/arena/seasons/{season}/leagues/{band}/ranking?start=` | One window of 100 of a league |
| `/arena/seasons/{season}/leagues/{band}/population?thresholds=` | Players per division |
| `/arena/seasons/{season}/leagues/{band}/search?query=` | Player ID or username matches across the complete league |

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

Demand-only and collection jobs report explicit authenticated demand rejection
as `complete.status: "auth_paused"` with `failure.stage: "demand"` and the
HTTP/gRPC status. Only a known authentication rejection produces this status
for demand within collection; a permission refusal ends that demand without
declaring the session expired. The Worker can queue managed Global session
renewal from these fields. It never replays the failed demand.

## Private account login

`POST /account-sdk` and `POST /account-game` use the same Container bearer
authentication as collection. They accept `haneoka:official-account-job/1` for
`tw`, `en` or `kr`, with the matching action:

```text
{contract, action: "sdk" | "game", region, runId, deadlineMs, expectedPlayerId?, expectedSdkUid?,
 sdkProfile, playerProfile, masterConfig, apiOrigin, sdkSession?}
```

The SDK action additionally requires `email` and `password`; the game action
forbids both and requires `sdkSession` and its matching `expectedSdkUid`.
Profiles are defined in the owning README. `sdkSession`, when present, contains
`{uid, access_key, id_token, mid}`; `mid` may be null. It is an internal encrypted
vault input, never a browser or public API field. Cached authentication uses
`cache.login`; only an explicit expired-key response permits one password login.
`expectedSdkUid` is the saved identity in the configured SDK namespace. A cached
session must match it before any SDK request; a fresh SDK result must match it
before PlayerLogin. A mismatch returns `auth_required` with
`sdk_identity_mismatch`, without game login or a replacement SDK session.
The SDK action loads a fresh catalogue before authentication, then returns
`sdk_ready` with its private session and performs no game login. The Worker
atomically confirms SDK ownership and persists the encrypted session before
dispatching the game action. That action performs no SDK authentication and
verifies every current ranking target before returning a ready role.

The private response is `haneoka:official-account-result/1` with the same
`action`, `region` and `runId`. SDK success is `sdk_ready` with `sdkSession`;
game success is `ready` with `playerId` and `credentials`.
Failures include a local `errorCode` and may preserve a known `playerId`.
An expired SDK cache without replacement returns `sdkSession: null` in the SDK
phase. Game responses omit SDK sessions; they cannot replace the SDK cache.

Results travel only over the authenticated Container response. The Worker
validates identity and stores SDK and role sessions under the active account
version and lease. Collection and lookup jobs cannot overlap account login.
An in-memory action/run-ID/exact-job-digest cache serves completed duplicate
jobs. A started phase with an unknown result returns `run_uncertain` rather
than reexecuting; changed payloads return `run_conflict`. Only `busy`, emitted
before execution, permits one identical retry. The former `/account-login`
route is absent, so mixed old/new deployments reject before SDK or game calls.

## Private JP guest phases

Authenticated `POST /guest-job` accepts:

```text
{contract: "haneoka:official-guest-job/1", action: "register" | "verify",
 region: "jp", guestId, runId, deadlineMs, guestProfile, apiOrigin, masterConfig,
 credentials?}
```

`guestProfile` supplies `client_version`, optional `device_id` and optional
`initial_data_group`. Registration forbids `credentials`; verification requires
the saved `{player_id, credential, device_id}`. Both actions load a fresh catalog.
Only registration can create a player; it returns before ranking verification.

`haneoka:official-guest-result/1` echoes action, region, guest ID and run ID.
Register returns `created` with `playerId`, decimal-string `profileId` and private
credentials, or `failed`/`uncertain` with a local `errorCode`. Verify returns
`ready` with the saved player ID or `created` with an error code, preserving the
previously stored identity. The Worker contract checks these bindings and rebuilds
configuration from its trusted profile and Master inputs.

Both phases exclude account login, collection and lookup work. Completed jobs
are cached by action, run ID and exact job digest. The cache targets 16 entries;
only entries whose job deadline has passed may be evicted, so newer jobs cannot
erase the replay guard of a still-valid request. A started registration whose
result was lost returns 409 `run_uncertain` on repeat; a changed payload conflicts.
Authenticated `GET /guest-result/{runId}` reads only that in-memory registration
result, including after the original deadline: 200 for a completed private result,
202 `result_unavailable` for an incomplete execution, 404 `result_not_found` when
absent. It performs no game request. Process restart or expired-entry eviction
can remove the result; absence does not authorize another registration.

## Storage

The regional Durable Object keeps the schedule, credential generation, checkpoints, pauses and queues. D1 keeps indexes, and private R2 keeps immutable bodies. The container's temporary directory is not used for recovery.

## Account pool format

A region secret holds a single account or `haneoka:official-ranking-account-pool/1`:

```text
{contract, region, selectedAccountId?, accounts: [{id, label?, source?, enabled, state, pauseReason?, nextRequestAtMs?, clientVersion, credentials, masterConfig}]}
```

Only enabled, ready entries are scheduled. Pauses are stored against the real identity and credential digest, so changing an ID, label or pool format does not clear them. `/status` exposes only the counts `{accounts, enabled, ready, paused, coolingDown, leased}`.

Point and Arena search also accept the existing `profileId` parameter. A `query` response contains `matches`, `searchedTo`, `observedAtMs` and `nextCursor`; pass `after={nextCursor}` with the same query for the next 100 matches. Missing windows or index backfill return `pending`, never an incomplete negative result. Index backfill reads at most twelve saved windows per request and adds no game RPCs or R2 copies.
