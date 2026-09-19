# Haneoka Sonolus service adapter

The website keeps release-backed catalog, level-template and runtime chart-data
providers here. Chart conversion is re-exported from
`@haneoka/cassiopeia-plugin-sonolus`; the four engine targets live in that
independent plugin repository. No engine or chart-normalization copy is retained
in this website package.

Use `pnpm sonolus:build` to build the locked plugin engine and assemble the
host's assets. Production HTTP routes and release storage remain website-owned.
For unpublished local commits, first materialize the external repository lock
with `HANEOKA_DEPENDENCY_SOURCE_ROOT=/path/to/local/repositories pnpm dependencies:checkout`.

The plugin preserves the upstream Project SEKAI engine's MIT notice; generated
resources include that notice alongside Haneoka's MPL-2.0 license.
