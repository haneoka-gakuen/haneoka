# @haneoka/bestdori

Browser-neutral contracts and pure converters for Bestdori data. The package
contains no network client, cache implementation, UI, Node.js, or Cloudflare
dependency.

`@haneoka/bestdori/cache-policy` exports the small, shared freshness windows
used by browser and Worker hosts. It is only a set of pure policy values: hosts
still own their transport, edge cache, and in-memory cache implementations.

```ts
import { convertBestdoriScenario } from "@haneoka/bestdori/scenario";

const result = convertBestdoriScenario(source, {
  server: "jp",
  voiceBundle: "sound/voice/scenario/bandstory1_rip/",
  proxify: (path) => `/api/v1/bestdori/raw${path}`,
});
```

Chart conversion is exposed separately so an application can keep the generic
chart runtime independent from Bestdori's wire format:

```ts
import { bestdoriChartToSs } from "@haneoka/bestdori/chart";

const score = bestdoriChartToSs(await transport.getChart(songId, difficulty));
```

The directional-note anchor and repair behavior are traced to the published
simulator in [`CHART_VIEWER_EVIDENCE.md`](./CHART_VIEWER_EVIDENCE.md).

Applications provide their own transport by implementing `BestdoriTransport`.
This keeps browser, worker, server, test, and command-line adapters independent
from the format and conversion logic.

The optional `@haneoka/bestdori/story-editor` entry adapts converted scenarios
to the public `@haneoka/story-editor` project contract. Keeping that integration
on the source side prevents the generic editor package from depending on a
particular archive service.

Cubism 2 conversion returns the same resource boundary used by generic hosts:
model placement defaults live in a top-level `profile`, while format and file
references stay in `runtime`. Scene-specific camera and canvas sizing remain in
the converted story runtime rather than being baked into a reusable model.

Scenario placement is evidence-backed. The published viewer's bundle defines a
16:9 canvas, `sideToX` anchors (`-1.2`, `-0.34`, `0`, `0.34`, `1.2`), horizontal
offsets in units of `offsetX / 640`, and model defaults `y=-0.12`, `scale=1.25`.
The adapter unprojects that clip-space composition onto the host ADV scene's
perspective character plane. Source coordinates therefore become world-space
positions governed by the same camera, focus, depth, blur, grading, transition,
and lifecycle rules as native Cubism models and static portraits.
