<p align="center">
  <img src="docs/assets/haneoka-header.png" alt="Haneoka - an unofficial BanG Dream! Our Notes resource archive" width="1200" />
</p>

# Haneoka

[![CI](https://github.com/haneoka-gakuen/haneoka/actions/workflows/ci.yml/badge.svg)](https://github.com/haneoka-gakuen/haneoka/actions/workflows/ci.yml)
[![Deploy](https://github.com/haneoka-gakuen/haneoka/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/haneoka-gakuen/haneoka/actions/workflows/deploy-cloudflare.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-2f356f.svg)](LICENSE)

Haneoka is an unofficial resource archive and in-browser viewer for _BanG Dream! Our Notes_. It combines a searchable multilingual catalog, resource-backed media viewers, a WebGL rhythm-chart simulator, a Three.js and Live2D ADV story player, a Sonolus engine, and a reproducible resource-processing pipeline.

- Public catalog: [haneoka.org/catalog](https://haneoka.org/catalog)
- Source: [github.com/haneoka-gakuen/haneoka](https://github.com/haneoka-gakuen/haneoka)
- Sonolus endpoint: [haneoka.org](https://haneoka.org)

> [!IMPORTANT]
> Haneoka is a pre-release community project. The home page, catalog, community, chart editor, and story editor are available, while several catalog routes remain construction surfaces. Interfaces, generated schemas, editor project formats, and deployment procedures may change without a compatibility guarantee.

## Start here

Choose the path that matches the work you intend to do:

- **Browse the deployed archive:** use [haneoka.org](https://haneoka.org). No local toolchain or game package is required.
- **Review application code or run static checks:** install Node.js 24, enable Corepack, and follow [Install and validate](#install-and-validate). Python and game resources are not required for TypeScript-only checks.
- **Run catalog, chart, Live2D, or story media locally:** first prepare an authorized immutable resource release, then follow [Local preview](#local-preview). A fresh clone intentionally has no complete generated resource release; the small tracked third-party materials and other files outside Haneoka's MPL grant are documented separately.
- **Change resource processing or publication:** read [scripts/README.md](scripts/README.md) before running a pipeline command. Pipeline stages can process large inputs and publication commands can change remote R2 state.
- **Change accounts or community APIs:** use the Wrangler and local D1 workflow in [Accounts, OAuth, and community development](#accounts-oauth-and-community-development); the read-only preview server does not emulate those services.

The workspace packages are independently versioned and packable. Each package
declares public `exports`, generated declarations, its license boundary, and a
repository subdirectory so it can move to a standalone repository without
changing its public contract. The root application is one host of those
packages, not part of their runtime API.

## Available functionality

The following capabilities are implemented in the current source tree:

- catalogs for songs, member cards, support cards, characters, stories, comics, stamps, items, band items, and source assets;
- search, filtering, sorting, and detail views where supported by each catalog;
- song audio and video playback, an interactive 3D chart player, and a full-chart overview;
- ADV story playback with Three.js, Live2D Cubism, audio, seeking, and host-provided controls;
- a browser-local chart editor with lossless project JSON, SS JSON, USC and SUS import, visual authoring, preview, undo/redo, and export diagnostics;
- a browser-local story editor with visual, WebGAL, and Haneoka Project JSON views, native ADV/Episode import and export, catalog-resource insertion, playback preview, and loss-preserving format conversion;
- Live2D model preview and asset browsing, preview, and download tools;
- formation, Gekisou, game-option, help, and related data tools;
- D1-backed email/password accounts and optional Google, GitHub, X, and Discord OAuth;
- a D1-backed BBCode community feed with visibility, tags, bookmarks, comments, reactions, private R2 attachments, and automatic moderation;
- a Sonolus 1.1.2-compatible server with play, watch, preview, and tutorial engine targets;
- Japanese, English, Traditional Chinese, Simplified Chinese, and Korean interface catalogs.

The home page is implemented, but its schedule stays empty until a dedicated verified event source is connected. Events, gacha, login campaigns, shop, exchange, circle, and challenge routes use construction surfaces and must not be treated as completed catalogs. Community charts/stories, ranking, game, and unreleased user-directory/profile capabilities in `app/config/capabilities.ts` remain design inventory, not released features.

## Architecture

Haneoka is a pnpm monorepo whose packages are designed as publishable
boundaries. Workspace linking is used during development; consumers use only
the declared package exports.

| Path                                                          | Responsibility                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`app/`](app/)                                                | Nuxt 4 client application, catalog pages, shared UI, editors, and runtime composition   |
| [`packages/chart/`](packages/chart/README.md)                 | Chart parsing, scoring, input, Three.js rendering, and Vue chart components             |
| [`packages/chart-editor/`](packages/chart-editor/README.md)   | Browser-neutral chart project model, validation, history, and format adapters           |
| [`packages/story/`](packages/story/README.md)                 | Unity ADV command playback, Three.js scene rendering, Live2D, audio, and Vue components |
| [`packages/story-editor/`](packages/story-editor/README.md)   | Browser-neutral story project model, command semantics, validation, and format adapters |
| [`packages/bestdori/`](packages/bestdori/README.md)           | Bestdori transport, schemas, chart/story/Live2D adapters, and editor bridge             |
| [`packages/api-client/`](packages/api-client/README.md)       | Transport-injected catalog API client                                                   |
| [`packages/i18n/`](packages/i18n/README.md)                   | Framework-neutral locale matching and deterministic fallback                            |
| [`packages/design-tokens/`](packages/design-tokens/README.md) | Portable color, density, motion, radius, and elevation tokens                           |
| [`packages/ui/`](packages/ui/README.md)                       | Dense accessible Vue controls shared by hosts and editors                               |
| [`packages/sonolus-core/`](packages/sonolus-core/README.md)   | Dynamic chart repository and Sonolus document projection                                |
| [`packages/sonolus/`](packages/sonolus/README.md)             | Direct chart conversion, Sonolus engine targets, server documents, and asset builders   |
| [`scripts/`](scripts/README.md)                               | Python ingestion, resource processing, build, verification, and R2 publication pipeline |
| [`server/`](server/)                                          | Local generated-site preview and local release resolver                                 |
| [`worker/`](worker/)                                          | Cloudflare Worker for auth, community, catalog, media, home feed, and Sonolus routes    |
| [`worker/database/`](worker/database/README.md)               | Version-controlled D1 target schema and ignored operational snapshots/plans             |

The Nuxt application is generated as a client-side SPA (`ssr: false`). Production serves the static output through a Cloudflare Worker. Better Auth stores identities, linked OAuth accounts, and sessions in Cloudflare D1; the application schema stores profiles, posts, comments, reactions, and synchronized preferences in the same database. Catalog documents and media remain immutable releases in Cloudflare R2.

## Brand and social assets

The repository includes project-owned shooting-star branding in reusable source and delivery formats:

- `docs/assets/haneoka-header.svg` and `.png` for repository/document headers;
- `docs/assets/haneoka-social-card.svg` and `.png` for repository/social-preview configuration;
- `public/images/haneoka-social-card.png` for the website's Open Graph and Twitter card metadata;
- `public/favicon.svg` plus generated browser and application icon sizes.

`nuxt.config.ts` publishes absolute Open Graph and Twitter image metadata for the 1200 x 630 social card. GitHub's repository-level social preview is configured outside Git and must be uploaded from `docs/assets/haneoka-social-card.png` by a repository administrator. Do not replace project branding with third-party game artwork unless the required rights and notices have been established.

## Requirements

The supported toolchain follows the production workflows:

- Node.js 24;
- the exact pnpm release pinned by `package.json#packageManager`;
- Python 3.13 for the resource pipeline;
- FFmpeg and `vgmstream-cli` for complete CRI/media processing;
- a modern browser with WebGL2 for interactive renderers. The story renderer uses RGBA16 UNorm field targets when `EXT_texture_norm16` is available and automatically falls back to core RGBA8 targets when it is not.

Python, FFmpeg, and `vgmstream-cli` are not required for TypeScript-only checks or for generating the application shell. Full local catalog playback does require a prepared resource release.

## Install and validate

Enable Corepack so it selects the pnpm release pinned by `package.json`, then install the workspace:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Build and type-check the repository:

```sh
pnpm typecheck
pnpm lint
pnpm build
```

The Sonolus engine is part of the pnpm workspace, so the root install also installs its compilation tools. `pnpm typecheck` checks the Nuxt app, Worker, development tools, and all workspace packages.

Dependency ranges are centralized in the catalogs in `pnpm-workspace.yaml`. Renovate opens scheduled update PRs for pnpm, JavaScript packages, Python, GitHub Actions, and lock-file maintenance; updating `package.json#packageManager` changes the pnpm release selected by Corepack in local and CI installs.

All maintained JavaScript and Worker entrypoints are TypeScript. The committed `.js` browser runtimes under `public/Core` and `public/basis` are redistributed vendor artifacts, not project source. Keep parsing boundaries typed and validated instead of replacing missing models with `any`.

## Local preview

`pnpm build` writes the generated site to `.output/public`. The custom preview server serves that output together with a local catalog API and local media routes.

A fresh clone does not contain a complete generated resource release. It does include a small set of tracked third-party materials and other files outside Haneoka's MPL grant, all described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), but those files are not a runnable catalog/media payload. Before starting the preview server, provide one of these local release sources:

1. Build a release from a lawfully obtained APK, APKS/XAPK, or split-APK directory with the [resource pipeline](scripts/README.md). A successful local `build-release` or `run` selects a release under `data/servers/<server>/current.json`.
2. Set `RESOURCE_RELEASE_ROOT` to an existing immutable release directory containing a valid `release.json`.
3. Set `RESOURCE_BUILD_ROOT` to a prepared build workspace with the expected `api`, `assets`, `runtime`, `objects`, and `metadata` trees.

Then generate and serve the site:

```sh
pnpm build
HOST=127.0.0.1 PORT=3000 pnpm preview
```

Open `http://127.0.0.1:3000/catalog` for the catalog home or `http://127.0.0.1:3000/catalog/songs` for the song and chart catalog. Keep the preview process running while browsing; opening `.output/public/index.html` directly cannot serve the catalog API or generated media.

The preview defaults to `HOST=0.0.0.0`, `PORT=3000`, and `RELEASE_SERVERS=jp-cbt`. Binding to all interfaces is useful for testing an actual phone on the same trusted network, but it also makes the development server reachable from that network.

| Variable                   | Purpose                                                                                            | Default                         |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| `RELEASE_SERVERS`          | Ordered Our Notes releases for preview and detail/playlist fallback (never Bestdori regions)       | `jp-cbt`                        |
| `RELEASE_SERVER`           | Preferred Our Notes release selected at build time                                                 | first configured release        |
| `RESOURCE_RELEASE_ROOT`    | Explicit local immutable release directory                                                         | selected `current.json` release |
| `RESOURCE_BUILD_ROOT`      | Explicit prepared build directory                                                                  | unset                           |
| `BESTDORI_PROVIDER_ORIGIN` | Optional Worker/provider origin for transformed Garupa v1 API and `source=bestdori` Sonolus routes | unset (those routes return 503) |
| `BESTDORI_RAW_MIRROR_ROOT` | Optional local raw Bestdori tree, exposed only to the local Worker under an internal path          | unset                           |
| `HOST`                     | Local preview bind address                                                                         | `0.0.0.0`                       |
| `PORT`                     | Local preview TCP port                                                                             | `3000`                          |

`BESTDORI_PROVIDER_ORIGIN` is an HTTP(S) origin for a running Haneoka
Worker/Bestdori adapter, for example
`BESTDORI_PROVIDER_ORIGIN=http://127.0.0.1:8787 pnpm preview`. It is not a
Bestdori mirror URL and does not add a selectable Our Notes release. The
preview server proxies only `/api/v1/garupa/bestdori/*` and Sonolus requests
explicitly marked `source=bestdori` (or their Bestdori detail/data paths) to
that provider. Without it, those requests return a clear `503` instead of
falling through to a local-release or mirror `404`.

The Worker has a separate `BESTDORI_UPSTREAM_BASE`: it defaults to the public
Bestdori upstream and may instead be a path-prefixed HTTP(S) base for a raw
mirror. It is not `BESTDORI_PROVIDER_ORIGIN`. `pnpm dev` wires it automatically
to the local gateway's private raw-mirror path when a raw mirror is configured
or offline mode is selected.

`pnpm dev` starts Nuxt, the read-only release gateway, and the complete Worker
on available loopback ports. It initializes an isolated local D1 from the
committed schema when needed, plus local R2, Queue, moderation, and auth
bindings under `.wrangler/local-stack`; it does not touch production data or
execute the resource pipeline.

`pnpm preview` remains the project-specific generated-site and Sonolus server.
The same development command exposes Worker authentication, D1-backed
community APIs, and local write bindings. OAuth and real email delivery still
require explicitly configured development credentials.

Use `pnpm dev:offline` when every request must remain on the machine. Without a
Bestdori mirror, its routes report an upstream error in this mode while the
first-party release remains fully available. For a complete network-independent
session, point `BESTDORI_RAW_MIRROR_ROOT` at a local mirror whose root contains
`api/`, `assets/`, and `res/`, then use the strict commands:

```sh
BESTDORI_RAW_MIRROR_ROOT=/absolute/path/to/bestdori-mirror pnpm dev:offline:full
```

The mirror contains only original Bestdori paths (`/api/*`,
`/assets/<region>/*`, and `/res/*`). During `pnpm dev`, the release gateway
serves them only below `/_internal/providers/garupa/bestdori/raw/*` to the
Worker's `BESTDORI_UPSTREAM_BASE`; it never maps them onto top-level `/api` or
`/assets`. Its separate `BESTDORI_PROVIDER_ORIGIN` points back at that Worker
for transformed v1 and Bestdori Sonolus requests. A raw mirror must never be
used as the v1 provider.

The strict commands fail before startup when the mirror root or any required
top-level directory is missing. `pnpm dev` remains the explicit connected mode:
when no mirror is supplied, only Bestdori requests use its public upstream.

## Accounts, OAuth, and community development

The account implementation pins `better-auth@1.6.23` and uses its native D1/Kysely adapter. The small community MVP uses prepared D1 SQL directly, which keeps the existing dependency-light Worker understandable; an ORM can be introduced when the business schema or query surface grows enough to justify generated schema and migration tooling.

D1 does not provide interactive transactions, and Better Auth 1.6's native D1 adapter cannot make a callback containing several dependent auth writes atomic. Foreign keys protect referential integrity, and a daily Cron Trigger removes expired sessions/verifications, stale rate-limit rows, and old users left without any account record after an interrupted registration. This is compensating cleanup, not full transaction semantics; re-evaluate the adapter when Better Auth or D1 adds stronger support.

Copy the local secrets template and set a random secret of at least 32 characters. For a brand-new local D1 state, bootstrap it from the target schema and start the Worker:

```sh
cp .dev.vars.example .dev.vars
openssl rand -base64 32
# Paste the result into BETTER_AUTH_SECRET in .dev.vars.
pnpm db:schema:bootstrap:local
pnpm dev:worker
```

An existing local database must be changed with an ignored manual plan rather than bootstrapped again. The plan and explicit apply workflow is documented in [`worker/database/README.md`](worker/database/README.md).

Wrangler builds and serves the complete generated app and Worker at `http://localhost:8787`. The development script pins the local upstream to `localhost`; this keeps production custom-domain canonicalization out of local requests. Account registration and sign-in are at `/account`; the community feed is at `/community`. Google, GitHub, X, and Discord controls only appear when their matching values are present in `.dev.vars`. The account page mounts Turnstile only when the integration is enabled and both keys are configured; the checked-in `TURNSTILE_ENABLED` value remains `false`.

Production uses a native Cloudflare Email Sending binding restricted to `noreply@haneoka.org`. Password registration requires email delivery and verified ownership; there is no unverified-registration escape hatch. The account surface supports verification and resend, forgotten-password reset, profile/name changes, verified email changes, password changes, session inspection and revocation, and explicit OAuth linking/unlinking.

Wrangler development exposes the Email binding locally but does not deliver a production message to an inbox. Use local logs or a test harness to inspect the generated verification/reset link, and do not test a destructive production email flow with a real account unless that external communication is intentional.

The Worker uses Cloudflare's Rate Limiting binding for coarse community-write limits and the custom email-registration intake endpoint. Better Auth's own endpoints use its default limiter and storage; no blanket Cloudflare limiter sits in front of every auth route. A fixed outer auth route allowlist rejects unknown endpoints. The preserved Turnstile integration remains inactive unless `TURNSTILE_ENABLED=true` and both keys are configured.

Because Cloudflare's edge limiter is best-effort, storage growth is also guarded inside D1: each account can create at most 30 posts per hour and 200 per day, plus 300 comments per hour and 2,000 per day. The quota checks and inserts share one SQL statement so concurrent requests cannot bypass the limit. Feed pages return 500-character excerpts; only the detail endpoint returns full post bodies.

### Production account setup

This repository is configured for the existing `haneoka-community` D1 database in APAC, the private `haneoka-community-uploads` R2 bucket, the `haneoka.org` Email Sending domain, and the `haneoka-auth` Turnstile widget. `worker/database/schema.sql` is the committed target architecture and `worker/database/migrations/` is its ordered production history. Build before deployment:

```sh
pnpm typecheck
pnpm build
```

The deployment workflow applies pending committed migrations only after the build succeeds and then deploys the Worker. Local manual plans are deliberately ignored and cannot be applied remotely. Take a private D1 recovery point before any destructive migration.

Before deploying, verify that `BETTER_AUTH_SECRET` and `TURNSTILE_SECRET_KEY` exist as Worker secrets for the target Cloudflare account. Git cannot establish the current state of deployed secrets. The Turnstile site key is public and lives in Wrangler `vars`. An OAuth provider becomes visible only after both of its credentials are added as Worker secrets:

```sh
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
pnpm wrangler secret put TWITTER_CLIENT_ID
pnpm wrangler secret put TWITTER_CLIENT_SECRET
pnpm wrangler secret put DISCORD_CLIENT_ID
pnpm wrangler secret put DISCORD_CLIENT_SECRET
```

Only configure a provider when both its client ID and secret are available. Register these exact production callback URLs with the providers:

- `https://haneoka.org/api/auth/callback/github`
- `https://haneoka.org/api/auth/callback/google`
- `https://haneoka.org/api/auth/callback/twitter`
- `https://haneoka.org/api/auth/callback/discord`

X uses Better Auth's `twitter` provider ID. Enable Twitter API v2 email access (`user.email`) in the developer application because Haneoka requires an email-backed account. Discord phone-only accounts may return no email and cannot be used until an email is attached to the Discord account.

For local development, register the equivalent callbacks under `http://localhost:8787`. GitHub OAuth Apps accept one callback URL, so use a separate development app with homepage `http://localhost:8787` and callback `http://localhost:8787/api/auth/callback/github`. Put all development client IDs and secrets only in `.dev.vars`; never reuse or commit production client secrets.

The first administrator must register normally, verify the account email, and copy the UID shown on `/account`. Grant the role by UID with the explicit operator command; remote use is interactive and requires the database-name confirmation:

```sh
pnpm db:admin:grant --local --uid=<uid>
pnpm db:admin:grant --remote --uid=<uid> --confirm-remote=haneoka-community
```

Forks must provision their own D1 database, private community-upload bucket, Email Sending domain/DNS records, Turnstile widget, and secrets. They must also replace the D1 UUID, bucket names, sender address, site key, domains, and routes in `wrangler.jsonc`.

The Cloudflare deployment workflow builds first, applies pending committed D1 migrations, exports the resulting schema, and rejects drift before deploying a new Worker version. Its API token therefore needs Workers deployment permission and the minimum D1 write access required for migrations. Remote administrator bootstrap remains an explicit interactive operator command and cannot run in CI.

### Data placement

| State or feature                                                                                                                       | Recommended store                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Users, linked OAuth identities, sessions, roles, bans, profiles, posts, comments, reactions, follows, favorites, and revision metadata | D1                                                                               |
| Locale, release server, story/chart settings                                                                                           | Keep local-first; synchronize to D1 after sign-in                                |
| Audio queue, favorites, and viewing/play history                                                                                       | Move to D1 only when cross-device continuity is a product requirement            |
| Current playback time, scroll position, sidebar state                                                                                  | Keep in browser storage; these are device-local and write frequently             |
| Search/filter/detail selections encoded in the URL                                                                                     | Keep in the URL so views remain shareable                                        |
| Catalog entity lookup and server-side search                                                                                           | Optional derived D1 index; keep immutable release JSON as the R2 source of truth |
| R2 CAS objects, release manifests/indexes, `current.json`, media, uploads, and large community artifacts                               | Keep in R2; D1 stores metadata, ownership, hashes, and object keys               |
| Email, notifications, moderation jobs, search indexing, and media processing                                                           | Cloudflare Queues                                                                |
| Realtime chat, presence, or collaborative editing                                                                                      | Durable Objects when those features exist; not needed for the current feed       |
| Public low-consistency feature flags or derived hot caches                                                                             | KV is optional; do not use it as the identity or authorization source of truth   |

Community uploads use a two-stage, same-origin Worker API. D1 atomically enforces ownership, idempotency, a 100 MiB active per-user quota, attachment state, SHA-256 metadata, and post links; the bytes live in the private `COMMUNITY_UPLOADS` R2 bucket. JPEG, PNG, WebP, and plain-text uploads are bounded and signature-checked, then remain unreadable to other users until Queue-backed moderation allows them. Downloads always return through the Worker and re-check the current user, post visibility, lifecycle, and moderation state. The bucket has no public development URL or browser CORS policy.

The authoritative database layout lives under [`worker/database/`](worker/database/README.md). `schema.sql` is the complete target and committed migrations are the only production mutation path. Wrangler no-data exports, local SQLite state, and manually reviewed local plans are ignored; CI applies pending migrations and verifies the real production structure before deployment. Secrets, production rows, user content, and private moderation lists remain outside Git. The SQL structure itself is not a credential and is never included in the Nuxt static output.

## Internationalization

Japanese fallback messages live with the application; the other four catalogs
are static `/public/i18n/*.json` resources loaded on demand. Locale matching,
message resolution, and archive-value fallback rules live in
`@haneoka/i18n`, while the Nuxt host owns reactive loading and locale fonts.

Archive fields resolve in a stable order: the requested locale, the Japanese source slot, then the remaining declared locales. The resolver preserves the locale of the slot or object key that actually supplied the text. Visible archive text must be rendered through the shared display-text components so the resulting element receives the matching BCP 47 `lang` value and Noto Sans language family. A plain string has no trustworthy locale metadata and is marked `und` unless the caller supplies an explicit source hint; scripts and glyph shapes are never used to guess its language. String-only localization remains available for search keys, sorting, and non-visible identifiers.

When changing interface copy:

1. update the same key in all five locale files;
2. preserve interpolation placeholders across locales;
3. run the complete `pnpm typecheck` command.

Components should use `useLocale()` instead of embedding page-specific language maps. Use `resolveLocalized()` for visible archive data and `localize()` only where language metadata is not rendered. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete contribution checklist.

## Resource pipeline

The pipeline can process operator-supplied Android package inputs and their referenced resources, creates immutable source and release identities, normalizes Unity and CRI data, builds API and runtime derivatives, verifies them, and can publish content-addressed objects to R2. Inputs must come from a source the operator is authorized to access.

Start with [scripts/README.md](scripts/README.md). It documents Python setup, external tools, all stage commands, local output layout, GitHub Actions operation, credentials, publication ordering, retention, and garbage collection.

## Production deployment

Production configuration is defined by `wrangler.jsonc` and `.github/workflows/deploy-cloudflare.yml`:

- a push to `main`, or a manual workflow dispatch, builds with Node 24 and pnpm 11.14.0;
- the workflow type-checks the workspace and deploys the generated SPA plus `worker/index.ts` to Cloudflare Workers;
- the workflow applies pending committed D1 migrations, exports the resulting schema, and refuses deployment when it differs from `worker/database/schema.sql`;
- the Worker binds static assets as `ASSETS`, the resource bucket as `ASSET_BUCKET`, and the account/community database as `DB`;
- `haneoka.org` is canonical and serves the Sonolus endpoint under `/sonolus/*`.

A fork must replace the custom domains and R2 bucket in `wrangler.jsonc`, provision its own D1 database, configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and publish a compatible resource release before the catalog can return data. Resource publication uses separate R2 credentials and per-server authorization described in [scripts/README.md](scripts/README.md#github-actions-operation). Never commit deployment credentials, auth/OAuth secrets, CDN authorization values, or private game packages.

## Contributing and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for the first-contribution workflow, local setup, checks, package boundaries, and pull request expectations.
- Use [Q&A](https://github.com/haneoka-gakuen/haneoka/discussions/categories/q-a) for setup or contribution questions and [Ideas](https://github.com/haneoka-gakuen/haneoka/discussions/categories/ideas) for early proposals.
- Use the [issue chooser](https://github.com/haneoka-gakuen/haneoka/issues/new/choose) for reproducible bugs, catalog/resource reports, documentation corrections, and focused feature proposals.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Use [SUPPORT.md](SUPPORT.md) to choose the correct support channel.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

Bug reports for rendering or responsive-layout problems should include the exact device, operating-system version, browser version, viewport/orientation, affected URL, and screenshots or recordings. A desktop reproduction is useful but is not a substitute for testing device-specific Safari or mobile-GPU behavior.

## License and legal status

Haneoka-authored source code, documentation, and identified MPL-covered adaptations in the current revision are available under the [Mozilla Public License 2.0](LICENSE), unless a file or package says otherwise. MPL-2.0 is a file-level copyleft license: distributions of covered source files and modifications must preserve MPL-2.0, and executable distributions must tell recipients how to obtain the corresponding covered source. It still permits use, modification, distribution, and commercial use. Revisions previously published under MIT remain available under the license attached to those revisions; changing the current tree does not revoke an earlier grant.

Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before using or distributing the project. It records vendored Live2D components, the Spine Runtime, Basis Universal transcoder artifacts, Sonolus- and Next-SEKAI-derived code, WebGAL interoperability code and Terre-derived editor interface files, bundled fonts and icons, and media whose redistribution rights must be evaluated independently. Each workspace package also carries a local `LICENSE` and links to any additional upstream notice that applies to files inside that package.

Haneoka is operated as an independent, unofficial, non-commercial fan project for learning and community exchange. That description of the project does not add a non-commercial restriction to Haneoka-authored material covered by MPL-2.0. Haneoka is not authorized, affiliated with, endorsed by, sponsored by, or otherwise connected to BanG Dream! Project, Bushiroad Inc., FROM TOKYO Inc., bilibili game, or other rights holders. BanG Dream!, BanG Dream! Our Notes, and related names, marks, characters, artwork, audio, video, stories, text, data, fonts, and other game materials belong to their respective owners.

Game-related material displayed or indexed by Haneoka may come from operator-supplied packages, official pages, or generated metadata and is used by this project for individual learning, research, commentary, and non-commercial community exchange. Online availability, source attribution, or inclusion in this project does not place material in the public domain, establish that Haneoka owns it or is authorized to use it, or grant any permission for further use.

Haneoka-authored application code and modifications to identified MPL-covered files are licensed only to the extent the contributors can grant those rights. Adapted and third-party files retain the provenance and terms recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the repository license does not cover game materials, publisher code, trademarks, proprietary runtimes, or separately licensed components.

MPL-2.0 grants rights in the Covered Software, including the identified MPL-covered adaptations; Haneoka contributors grant only their own contributions. It grants no rights to game material, publisher code, proprietary runtimes, separately licensed components, or trademarks. Any use of those materials must independently comply with the applicable terms and law; removal of notices, circumvention of access controls, and unlawful or rights-infringing conduct are not authorized by this repository.
