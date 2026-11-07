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

### Sponsor page

The sponsor page reads `GET /api/v1/sponsors` from the Worker, which combines
two layers stored in D1:

- **Source layer, refreshed automatically.** Each production build reads Afdian
  and Patreon with the creator credentials in the CI environment
  (`AFDIAN_USER_ID`, `AFDIAN_TOKEN`, `PATREON_CREATOR_TOKEN`, optional
  `PATREON_CAMPAIGN_ID`) and publishes `/data/sponsors/v1.json`. The first
  request after a deploy copies a newer snapshot into D1. Ko-fi payments arrive
  by webhook (`KOFI_VERIFICATION_TOKEN`) and are already in D1; a public
  payment's message is kept as that supporter's message. Supporters a platform
  stops listing move to past supporters and stay there. A supporter the
  platform lists without a name (Patreon members who hide their identity) is
  removed from both lists, including any edits made to that entry, until the
  platform shows the name again.
- **Administrator layer.** Admins manage it under **Admin → Sponsors**:
  - Edit a supporter's display name, avatar URL, message, channel, tier,
    amount, status, and dates. An edited field keeps its value through later
    syncs; the undo button beside it returns the field to the platform's value.
    Saving an empty avatar or message clears it for display; the clear button
    beside the amount publishes no amount.
  - Hide a synchronized supporter. The hidden entry stays as a tombstone, so
    the next sync does not bring it back; switching it on restores it.
  - Add a supporter by hand after matching a payment in your own records (for
    example Alipay or WeChat Pay), or remove one you added. Status follows the
    dates unless set: current for 32 days after the latest support.
  - Edit tiers: names in all five languages, order, monthly CNY / USD
    thresholds, and an optional card. The first tier without a threshold takes
    one-off and below-threshold support. Platform tiers are recalculated with
    the new thresholds at the next build; Ko-fi immediately.

Every change is audited under Operations and reaches the public page on the
next load without a rebuild. Supporters are keyed by their platform identity (a
digest of the Afdian user ID, the Patreon member ID, or the Ko-fi email), never by name
or avatar; the same person on two platforms stays as two entries. The public list carries display fields only: no emails,
payment IDs, or identity digests. Add only what the supporter agreed to show.

Amounts appear only beside supporters, current or past, in a tier without
thresholds (flexible support), as the supporter's own amount in its original
currency; tiers with thresholds show none. A past platform supporter keeps the
last tier they held while current. A Ko-fi supporter's amount is their latest public
payment. Afdian and Patreon report plan prices and lifetime totals, which the
site does not publish, so their amounts, like those of hand-entered
supporters, are entered in the admin editor. The build snapshot carries no
amounts.

Messages exist where the platform makes them public. Ko-fi webhooks carry the
supporter's message, so new public Ko-fi payments show it; payments received
before this change were stored without one. Afdian and Patreon creator APIs
return no public message; type one in the admin editor when a supporter asks
for it. A static Alipay or WeChat receiving code tells the site nothing about a
payment, so those supporters, and any message they left in the payment note,
are entered by hand.

Avatars come from the platform profile: Afdian's avatar, including its default
image, and Patreon's profile image, or its thumbnail when the image is empty.
A supporter who hides their profile has no avatar. Ko-fi webhooks carry a name
but no avatar or profile, so a Ko-fi supporter's avatar is an admin-entered
public image URL.

**Alipay and WeChat codes:** put the image under `public/sponsor/` and add
`{ id, image, width, height }` to `SPONSOR_QR_CODES` in
[`src/config/sponsor.ts`](src/config/sponsor.ts). A channel appears only once
it has an entry.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), and
[SECURITY.md](SECURITY.md).

## License

Haneoka-authored files are licensed under [MPL-2.0](LICENSE) unless noted
otherwise. Third-party runtimes, adapted code, fonts, icons, and game materials
retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Haneoka is an unofficial project and is not affiliated with or endorsed by the
rights holders of _BanG Dream!_ or _BanG Dream! Our Notes_.
