# `@haneoka/sonolus-engine`

`@haneoka/sonolus-engine` is the Sonolus engine workspace for Haneoka's direct Our Notes chart runtime. It builds the play, watch, preview, and tutorial engine data consumed by the parent `@haneoka/sonolus` release pipeline.

This is a private build package. It is not published to npm and has no JavaScript `exports` map; its public products are the generated Sonolus engine files in `dist/`.

## Targets and layout

| Path        | Purpose                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `play/`     | Interactive play engine and CLI configuration                             |
| `watch/`    | Replay/watch engine and CLI configuration                                 |
| `preview/`  | Static chart-preview engine and CLI configuration                         |
| `tutorial/` | Interactive tutorial engine and CLI configuration                         |
| `shared/`   | Archetypes, chart data, scoring, rendering, options, and shared resources |
| `scripts/`  | Package-local build and license-retention helpers                         |

All four targets must use a compatible `EngineConfiguration`. The repository workflow builds them independently, compares the configuration output, and assembles one deployable artifact.

## Build outputs

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/sonolus/engine run build
```

The build first type-checks package tools, then invokes `sonolus-cli` for every target. A successful `dist/` contains:

- `EngineConfiguration`;
- `EnginePlayData`;
- `EngineWatchData`;
- `EnginePreviewData`;
- `EngineTutorialData`;
- `LICENSE`, the complete Haneoka MPL-2.0 terms;
- `NOTICE.txt`, the Haneoka scope and corresponding-source notice;
- `SOURCE.txt`, the exact source revision when a CI revision is available, otherwise the source repository;
- `LICENSE.pjsekai.txt`, the retained upstream MIT notice.

These files are intermediate release inputs. The parent package combines them with generated skin, effect, particle, background, level, and repository objects. Building this workspace does not publish resources or switch a production release pointer.

To check only the Node-side package tools:

```sh
pnpm --dir packages/sonolus/engine run typecheck:tools
```

The engine deliberately uses the `sonolus-engine` dependency catalog in the root workspace. Do not update its Sonolus or TypeScript versions independently without rebuilding all four targets and validating the generated data together.

## Runtime boundary

This engine consumes protocol data compiled by `packages/sonolus/src/convert/`; it does not parse editor projects, fetch catalog APIs, or serve HTTP. The browser renderer lives in `@haneoka/chart` and remains the browser fidelity target. Sonolus mappings are constrained by Sonolus result, rendering, particle, effect, and input models.

## License and provenance

Haneoka-authored changes are covered by this package's [MPL-2.0 notice](LICENSE) and the repository license text.

The implementation was originally derived from NonSpicyBurrito's MIT-licensed [`sonolus-pjsekai-engine`](https://github.com/NonSpicyBurrito/sonolus-pjsekai-engine) and has since been adapted for direct Our Notes data and assets. The original import did not record a trustworthy exact upstream revision, so this repository does not claim a commit that it cannot establish. The upstream copyright and permission text is preserved verbatim in [`LICENSE.pjsekai.txt`](LICENSE.pjsekai.txt); distributions containing the corresponding code must retain that MIT notice as well as the Haneoka MPL-2.0 notice for covered modifications. Additional third-party resource assets assembled by the parent package are outside both grants; see the repository [third-party notices](../../../THIRD_PARTY_NOTICES.md).
