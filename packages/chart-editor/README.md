# `@haneoka/chart-editor`

`@haneoka/chart-editor` is a browser-neutral chart-authoring core. It defines the canonical project model, timing and viewport calculations, undo history, validation, waveform analysis, and import/export adapters. A host application owns the visual editor and file handling.

The package publishes tree-shakeable ES2022 ESM and declarations from `dist/`. It has no UI framework, storage, network, or application dependency and can be installed as a standalone package.

## Project contract

- Canonical timing uses integer 480 PPQ. BPM, meter, and visual time-scale events have stable IDs.
- `laneBasis` records the source coordinate system; SS export maps the result to 24 lanes.
- Authored SS `pos: "auto"`, omitted automatic widths, zero widths, and out-of-stage coordinates survive project saves.
- Haneoka Project JSON is the lossless editing format. Adapter-specific data stays in `extensions`, and source order stays in `sourceOrder`.
- Format conversion can be lossy. Callers must present import/export diagnostics instead of silently discarding data.
- Sonolus `LevelData` is a deployment artifact. It can be detected but is intentionally not reverse-converted into an authoring project.

## Entry points

| Import                             | Purpose                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `@haneoka/chart-editor`            | Complete model, timing, history, validation, viewport, waveform, and format surface |
| `@haneoka/chart-editor/formats`    | Format detection and Project JSON, SS, USC, SUS, and Sonolus adapters               |
| `@haneoka/chart-editor/history`    | Generic `ProjectHistory` undo/redo model                                            |
| `@haneoka/chart-editor/model`      | Canonical project types, constants, IDs, sorting, and lane helpers                  |
| `@haneoka/chart-editor/timing`     | Tempo maps, tick/second conversion, and snapping                                    |
| `@haneoka/chart-editor/validation` | Project validation and structured issues                                            |
| `@haneoka/chart-editor/viewport`   | Editor viewport transforms and visible-range helpers                                |
| `@haneoka/chart-editor/waveform`   | Audio waveform-bin generation                                                       |

## Formats

| Format                | Import      | Export | Notes                                               |
| --------------------- | ----------- | ------ | --------------------------------------------------- |
| Haneoka Project JSON  | Yes         | Yes    | Canonical, lossless editing format                  |
| SS JSON               | Yes         | Yes    | Native `@haneoka/chart` bridge                      |
| Universal Sekai Chart | Yes         | Yes    | Flat and wrapped USC documents                      |
| SUS                   | Yes         | No     | Next-SEKAI-compatible import semantics              |
| Sonolus `LevelData`   | Detect only | No     | Runtime/deployment artifact, not an authored source |

The application builds `chart`, `watch`, and `play` modes from the canonical project. Sonolus output is produced through the explicit USC/Sonolus boundary rather than by maintaining a second editor model.

## Minimal use

```ts
import { importChart, serializeProjectJson } from "@haneoka/chart-editor/formats";
import { validateProject } from "@haneoka/chart-editor/validation";

const { project, warnings } = importChart(sourceText);
const validation = validateProject(project);

if (validation.valid) {
  const saved = serializeProjectJson(project);
}
```

`importChart` accepts strings, byte arrays, and already-parsed JSON values. A host is responsible for choosing files, decoding audio, persisting projects, and showing `warnings` and validation issues.

## Host boundary

This package deliberately has no Vue, DOM, Canvas, storage, network, or application-state dependency. UI code should mutate the canonical project through this package rather than inventing a second chart schema.

## Failure behavior

Format detection and imports reject syntactically invalid or structurally unsupported input with `ChartFormatError`. Successful imports can still return warnings for lossy or approximate mappings; callers must surface them. `validateProject` returns structured issues without mutating the project, while assertion helpers throw when a hard-valid project is required. The package never reads files, fetches resources, or persists recovery state on a caller's behalf.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @haneoka/chart-editor typecheck
pnpm --filter @haneoka/chart-editor build
pnpm --filter @haneoka/chart-editor pack --dry-run
```

`build` emits executable multi-entry ESM, declarations, and source maps under `dist/`; every public export resolves there. `prepack` repeats type checking and the clean build.

## License and provenance

Haneoka-authored code is covered by this package's [MPL-2.0 notice](LICENSE) and the repository license text.

The SUS analyzer contains work adapted from the MIT-licensed [Next-SEKAI engine](https://github.com/Next-SEKAI/sonolus-next-sekai-engine); preserve [`LICENSE.next-sekai.txt`](LICENSE.next-sekai.txt). The related Haneoka application toolbar contains work adapted from the MIT-licensed [Next-SEKAI editor](https://github.com/Next-SEKAI/sonolus-next-sekai-editor); its notice is retained here as [`LICENSE.next-sekai-editor.txt`](LICENSE.next-sekai-editor.txt). Both notices are included in the published archive. See the repository's [third-party notices](https://github.com/haneoka-gakuen/haneoka/blob/main/THIRD_PARTY_NOTICES.md) for the complete attribution boundary.
