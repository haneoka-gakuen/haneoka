# `@haneoka/chart-editor`

Framework-neutral chart-authoring core with project models, timing, validation,
undo history, waveform analysis, viewport helpers, and format adapters.

Supported formats:

| Format | Import | Export |
| --- | --- | --- |
| Haneoka Project JSON | Yes | Yes |
| SS JSON | Yes | Yes |
| Universal Sekai Chart | Yes | Yes |
| SUS | Yes | No |
| Sonolus `LevelData` | Detect only | No |

```ts
import { importChart, serializeProjectJson } from "@haneoka/chart-editor/formats";
import { validateProject } from "@haneoka/chart-editor/validation";

const { project, warnings } = importChart(sourceText);
if (validateProject(project).valid) {
  const saved = serializeProjectJson(project);
}
```

The host provides the user interface, files, storage, and audio decoding.
Conversion warnings must be shown to the user.

```sh
pnpm --filter @haneoka/chart-editor typecheck
pnpm --filter @haneoka/chart-editor build
```

Licensed under [MPL-2.0](LICENSE). Preserve the included Next-SEKAI license
notices when redistributing adapted files.
