# `@haneoka/sonolus`

`@haneoka/sonolus` contains Haneoka's direct Our Notes chart converter and the runtime-neutral adapters that project a revisioned chart catalog into Sonolus level routes. The repository also contains optional play/watch/preview/tutorial engine targets and Node-based development/release tools.

The published package exposes the converter and provider APIs. Production and local hosts supply their own catalog, byte, and template readers; the package does not import Haneoka's data pipeline or database modules.

## Design boundary

The converter reads the same source model as `@haneoka/chart` and preserves authored Our Notes fields in Sonolus `LevelData`, including operate type, judgment type, direction, timing, lane values, line references, and independent left/right easing data.

It does not translate charts through USC or Project SEKAI semantics. Sonolus remains a separate runtime with its own protocol and rendering limits; it is not the browser fidelity renderer.

## Package interface

The root export provides chart conversion plus `ReleaseChartCatalogProvider`, `ReleaseLevelTemplateProvider`, and `RuntimeChartDataProvider`. Combine them with `SonolusLevelService` from `@haneoka/sonolus-core` and host-owned `readJson`/`readBytes` functions. The level template is derived from the release's engine document, not from a generated level. A revision change creates a new bounded snapshot, so newly published or removed charts are discovered at request time instead of being frozen into the web build.

The Node utilities under `src/server` are repository tooling rather than part of the browser-neutral root export. Their local release resolver lives inside this package and accepts `RESOURCE_RELEASE_ROOT` or `RESOURCE_BUILD_ROOT`, allowing the package to be moved to an independent repository without importing files from a parent workspace.

### Upstream engine provenance

The play, watch, preview, and tutorial engine implementation was originally derived from NonSpicyBurrito's [`sonolus-pjsekai-engine`](https://github.com/NonSpicyBurrito/sonolus-pjsekai-engine). Haneoka has substantially adapted that engine for direct Our Notes chart data, rendering resources, effects, scoring, and deployment, but those adaptations do not erase the upstream provenance.

The upstream engine is licensed under the MIT License. Source distributions, substantial copied portions, and redistributed builds that include the derived engine code must retain the upstream copyright and permission notice in [`engine/LICENSE.pjsekai.txt`](engine/LICENSE.pjsekai.txt). The license also supplies the upstream code without warranty. Review the upstream repository and the preserved license text before redistributing this package or an engine artifact.

## Layout

| Path               | Responsibility                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `engine/play/`     | Interactive play engine                                                |
| `engine/watch/`    | Watch and replay engine                                                |
| `engine/preview/`  | Sonolus chart preview engine                                           |
| `engine/tutorial/` | Tutorial engine                                                        |
| `engine/shared/`   | Shared configuration and engine code                                   |
| `src/convert/`     | Score parsing and direct Our Notes-to-Sonolus conversion               |
| `src/server/`      | Level metadata, standalone server, and Worker-facing document builders |
| `assets/original/` | Inputs used to build the Our Notes skin, particle, and effect packs    |
| `scripts/`         | Deterministic engine/server asset builders and supporting utilities    |

The engine directory is a pnpm workspace package. It keeps its intentionally older Sonolus and TypeScript compatibility ranges in the named `sonolus-engine` catalog while sharing the repository lockfile.

## Requirements

- Node.js 24 for the repository workflow;
- the pnpm release pinned by the root `package.json`;
- a compiled local Sonolus engine artifact for release assembly;
- a prepared Haneoka resource release for level, chart, jacket, and audio inputs;
- FFmpeg when rebuilding the native effect audio pack.

Third-party resource inputs must come from a source the operator is authorized to use. They are not granted under the repository MPL-2.0 license.

## Type checking and engine compilation

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --dir packages/sonolus/engine run build
```

The engine build writes these required files under `packages/sonolus/engine/dist/`:

- `EngineConfiguration`;
- `EnginePlayData`;
- `EngineWatchData`;
- `EnginePreviewData`;
- `EngineTutorialData`;
- `LICENSE`, the complete Haneoka MPL-2.0 terms;
- `NOTICE.txt`, the Haneoka scope and corresponding-source notice;
- `SOURCE.txt`, the exact source revision when a CI revision is available, otherwise the source repository;
- `LICENSE.pjsekai.txt`, the retained upstream MIT notice.

`.github/workflows/sonolus-engine.yml` builds the four targets independently, checks that their engine configuration is identical, assembles one artifact, retains the Haneoka MPL-2.0 notice and upstream MIT notice, and caches the complete artifact by source hash. Release generation publishes the upstream notice at `/sonolus/licenses/sonolus-pjsekai-engine.txt` alongside the deployed engine distribution; the repository notices document the Haneoka license boundary.

## Building release assets

The root command below builds native effect audio, original-resource Sonolus packs, and Worker-facing Sonolus documents:

```sh
ASSET_SERVER=jp-cbt pnpm sonolus:release
```

It is not a first-run bootstrap command. Before running it:

1. select a local immutable release under `data/servers/<server>/current.json`, or set `RESOURCE_RELEASE_ROOT`/`RESOURCE_BUILD_ROOT`;
2. ensure the release contains the CRI note-sound runtime files, catalog documents, charts, and source assets expected by the builders;
3. place the compiled engine files in `packages/sonolus/engine/dist/`;
4. ensure `ffmpeg` is available on `PATH`, or set `FFMPEG` to its executable.

Useful build variables include:

| Variable                      | Purpose                                              | Default                                |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------- |
| `ASSET_SERVER`                | Selected release server                              | `jp-cbt`                               |
| `OUR_NOTES_ROOT`              | Repository root for standalone scripts               | current directory                      |
| `SONOLUS_ORIGINAL_ASSETS_DIR` | Original Sonolus pack input/output directory         | `packages/sonolus/assets/original`     |
| `SONOLUS_WORKER_ASSETS_DIR`   | Generated Worker asset output                        | `packages/sonolus/dist`                |
| `SONOLUS_ADDRESS`             | Public Sonolus service address embedded in documents | `https://haneoka.org/sonolus`          |
| `SONOLUS_HANEOKA_BASE`        | Haneoka origin used for catalog URLs                 | `https://haneoka.org`                  |
| `SONOLUS_SONGS_URL`           | Explicit songs API URL                               | derived from Haneoka origin and server |
| `FFMPEG`                      | FFmpeg executable                                    | `ffmpeg`                               |

The resource pipeline invokes the same release builders after it has restored the compiled engine artifact and prepared the current build workspace.

## Optional standalone server

The standalone server is a development utility. It reads Master tables, charts, jackets, and decoded audio from a selected local release and constructs Sonolus levels at startup.

Build and start it from the repository root:

```sh
node packages/sonolus/scripts/build-serve.ts
ASSET_SERVER=jp-cbt PORT=3000 node packages/sonolus/dist/serve.mjs
```

Connect a Sonolus client to `http://<host>:3000/sonolus`. `SONOLUS_ADDRESS` can override the address embedded in generated responses. The same local release prerequisites as the root preview server apply.

This server is not the production deployment path. Production projects level routes at runtime and serves immutable non-level documents and repository objects from R2 through `worker/index.ts`.

## Production routes and versions

The public service is available under `/sonolus/*` on the main origin. Content-addressed repository resources are served under `/sonolus/repository/*` with immutable caching.

Level info, lists, details, random selection, and chart data are projected from
the current release catalog at request time. A release revision change creates
a new bounded snapshot, so added and removed charts appear without rebuilding
the web application or Sonolus package. Level routes never fall back to the
build-time static chart list when projection fails; they return an explicit
error instead of exposing stale content. Static release documents remain only
for engine, skin, background, effect, particle, and configuration resources.
Runtime level discovery does not read generated level documents.

The Worker reports Sonolus version `1.1.2`. Generated item schemas use the fixed versions required by this implementation:

| Item       | Version |
| ---------- | ------: |
| Level      |       1 |
| Skin       |       4 |
| Background |       2 |
| Effect     |       5 |
| Particle   |       3 |
| Engine     |      13 |

Blue Stage and Theatre Stage are generated as selectable lightweight backgrounds; Blue Stage is the engine default. Engine configuration defines the current defaults for note speed, guidelines, guideline opacity, lane-base opacity, judgment-position line, and tap-area border.

## Fidelity boundaries

The converter and engine preserve native chart operations and source data, but Sonolus imposes explicit limits:

- its stock result model has Perfect, Great, Good, and Miss, so original result categories that have no protocol equivalent must be mapped;
- stock result metrics cannot reproduce deck-dependent native score/rank thresholds or conditional life rules exactly;
- Unity ParticleSystem graphs, renderer hierarchy, 3D transforms, shader channels, and sub-emitters cannot be represented losslessly by stock Sonolus particles;
- scheduled effects cannot reproduce every native global voice-de-duplication and long-loop mixing rule;
- the native slide shader's depth-dependent color and every sprite-cap/overhang combination cannot be expressed by a static Sonolus skin;
- original resources are projected into deterministic protocol-compatible 2D assets, not claimed to be pixel-identical Unity output.

Critical flags remain authored data. They retain the supported timing semantics and must not acquire fabricated Project SEKAI-style visual treatment when the native source assets do not define it.

The browser `@haneoka/chart` package remains the complete browser-UI fidelity target. Sonolus is the portable play, watch, preview, and tutorial target.

## Deployment safety

No package-local build command should deploy infrastructure or switch a production release pointer. Production changes occur only through the Cloudflare deployment and resource-publication workflows. The resource publisher uploads verified immutable objects and switches `current.json` last.

## License

Read the package [license-scope file](LICENSE) before redistribution. Haneoka-authored Source Code Form is covered by MPL-2.0, but third-party resource inputs and separately licensed release assets are excluded. Engine code derived from NonSpicyBurrito's [`sonolus-pjsekai-engine`](https://github.com/NonSpicyBurrito/sonolus-pjsekai-engine) retains its upstream MIT notice; preserve [`engine/LICENSE`](engine/LICENSE) and [`engine/LICENSE.pjsekai.txt`](engine/LICENSE.pjsekai.txt) in source and executable redistributions containing that code. Review the repository [third-party notices](../../THIRD_PARTY_NOTICES.md) before use or distribution. Package metadata therefore uses `SEE LICENSE IN LICENSE` instead of implying that all inputs and generated artifacts are MPL-2.0-covered.
