# `@haneoka/chart`

Browser chart parser, simulator, input adapter, Three.js renderer, and Vue
components for _BanG Dream! Our Notes_.

```ts
import { buildChart, parseScore } from "@haneoka/chart";

const chart = buildChart(parseScore(scorePayload));
```

Public entries:

- `@haneoka/chart`
- `@haneoka/chart/assets`
- `@haneoka/chart/overview`
- `@haneoka/chart/parser`
- `@haneoka/chart/player`

`ChartPlayer` supports watch and play modes, audio synchronization, pointer
input, seeking, scoring, effects, and runtime asset manifests. `ChartOverview`
renders a virtualized full-chart view. Both require resources from the same
generated release.

Malformed score structures and unknown enum values are rejected. Renderer and
media failures are emitted through the component `error` event.

```sh
pnpm --filter @haneoka/chart typecheck
pnpm --filter @haneoka/chart build
```

The package is licensed under [MPL-2.0](LICENSE). Game resources and third-party
dependencies are not included in that grant.
