# Worker database workflow

This directory is Worker-side infrastructure. Application code reaches D1
only through Worker routes and prepared statements. Public feeds and profiles
have public read routes; writes and private reads enforce the authentication
and authorization policy of their route.

`schema.sql` is the complete target architecture for a new database.
`migrations/*.sql` is the ordered, immutable production history. Both are
committed and reviewed together.

Never commit production rows, local SQLite files, access tokens, secrets,
private moderation lists, or user content. `exports/`, `plans/`, `local/`, and
`*.sqlite*` are local operational data and remain ignored.

## Develop locally

Design the final structure in `schema.sql` first. For an existing local D1,
export its no-data schema and create an ignored manual plan:

```sh
pnpm db:schema:snapshot:local
pnpm db:plan:create add_saved_views
pnpm db:plan:apply:local worker/database/plans/<plan>.sql
pnpm db:schema:snapshot:local
```

The plan is deliberately local: it may contain compatibility and backfill SQL
for the developer database. Do not apply a manual plan to remote D1. Once the
local result is correct, express the production-safe change as the next
committed migration and update `schema.sql` in the same change.

For a brand-new empty local database only, bootstrap the target directly:

```sh
pnpm db:schema:bootstrap:local
```

Local development commands must never write to remote D1.

Applied migrations are immutable. Follow-up changes use a new monotonically
numbered file; never rewrite production history after deployment.

## Deploy

The production workflow owns remote writes:

1. install, type-check, and build the application;
2. apply pending committed migrations with Wrangler;
3. deploy the Worker.

The first committed `0004_reset_v1.sql` intentionally replaces the existing
prototype application tables with the v1 baseline while leaving Wrangler's
`d1_migrations` bookkeeping table intact. Take a private Cloudflare recovery
point before this one-time reset. Later migrations must preserve production
data unless their reviewed rollout explicitly says otherwise.

The read-only remote snapshot command remains available for operator diagnosis:

```sh
pnpm db:schema:snapshot:remote
```
