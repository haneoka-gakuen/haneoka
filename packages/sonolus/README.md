# `@haneoka/sonolus`

Our Notes chart conversion, catalog adapters, and Sonolus play, watch, preview,
and tutorial engines.

The package exports chart conversion plus release-backed catalog, level
template, and runtime chart-data providers. Hosts supply JSON, byte, and
template readers and compose them with `@haneoka/sonolus-core`.

## Build

```sh
pnpm --filter @haneoka/sonolus typecheck
pnpm --filter @haneoka/sonolus build
pnpm --filter @haneoka/sonolus build:assets
```

Built engine and repository assets are written to `dist/`. For a local server:

```sh
RESOURCE_RELEASE_ROOT=/absolute/path/to/release \
  pnpm --filter @haneoka/sonolus dev:server
```

Production routes are available under `/sonolus/*` through the Haneoka Worker.
Release-backed level identities include the server and immutable release ID.

## License

Haneoka-authored files are licensed under [MPL-2.0](LICENSE). The engine
contains work derived from `sonolus-pjsekai-engine`; preserve
[`engine/LICENSE.pjsekai.txt`](engine/LICENSE.pjsekai.txt) when redistributing
the engine or its builds. Game assets retain their own terms.
