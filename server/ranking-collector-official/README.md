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

### Managed-account rollout

Prepare these Worker secrets through Wrangler's secret interface before using
the admin account controls:

| Secret | Setup |
| --- | --- |
| `OFFICIAL_ACCOUNT_ENCRYPTION_KEY` | Initialize once with the account vault's 32-byte base64 key; retain the existing key on subsequent releases |
| `OFFICIAL_JP_GUEST_CONFIG` | JP client profile and Master configuration described under Guest registration |
| `OFFICIAL_GLOBAL_LOGIN_CONFIG` | SDK/player profiles and the three regional Master configurations described under Running a Global login task |

The regional pool workflow owns the separate `OFFICIAL_RANKING_*_CONFIG`
secrets. Email addresses and passwords are entered through the admin account
form after the Worker is deployed.

Use the normal deployment workflow so pending D1 migrations run before the new
Worker; this version requires migrations through 0066. For a manual Worker-only
release, select `apply_d1_migrations=true`. When Container source or dependencies
change, also select `build_containers=true` so the sealed image comes from the
same source as the Worker. These options belong to `deploy-cloudflare.yml`.

Finish secret updates before starting the production publication. A secret
update creates an active Worker version; keep secrets unchanged until the
publication has completed its version checks.

After rollout, verify a JP guest and each Global regional role separately;
queue acceptance, a saved password and successful SDK login are intermediate
states. The ready state requires successful ranking-permission verification.

A run lasts up to two minutes. Accounts take turns, least recently used first, and a run starts every five minutes divided by the usable accounts, at most once a minute. Each board request is checkpointed before it is sent, and the next one waits until the Worker has stored the last.

The Container entry handles SIGTERM and closes its HTTP listener, including when
Python is PID 1. A stopped process loses its in-memory result cache; the Worker
keeps its existing unknown-outcome handling for interrupted account requests.

| Upstream response | Result |
| --- | --- |
| HTTP 401, gRPC 16, gRPC 2 `authentication failed` | Rests the account for 15 minutes per rejection; another ready account can take over |
| HTTP 403, gRPC 7 | The same, and the third rejection pauses the whole region |
| HTTP 429, gRPC 8 | Cools down every account in the region |

Three rejections in a row pause an account until its credential changes, and any success clears the count. A failed request is never replayed on another account. A run interrupted between request and observation only rests the account.

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

## History retention

Cloud event boards retain every observation for 12 hours. Older history keeps
each board's last successful snapshot and last attempt per Japan-time day.
A failed attempt never replaces the day's successful snapshot. These are daily
observations; they do not establish that a board is final.

`official_ranking_daily` references the last successful observation for each
region, board and Japan-time day, including Arena windows, event point windows
and population counts. Window replacement and scheduled pruning preserve these
payloads. Each window retains its own observation time and coverage.

Each observation writes a separate R2 object. Thinning older observations limits
retained storage; it does not undo the operations already incurred. Unchanged
catalog content reuses its R2 object while D1 records the latest observation
time. Event and Arena final targets are registered when their definitions change;
new rank windows register their own targets as they are saved. Repeated target
registrations with the same definition and cutoff do not rewrite existing rows.

Live event boards run before Arena work, and Arena top windows precede extra
windows and population searches. Work reserves twenty seconds for completion
callbacks. With `arena-probes-v1`, intermediate population-search pages only
acknowledge their checkpoints; complete counts and retained rank windows are
still stored. Background sweep cursors advance after successful window storage.

Demand-only jobs have durable wake-ups and advertise `demand-progress-v1`.
Completion reports the IDs actually attempted, so budget-deferred requests stay
queued for another batch. Players and songs precede card downloads, with a
bounded player batch. Transient service failures retry after 15–120 seconds;
read-only job expiration does not invalidate an account session.

Population snapshots have a twenty-minute background freshness target. Five
minutes before it, unrequested deep-page sweeps yield their budget to complete
counts and bounded catch-up rounds run sooner. Top boards and requested windows
keep their priority. Catch-up stops after twenty rounds or when all counts are
fresh; no population warm-up runs before the season opens.

`population-priority-v1` orders leagues by their last complete population
snapshot. After three incomplete turns on one league, another league gets the
next turn. Progress reports distinguish budget deferral from moving boundaries;
these hints never count as a complete population snapshot.

Migration 0064 records retired payloads in a durable D1 cleanup queue through
the four observation tables' delete triggers. Index removal and queue creation
commit together; R2 deletion happens after a five-minute grace period and another
reference check. The queue entry is acknowledged only after R2 deletion succeeds,
so an interrupted or partially completed delete can resume on the next run.
Window replacement uses the same queue.

The two-minute maintenance trigger dispatches cleanup to every regional collector,
including disabled regions. Each collector retires at most 50 rows and deletes
at most 50 queued payloads per run. Cleanup shares its serialized queue with
observation and archive writes; other regions can proceed independently. The
sampling schedule and observation timestamps are unchanged. Apply 0064 before
running this Worker version. An older Worker does not drain the new queue;
preserve queued records and objects when rolling back code.

Migration 0053 backfills these references from surviving successful observations.
Previously deleted payloads cannot be reconstructed by the migration.

Cloud event finals use migration 0055. The Worker retains each enabled challenge,
total and point top-100 board after its end time plus the official aggregation
duration. A due final run uses fresh Master/version checks with the retained event
identity, without replacing the current catalog. At most one final run per ten
minutes leaves intervening runs for current collection. The first successful
post-aggregation observation is pinned independently of the daily snapshot.
Failed boards stay pending across event changes; a historical permission refusal
does not count as an account authentication strike. Previously observed event
point windows join the same queue, with at most twenty windows in one run. Each
window keeps its own observation time and range; these are the sampled ranges.

Migration 0056 retains Arena season definitions, known league windows and complete
population targets after `rankingEndAtMs`. Final population search hints are stored
separately from the current season and re-witnessed before publication. Each run
selects one population band and up to twenty windows. Event and Arena dispatches
rotate even when a container fails before its first callback; actual window
attempt times keep a refused range from blocking untried ranges. A successful
post-cutoff window or complete population payload is pinned and protected from
both immediate replacement and scheduled pruning.

The admin operations page opens the daily archive from each region in the account
pool. Administrators can also read a day's archive directory with
`GET /api/v1/admin/collector-archives/{region}?day=YYYY-MM-DD`; dates use
`Asia/Tokyo`. The directory includes board identities, snapshot IDs, hashes and
original observation times, without private object paths or player payloads.

The region's **Final archives** action opens retained event/season targets with
per-board `waiting`, `pending` or `archived` states, cutoff times and original
collection times in Japan time. `GET /api/v1/admin/collector-final-archives/{region}`
returns the complete target summary and the target with the latest cutoff;
`?kind=event&id=...` or `?kind=arena&id=...` selects one target explicitly. Both
parameters must appear together. The response includes sampled window identities
and counts of archived targets, without private object paths, retained definitions
or population search hints. Reading either archive directory performs no dispatch
or state update.

## Account pool

The admin operations page includes Global email-account entry and per-region
initialization states. Its form clears the password after saving. The
administrator-only `collector-platform-accounts` API stores Global email
accounts separately from usable regional collector credentials. POST accepts
`{email, password} (and an optional label)` with an administrator session and an idempotency key;
GET returns redacted per-region account rows. Saving creates the three role records,
then adopts configured active sessions or queues one shared account login.

PUT `collector-platform-accounts/{id}` accepts `{label, expectedVersion, password?}`.
The email remains fixed. Omitting the password preserves it; supplying a new one
clears saved regional sessions and verification state while retaining player IDs.
Roles with an existing player ID become `auth_required`; other roles remain
`not_initialized`. Version conflicts return 409 so an older editor cannot overwrite
a newer save. The editor starts with an empty optional password field.

Set the Worker secret `OFFICIAL_ACCOUNT_ENCRYPTION_KEY` to a base64-encoded
32-byte random key before accepting passwords. Keep that key in protected backup
with the database; replacing it without re-encrypting existing records prevents
their recovery. Passwords use AES-GCM with an independent nonce and account/email
identity binding. Passwords, ciphertexts and input bodies are absent from list
responses and operation audit details.

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

### JP guest registration protocol module

`core/guest_registration.py` provides
`register_guest(GuestProfile(client_version, device_id='', initial_data_group=''))`.
It sends one `PlayerService/Register` request to the selected allowlisted JP
origin. An empty initial-data group produces the client's empty request body.
Registration omits player credentials, SDK identity and Master/resource version
headers; it sends the explicit client version, Android platform, a new request
ID and the configured device ID when present. The returned private session
preserves the server's device identity and exact decimal profile ID.

The wire schema comes from the bundled Sirius descriptor; the creation branch,
virtual Register call and conditional header production were traced in the
official Global 1.0.3/code56 client. This is static shared-protocol evidence,
not current JP server acceptance. The function performs no retry or receipt
write, does not finish tutorials and does not enroll an account in the pool.
The Container's authenticated `/guest-job` endpoint invokes it through
`core/guest_job.py`. The portable read-only CLI bundle remains unchanged.

Guest jobs have separate `register` and `verify` actions. Registration first
loads a fresh catalog, then returns the created identity immediately without
ranking requests. The caller must save that private result before submitting
verification with the saved credentials. Verification never calls Register and
cannot discard an existing identity when a board or catalog is unavailable.
It reuses the current-target checks from `account_job.py`; JP uses its own
descriptor and master version, without the Global resource-version field.

The Container remembers a started registration before execution. An unexpected
failure makes an identical repeat return `run_uncertain` rather than execute
again. Authenticated `GET /guest-result/{runId}` reads only the in-memory
registration result, without a new game request or job-deadline check. It returns
202 while no result is available, 404 when absent, or the original private result.
This recovery cache does not survive a Container restart.
The cache targets 16 entries and evicts only jobs past their deadline. All
cached still-valid requests retain their results or unknown-outcome markers under
cache pressure; an expired POST is rejected before it can execute again.

Worker migration 0059 and `official-guest-accounts.ts` provide one-time creation
claims, encrypted identity persistence and versioned verification claims. A late
creation result may still save once under its exact original nonce; replayed or
different identities cannot overwrite a saved guest. Expired verification cannot
make a guest ready. Configuration ciphertext is bound to guest ID and player ID
under the account vault key. Redacted listings omit it and the underlying Master
configuration. `official-guest-jobs.ts` binds results to the expected guest, run,
phase and JP origin and reconstructs private configuration from trusted inputs.
Migration 0060 stores an immutable encrypted original request, bound to guest ID
and creation nonce. A registration claim requires this snapshot. The JP DO
drains collection and lookup work, claims once, sends one registration POST,
saves the created identity and queues a separate verification job. Ambiguous
POST responses and restarted tasks only GET the original result; neither a
missing result nor a busy response causes a registration replay. A late valid
identity can still be saved without clearing a newer queued task. Only verified
guests enter the existing pool; managed players suppress old manual credentials
even while verification is pending. Holds and health use the existing pool rules.

Configure the private Worker secret `OFFICIAL_JP_GUEST_CONFIG` with
`{clientVersion, masterConfig}` and optional `deviceId`, `initialDataGroup` and
allowlisted `apiOrigin`. It shares `OFFICIAL_ACCOUNT_ENCRYPTION_KEY` with the
platform vault. Existing tasks read their original encrypted configuration even
if this environment setting changes or disappears. No defaults establish a
current JP client profile or server acceptance.

Administrator-only `GET /api/v1/admin/collector-guest-accounts` returns redacted
guest lifecycle rows. Same-origin `POST` to that collection accepts
`{guestId, label}` with a canonical UUID and an administrative idempotency key.
The caller keeps the same guest ID when retrying an uncertain creation; a new
key may recover that guest's original result but cannot re-register it.
`POST /api/v1/admin/collector-guest-accounts/{id}/verify` accepts
`{expectedVersion}` and verifies stored credentials without registration.
HTTP 202 means queued, not created or ready. Queue/audit records contain no
credentials or Master configuration. The administrative pool panel provides
guest creation, result retrieval and versioned verification. Its creation draft
keeps the same UUID and label in tab-local session storage across failed requests
and reloads; confirmed acceptance clears the draft. Listings also return redacted
pending-job metadata for five-second polling while a task is active.
Verified guest rows also expose a separate current `poolStatus`, matched by
guest and player identity. The panel uses it for holds, cooldowns, active work,
authentication pauses and region disablement while preserving the guest's
lifecycle state and verification action. Reading this projection writes no
database or collector state and returns no credentials or internal pool hashes.
Visible pages refresh verified guests' pool health every 30 seconds; hiding or
leaving the page stops polling.
Loss of administrator access clears private rows and drafts and stops polling.
Real JP server acceptance remains outstanding.

### Global authentication protocol modules

The Container's authenticated `/account-sdk` and `/account-game` endpoints use
`core/platform_login.py`, `core/player_login.py` and `core/account_job.py`.
Saving an email account stores it; the per-region **Sign in** action queues
the login and verification task separately.
The portable read-only CLI and its offline dependency bundle remain separate.
`account-requirements.txt` pins the Container's RSA implementation independently
of the read-only collector requirements.

`GlobalEmailLogin(SdkProfile(...)).login(email, password)` requests the SDK RSA
challenge and submits the original password with the challenge hash using
RSAES-PKCS1-v1_5 and the SDK's sorted-value MD5 form signature. Profiles supply
explicit decoded common form parameters, the app key and an allowlisted SDK
origin; no game ID, merchant, server, channel or device defaults are inferred.
An absent `email_country_id` selects the old email parameter form; a supplied
country ID selects the typed email form. These variants come from the official
Global 1.0.3 SDK; selecting current client parameters and its active login form
requires matching client evidence. Redirects and automatic login retries are
disabled. SDK errors expose a local category and numeric code, not the response
message or body. Sessions have no field-bearing representation.

`resume(sdk_session)` verifies a saved access key with `cache.login`, retaining
that key and accepting the response's current OpenID token and metadata. A UID
change stops before PlayerLogin. The account job uses this path before password
login when a matching saved SDK session exists. Only the client's explicit
expired-key code `-101` clears that cache and permits one RSA/email login;
network failures, other refusals and identity mismatches do not fall back to a
password request. An expired-key reauthentication must return the same SDK UID.

`login_player(region, sdk_session, profile, expected_player_id=...)` uses the
international descriptor's real PlayerLogin request/response and the selected
region's allowlisted origin. The SDK UID becomes `sdkUid` and `x-player-bid`;
player and version-state headers are omitted for login. A configured player
pin rejects a different identity. The response preserves `isNewUser` separately
from the private credential; this flag does not establish initialized gameplay
or ranking permission. No login receipt or response file is written. The job
adapter verifies returned credentials for both new and existing players before
pool enrollment. Automatic session renewal uses the same verified login path
after an explicit authentication failure, as described below.

In the inspected official Global 1.0.3/code56 client, `PlayerPreLogin` takes the
same `PlayerLoginRequest` and returns `IsAccountCreated` as boolean field 1.
`ServerSelectManager.ProbeServer` calls it while examining candidate servers.
The selected-server login path calls `PlayerLogin`, stores its returned
certification and continues loading player data. Its new-user flag alone does
not establish that another creation request is required. A configured regional
account task therefore validates the returned role directly against its current
catalogue and ranking targets. This old-client trace does not establish current
live onboarding requirements; the task never marks an unverified role ready.

Independent Global official 1.1.0/code86 native bindings confirm that the normal
login callback builds `PlayerLoginRequest` and invokes `PlayerLoginAsync`, while
server probing invokes `PlayerPreLoginAsync`. The login continuation saves the
returned certification through `LocalPersistData.SetupCertification`. These
selected current-client paths support login followed by permission verification;
they do not establish tutorial completion, live hotfix behavior or server access.
The current `PlayerDataLoader.LoadOrCreate` certification branch sets its local
creation flag to zero, applies stored certification and bypasses
`PlayerApi.SaveNameAsync`; its local registration branch sets that flag to one
and takes the name-save path. Both proceed to `Player.Init`. The inspected raw
`Player.Init` body includes initial item, member-card and support-card assembly,
and has a runtime patch guard. These client initialization steps do not by
themselves identify another game-account creation request for the collector.
The current native getters and protobuf writers also match the collector's 23
fields across `PlayerLoginRequest`, `PlayerLoginResponse`, `PlayerUuid` and
`PlayerCredential`, including their field numbers and write types. `isNewUser`
remains `uint32`; the separate pre-login response writes `IsAccountCreated` as
boolean field 1. The inspected Android platform producer returns 0, matching
the login request's existing protobuf default.

Migration 0058 stores one shared encrypted SDK session per platform account,
separately from each regional game credential. Its encryption context binds the
account and SDK profile fingerprint. The fingerprint covers the configured SDK
origin, signing key, email variant, shell version and decoded common parameters;
reordering parameter keys does not change it. Different profiles do not reuse
the cache. Reads and updates require the current account-versioned login lease.
An SDK success may update this cache even when subsequent role initialization
or ranking verification is incomplete; it never makes that role ready.
Renaming an account preserves the cache. Replacing its password clears both
the SDK cache and regional sessions. SDK access keys, OpenID tokens and metadata
are absent from administrative responses and audit details. There is no new
timer or automatic background reauthentication policy.

Migration 0061 keeps the saved account's SDK UID independently of its encrypted
session. The identity scope is a digest of `game_id`, `server_id`, `merchant_id`,
`channel_id`, `platform` and `platform_type`; client/device versions, signing keys
and allowlisted SDK endpoint changes do not reset it. A distinct configured SDK
namespace has its own binding. A valid login lease can bind an unseen identity
or confirm the same UID, but cannot replace it. Renaming, password replacement
and SDK cache deletion preserve this metadata. Existing matching encrypted
caches establish the binding before dispatch; otherwise the first authenticated
SDK result establishes it. The migration does not infer a previously lost UID.

The account job receives the expected UID privately and checks it before game
login. A changed UID returns `auth_required` with `sdk_identity_mismatch`, leaving
the original identity intact. The Worker also checks private results before
cache/session adoption. Listings and audit records omit the UID and its scope.
Migration 0062 also assigns each scoped UID one saved account owner. Concurrent
aliases can authenticate with the SDK, but only the winning account can proceed
to PlayerLogin. The same owner can use its other regions and retain ownership
through failed verification, password changes and ambiguous game results.
Existing unambiguous identity rows backfill their owner; multiple saved accounts
already sharing a scoped UID produce an unresolved owner instead of choosing
one. Such rows return `sdk_identity_conflict` before game login. A new alias of
an existing owner returns `duplicate_sdk_identity`. Neither error reveals the
other saved account through the Container response.

Migration 0063 retires any surviving sessions for unresolved legacy duplicate
identities. It preserves passwords and player/SDK pins, clears SDK and regional
session caches, marks the roles conflicted and advances the version of accounts
that still had active sessions. Reapplying it does not keep advancing versions.

The administrator account list includes redacted `conflicts` with an opaque ID,
a membership/version revision and candidate account names/emails. **Confirm
owner** opens an unselected choice dialog showing that current sessions will be
cleared and regions need verification. The administrator must explicitly choose
one candidate; no account is selected automatically.

`POST /api/v1/admin/collector-platform-accounts/sdk-conflicts/{id}/resolve`
accepts `{accountId, expectedRevision}` under the existing administrator,
same-origin and idempotency policy. Only unresolved ownership can be assigned.
Current membership and every member version are checked again in the atomic
update; a running member login, including its response grace period, blocks it.
The database trigger advances all member versions and clears their SDK/regional
sessions in the same transaction. The selected account requires verification;
other aliases remain excluded. Passwords and immutable identity pins survive.

The action performs no SDK/game login. Old queued jobs and late replies cannot
adopt sessions with pre-resolution versions. Retrying the same selected owner
after a lost response is read-only; choosing another account cannot transfer an
already assigned owner. Only aliases of that exact scoped UID and selected owner
are excluded from duplicate-player checks during later verified login. Their
retained player IDs still suppress stale manual credentials; collisions outside
the resolved group remain errors. Back up the database before production
migration: a code rollback does not restore the retired shared sessions.

### Platform role persistence and pool ownership

Migration `0057_official_platform_login_jobs.sql` adds one current login lease per
platform account, serializing its three regions. The initial SDK lease clears all three
role sessions before draining in-flight work; subsequent role leases clear only
their own session and verification marker. Completion checks the run, region,
account version, deadline and existing player pin in the same D1 batch. A changed
password invalidates all role sessions; an expired login displays
`auth_uncertain`. These storage functions do not themselves send login requests.
The regional DO first drains collection and lookup work before claiming a login.
New regional work waits while the account task is queued or executing, including
when its player identity is not yet known. Different regions serialize the SDK
login for the same saved email through the shared D1 lease. A terminal stale
execution releases only its own lease, without changing current role state.

Only `ready` roles with a successful verification timestamp and encrypted
configuration are read into the existing regional collector pool. The session
box binds account, region and player identity with AES-GCM. New and existing
roles require the same successful verification. Failed/pending roles remain
excluded. The regional DO uses its existing selection, holds and credential
health policy for managed sessions; the admin view remains redacted.

Once a player belongs to a platform role, that role owns its pool credentials.
A verified session replaces a secret/manual entry for the same player while
preserving an explicit manual disable and the identity's hold/history. If the
role is signing in, fails, expires or loses its session after password rotation,
the collector does not fall back to that player's old configured credential.
Unrelated configured accounts retain their behavior.

### Running a Global login task

Set the separate Worker secret `OFFICIAL_GLOBAL_LOGIN_CONFIG` with this shape:

| Field | Contents |
| --- | --- |
| `sdkProfile.origin` | One of the SDK login origins verified for the client |
| `sdkProfile.app_key` | That client's SDK signing key |
| `sdkProfile.one_sdk_version` | Optional OneSDK shell version sent as the `one-sdk-ver` header; distinct from `common_params.sdk_ver` |
| `sdkProfile.common_params` | Decoded SDK common form values, including game/server/merchant/version/channel/platform and the client's device model/OS/network/language fields; omit `udid` |
| `sdkProfile.email_country_id` | Optional explicit country ID for the typed email form; omit for the old email form |
| `playerProfile` | `client_version`, `device_model`, `operating_system`, `client_package`, `global_channel_id`, `brand_id`, `area_id`; optional `initial_data_group` |
| `masterConfigs` | Existing official Master configuration under `tw`, `en` and `kr` |
| `apiOrigins` | Optional explicit allowlisted game origin per region |
| `automaticRenewal` | Defaults to enabled; `false` suspends automatic account renewal while existing sessions continue serving reads |

New accounts use their saved UUID as the stable `udid` and game `device_id`;
migrated accounts retain their recorded SDK device ID across regions.
The observed official SDK supports a cached random
UUID when hardware identity is unavailable. Client/channel constants and the
active email form must match the selected client; they are not borrowed from
the guest or Google-channel defaults. The login configuration is not returned
through administrative APIs.

In the inspected official Global 1.0.3/code56 package, the game wrapper calls
OneSDK, whose official adapter initializes GameSDK from the `merchantid`,
`appid`, `serverid` and `one_appkey` resources. The game's channel identity and
the SDK form's `channel_id` come from different producers. The OneSDK shell
version comes from `ONE_SDK_VERSION` metadata and is sent only as a header.
The SDK defaults to the typed email UI, but cached/remote login configuration
can select the old UI, and country configuration can replace its packaged
default. Confirm these values and the active email form for the selected client;
the inspected package does not establish current live configuration.

The [official website](https://bdon.biligames.com/?lang=en-us) now distributes
Global official 1.1.0/code86 (`com.bilibili.sirius.official`). Its packaged
OneSDK metadata and the four resources above match the inspected 1.0.3 package.
The decompiled `LoginTask`, `CacheLoginTask`, `PlatformConstant` and
`LoginABConfigData` also match after excluding their source-file annotations.
This extends the static SDK evidence to that package; its native library and
game metadata differ, so the 1.0.3 game onboarding trace is not a 1.1.0 proof.

`POST /api/v1/admin/collector-platform-accounts/{id}/roles/{tw|en|kr}/login`
accepts `{expectedVersion}` and the normal administrative idempotency key.
It requires an administrator session and same-origin mutation. HTTP 202 records
queue acceptance only; account status reports completion. The stored password
must be readable before queuing, so a wrong vault key cannot clear an existing
session. One task per region
may wait up to five minutes, and its execution is bounded to two minutes. The
admin list projects current pool health and version-bound jobs into each regional
role. It shows `renewal_waiting`, `renewal_queued` and `renewing` for automatic
work, and concise translated identity-conflict states for known failures. A stale
version or expired queue does not override the current role. These reads never
claim a lease or update DO/D1 state. While visible, the page refreshes every five
seconds during active tasks and every thirty seconds while waiting for renewal;
it stops when no task remains, the page is hidden or access is lost.

If creating the execution alarm fails, the queue rolls back only its own
unstarted run. The administrator request returns `503 account_queue_failed`
and its audit operation is marked failed; no login lease or SDK request has
started. An explicit retry can queue again without waiting for an orphaned task
to expire. A replacement nonce or already-started task is never deleted by this
cleanup.

Before SDK login, the job obtains a fresh official event/Arena catalogue.
Without an active verification target it stops without rotating a game identity.
After PlayerLogin, every returned role must pass an anonymous Version check
against that catalogue, every active event
target and the top-100 window of each current Arena band. These RPCs retain the
collector's two-second spacing. A refusal, target/version change, malformed
response or incomplete verification never produces a ready session. Historical
finals and deep-window coverage remain independent collection work.

Both private account phases exclude collection and demand-only jobs. The SDK
phase loads its public catalogue and returns before PlayerLogin; the DO confirms ownership and stores its
encrypted SDK session under the original lease/version before sending the game
phase. That request carries the verified SDK session and no email or password.
The original configuration and deadline apply to both phases. Before each phase
dispatch, including the one permitted busy retry, the DO checks the current
account version and login lease. A version change or lease expiry during SDK
cache persistence prevents game dispatch. Failed ownership
or storage prevents game dispatch; a failed game phase preserves the SDK session
and owner. The Container caches responses by action, run ID and exact digest,
and marks a phase started before execution. Private credential results travel
only in its authenticated response to the DO. The DO saves verified role
credentials under the original lease/version, clears its
queue and resumes regional scheduling. A `busy` rejection, sent before any
SDK/game request, is retried once with the identical job while its lease remains
valid. Unknown started phases and run-ID conflicts are not retried. An ambiguous
game response becomes `auth_uncertain`; an SDK-phase failure stops before game
login. The removed `/account-login` endpoint and action-bound new routes make
mixed old/new versions reject before execution. A player already
bound to another saved platform identity is rejected before session adoption,
so duplicate identities cannot invalidate the pool configuration. The existing
300-second sampling interval is unchanged.

### Automatic Global session renewal

An authenticated board or demand RPC returning HTTP 401, gRPC 16, or gRPC 2
with `authentication failed` retires the current managed credential generation
from selection. The regional DO retains a renewal candidate for that exact
platform account, account version and generation. It waits at least the existing
15-minute authentication cooldown, then queues one login through the same
SDK-ownership, account-wide D1 lease, drain and full-board verification path as
an explicit administrator login. Other usable accounts can continue collecting
during the cooldown. Permission refusals, rate limits, anonymous catalogue or
Version failures and transport ambiguity never create a renewal candidate.

Collection and demand-only callbacks carry the same body-free authentication
failure metadata. Neither the failed sampling request nor the failed demand is
replayed by renewal. Manual holds, disabled accounts and regional permission
pauses defer automatic login; holds and regional pauses are checked again before
each private phase. Clearing the account's pause cancels its pending automatic
renewal. Password changes and replacement sessions invalidate old candidates.

An automatic attempt is consumed when its login starts. A lost game reply stays
`auth_uncertain` and is not retried automatically. Failed renewal requires an
explicit administrator action. A verified success restores the account even if
the game returned the same credential, without clearing a manual hold. JP guest
creation and saved-credential verification do not recreate an expired identity;
this Global renewal path does not register replacement guests.

Authentication rejection and its renewal candidate are persisted before the
renewal alarm is created. If that scheduling call fails, the next
`ensureScheduled` restores the alarm from durable state. A failed automatic queue
keeps its candidate and does not replay SDK/game work. Held candidates are
skipped while other due accounts proceed; an ambiguous attempt is consumed
without blocking the remaining candidates.

### Existing pool migration and account removal

In Admin → Operations → Account pool, use **Import current pool** to adopt the configured JP guests without registering replacements. Imported identities retain their credentials. Guests with recorded successful collection keep their verified state; other guests await verification before joining collection. The import is repeatable and skips managed or removed players.

Add Global accounts by entering email and password. Sign-in restores TW, EN and KR together. Passwords and sessions use the server vault. Lists and audit records contain no passwords.

`DELETE /api/v1/admin/collector-{guest,platform}-accounts/{id}` accepts `{expectedVersion}` and the administrative idempotency key. Removal deletes encrypted credentials, saved requests, SDK sessions and login leases in the same transaction. Player tombstones suppress old secret/manual configurations; guest ID tombstones also prevent registration replay. Active JP creation/verification must finish before removal. Deleting a pool identity does not delete its game account.

### Shared Global account login

The admin form accepts email and password. A saved Global account owns TW, EN and KR roles together; the account-level sign-in queues one SDK authentication followed by three serial game-role logins. A D1 batch lease prevents overlapping login chains across regional objects. Before SDK authentication, stored roles leave selection and existing regional collection/lookup leases drain. Sibling regions reuse the verified SDK session directly; they do not authenticate the SDK again. Each verified role returns to the pool with its previous manual hold preserved. Deferred work, account versions and the batch deadline survive object restarts.

For an existing pool, a temporary gzip/base64 `bootstrapAccounts` value in the private Global login configuration can supply verified SDK sessions, regional configurations and the original SDK device IDs. The normal email/password form matches its email, encrypts the supplied password and adopts those sessions without a game or SDK login. Clear the bootstrap value after both accounts are present and regional reads succeed. An unattended one-time migration may also supply the password in this private payload; remove the payload after verifying the encrypted database records. Imported SDK device IDs remain stable in `official_platform_devices`; new accounts use their account UUID.

JP creation needs no form fields. `POST /api/v1/admin/collector-guest-accounts` accepts an empty JSON body with the normal administrative idempotency key, or a stable `guestId` for browser retry recovery. The server assigns the label.

### Observation payload batches

The Worker commits small observation bodies and their indexes in one D1 transaction, so current rankings and history are readable immediately. Its regional scheduled recovery seals one-minute batches into immutable R2 objects, with a 2 MiB batch limit and a 256 KiB per-body limit. Larger observations retain their standalone R2 format. Each original JSON body and SHA-256 remains intact. Pending bodies are removed only after R2 confirms persistence; failed uploads retry from D1, with at most 64 pending batches per region. Shared objects remain protected until every observation and archive reference is retired.

Deploy the batch reader and additive migration before enabling the writer. Keep batch-reading support when reverting later collector changes. The container callback contract and sampling cadence do not change.
