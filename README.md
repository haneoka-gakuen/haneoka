<p align="center">
  <img src="docs/assets/haneoka-header.png" alt="Haneoka" width="1200" />
</p>

# Haneoka

[![CI](https://github.com/haneoka-gakuen/haneoka/actions/workflows/ci.yml/badge.svg)](https://github.com/haneoka-gakuen/haneoka/actions/workflows/ci.yml)
[![Deploy](https://github.com/haneoka-gakuen/haneoka/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/haneoka-gakuen/haneoka/actions/workflows/deploy-cloudflare.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-2f356f.svg)](LICENSE)

Unofficial database, tools and community for *BanG Dream! Our Notes*, at [haneoka.org](https://haneoka.org).

## Features

- Searchable catalogue in five languages, for every server
- Audio, video, comic, Live2D, Spine and story viewers
- Chart and story players, with Sonolus-compatible engines
- Team builder with separate server inventories, event planning, card import, manual skill-order editing and best/worst cumulative-timing score goals
- Chart editor with an on-demand beginner guide, practice chart, compact original-note tools, direct canvas editing, three flick directions, SEKAI chart import into Our Notes, Bestdori-style shortcuts, cloud drafts, version history, publishing and remixes; authors can continue editing their charts from the detail page
- Community charts ranked by the shared post recommendation system, with latest, popularity and difficulty sorting
- Gekiso Arena schedule, rankings, song rules and team building
- Event trackers, player lookup, song rankings and calendars; rankings share player ID and username search
- Song jacket puzzles with original-game openings, screenshot recognition, local progress, faster solving and independent step-by-step replay
- Community posts, playlists and accounts
- Embeddable players and a [public API](https://docs.haneoka.org)
- [Native app](https://github.com/haneoka-gakuen/haneoka-app) for Android, iOS, Windows, macOS and Linux

The site is an Astro application with route-scoped Lit workspaces. `src/components` holds the shell, `src/lit` the workspaces, and `src/styles` the Material Design 3 styles.

## Development

Start with the [repository map](L1.md) and [development guide](docs/DEV_GUIDE.md)
to find the relevant source area and checks. Architecture maps and core file
coordinates follow the [GEB maintenance guide](docs/GEB使用与维护指南.md).

Requirements:

- Node.js 24 and Corepack
- Python 3.13, FFmpeg, and `vgmstream-cli` when processing resources
- A modern WebGL2 browser for interactive renderers

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
HANEOKA_CUBISM_RUNTIME_POLICY=optional pnpm build
```

Run the application and Worker locally:

```sh
cp .dev.vars.example .dev.vars
pnpm db:schema:bootstrap:local
pnpm dev:worker
pnpm dev
```

For a static build with the local catalog preview server:

```sh
pnpm build
HOST=127.0.0.1 PORT=3000 pnpm preview
```

A complete catalog requires an authorized resource release. Build one with the
[resource pipeline](scripts/README.md), or set `RESOURCE_RELEASE_ROOT` to an
existing release directory. Cubism playback also requires an authorized
runtime at the path printed by `pnpm runtime:cubism:source-path`, or through
`HANEOKA_CUBISM_RUNTIME_DIR`.

For Bestdori content, provide a local mirror containing `api/`, `assets/`, and
`res/` to the Worker:

```sh
BESTDORI_RAW_MIRROR_ROOT=/absolute/path/to/bestdori-mirror pnpm dev:worker
```

## Data and deployment

- Catalog documents and media are stored as immutable releases in R2.
- Accounts and community data use D1.
- Production schema changes use committed migrations under
  [`worker/database`](worker/database/README.md).
- Production deployment is defined in `wrangler.jsonc` and
  `.github/workflows/deploy-cloudflare.yml`.

Forks must configure their own Cloudflare Worker, D1 database, R2 buckets,
email sender, Turnstile widget, OAuth applications, domains, and secrets.
Never commit credentials, private packages, or licensed runtime files.

### Production domains

`haneoka.org` and `haneoka.com` use the same Worker, accounts, D1 databases and
R2 buckets. `haneoka.com` remains on external DNS and is registered as a
Cloudflare for SaaS custom hostname in the `haneoka.org` zone. `haneoka.org`
uses a Workers Custom Domain with Cloudflare-managed DNS and certificates;
`haneoka.com` uses an explicit Worker route. `/downloads/*` belongs to the
download Worker on both domains.

Authentication, account email links, media and Sonolus URLs use the current
allowed hostname. Search canonical URLs stay on `haneoka.org`. Login cookies
and browser storage are separate for each domain; cloud data uses the same
account. `BETTER_AUTH_URL` remains the canonical fallback for background jobs.

Register both `https://haneoka.org/api/auth/callback/<provider>` and
`https://haneoka.com/api/auth/callback/<provider>` in each enabled OAuth
provider's application. Keep `noreply@haneoka.org` as the verified email sender.
If Turnstile is enabled, allow both hostnames in the widget and
`TURNSTILE_ALLOWED_HOSTNAMES`.

Cloudflare Hotlink Protection checks the SaaS zone's domain. Add a Configuration
Rule with expression `starts_with(http.referer, "https://haneoka.com/")` and set
Hotlink Protection to Off for that rule, allowing images referenced by `.com`
pages. Validate both domains' pages, images, session API, OAuth redirect URLs,
Sonolus resources and download routes after deployment.

Set `COMMUNITY_HIDDEN_HOSTS` to a comma-separated list of hostnames that hide
community pages and comments. The production default is `haneoka.com`;
`haneoka.org` keeps the complete community. Hidden hosts return 404 for
community documents, legacy community routes and comment APIs, and hide the
navigation entry, home recommendations, community links and comment sections.
Authentication, account tools and private cloud synchronization remain available.
Clear the value to restore the community, and reload the page. Local Astro
development accepts the same environment variable for its local hostname.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), and
[SECURITY.md](SECURITY.md).

## License

Haneoka-authored files are licensed under [MPL-2.0](LICENSE) unless noted
otherwise. Third-party runtimes, adapted code, fonts, icons, and game materials
retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Haneoka is an unofficial project and is not affiliated with or endorsed by the
rights holders of _BanG Dream!_ or _BanG Dream! Our Notes_.
