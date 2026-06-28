# `@haneoka/chart`

`@haneoka/chart` is a browser-side chart parser, simulation engine, input adapter, Three.js renderer, and Vue presentation package for _BanG Dream! Our Notes_. It owns chart semantics and live-stage rendering; a host application supplies catalog selection, resource URLs, localization, and surrounding controls.

The package publishes ES2022 ESM and declarations from `dist/`. `vue` and `three` are peers and remain external to every build entry, so hosts control their runtime versions and do not download duplicate renderers.

## Responsibilities

The package provides:

- parsing of the source score document and conversion to a typed chart model;
- timing, lane geometry, judgment windows, combo, life, and normalized scoring;
- typed skill, fever-state, and call-rhythm timelines with deterministic seek/reset reconstruction;
- watch, play, and chart-overview modes;
- pointer input for tap, trace, release, and directional flick operations;
- a media-backed playback clock and optional note-sound scheduling;
- original-resource manifest handling and SpriteAtlas lookup;
- Three.js rendering for lanes, notes, holds, simultaneous lines, effects, particles, and HUD elements;
- reusable `ChartPlayer` and `ChartOverview` Vue components;
- opt-in render-performance summaries.

It does not fetch catalog documents, select a game server, construct application routes, or own a website toolbar. Those concerns remain in the host.

## Relationship to Sonolus

The browser renderer and the Sonolus engine share source concepts but serve different runtimes:

- `@haneoka/chart` controls its own DOM, audio clock, pointer input, WebGL scene, and responsive layout. It is the browser fidelity target and can render a complete chart overview.
- `@haneoka/sonolus` converts the same chart model into Sonolus data and engine archetypes. It is the portable play/watch target and is constrained by Sonolus protocol, skin, effect, and result-model capabilities.

The two implementations must not route authored Our Notes data through unrelated Project SEKAI or USC semantics merely to share a visual skin.

## Package layout

| Path           | Responsibility                                                              |
| -------------- | --------------------------------------------------------------------------- |
| `src/core/`    | Parser, chart model, timing, geometry, judgment, scoring, and session state |
| `src/input/`   | Multi-pointer input and flick-distance/direction handling                   |
| `src/audio/`   | Media clock and note-sound scheduling                                       |
| `src/assets/`  | Runtime manifest, source constants, and Unity SpriteAtlas access            |
| `src/render/`  | Three.js stage, notes, holds, particles, effects, HUD, and diagnostics      |
| `src/adapter/` | Conversion from session state to reusable render frames                     |
| `src/vue/`     | `ChartPlayer`, `ChartOverview`, and public Vue types                        |

Hosts should compose the package through its exported surface instead of reaching into renderer internals.

## Public surface

| Import                    | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `@haneoka/chart`          | Complete core, audio, input, asset, renderer, and Vue surface             |
| `@haneoka/chart/assets`   | Runtime source constants, server manifest builder, and manifest types     |
| `@haneoka/chart/overview` | `ChartOverview` plus canvas skin and overview-geometry helpers            |
| `@haneoka/chart/parser`   | Score parsing, chart construction, timing conversion, and `ChartDocument` |
| `@haneoka/chart/player`   | `ChartPlayer` plus its event and exposed-method types                     |

The root entry exports the core enums and types, parser, chart builder, timing and scoring helpers, session, media clock, input adapter, asset manifest types, renderer surface, and Vue components. Use the focused entry points when a caller needs only one layer. Do not import implementation files below `src/` directly.

A score document is parsed and normalized in two explicit steps:

```ts
import { buildChart, parseScore } from "@haneoka/chart";

const source = parseScore(scorePayload);
const chart = buildChart(source);
```

`ChartPlayer` requires a `ChartDocument` and a complete `OurNotesAssetManifest`. The host may also provide an audio URL, stage-background URL, playback mode, volume/rate/loop settings, render settings, and localized accessible labels. The component exposes `play()`, `pause()`, `seek()`, and `resize()` and emits ready, playing, time, duration, judgment, skill, fever, call-change, error, and performance events.

`ChartOverview` requires the same chart and asset manifest and renders a virtualized, scrollable chart overview with configurable scale, note size, mirror mode, timing markers, and visual layers.

Runtime media manifests are generated by the resource pipeline. Callers must use canonical `/assets/<server>/...` and `/runtime/<server>/...` resources that belong to the same release; mixing paths from different releases can produce invalid atlas or HUD references.

## Failure behavior

The parser materializes the source runtime's documented constructor defaults: a missing note size is `6`, visibility is `true`, and the remaining scalar fields use their zero-valued enum or numeric form. These are native defaults, not recovery guesses. Malformed score structures and unknown string enums are rejected instead of being silently dropped or remapped. Renderer and media failures are reported through the Vue component's `error` event; the package does not retry network requests or replace a host's asset URL. Optional presentation assets may use their documented fallback, while an invalid chart or required manifest remains a hard failure. Hosts should present the original error and may retry after supplying corrected inputs.

## Rendering and browser requirements

The root application builds for ES2022. The interactive renderer requires a current browser with WebGL2, Pointer Events, animation-frame scheduling, media-element playback, and the relevant audio-decoding support. Autoplay remains subject to browser user-activation policies.

The player calculates render resolution from the viewport, device-pixel ratio, and graphics-quality setting. Mobile and desktop GPUs can therefore exercise different texture, framebuffer, and compositing paths. Rendering fixes must be validated on the affected physical device when a problem is known to be device-specific.

## Fidelity policy

The package keeps source operate type, judgment type, direction, timing, lane values, line references, and independent easing data in its chart model. Camera, lane, note, HUD, and effect constants validated against documented serialized or runtime data are centralized in the core and asset-manifest modules.

The evidence matrix and explicit non-claims are maintained in [`RUNTIME_FIDELITY.md`](RUNTIME_FIDELITY.md). A behavior absent from that matrix must not be described as restored merely because a visual fallback exists.

Important boundaries remain explicit:

- chart-only playback has no player deck or skill state, so score is normalized to `1,000,000`; combo, judgment, and life remain independent;
- skill callbacks carry only the source index/time, fever callbacks carry the native state transition, and call changes carry normalized rhythm positions; a host owns deck, character, voice, and UI policy;
- the browser renderer represents mapped Unity particle data, but a complete Unity ParticleSystem graph cannot be reproduced losslessly by the current Three.js implementation;
- transparent note materials and atlas slices have ordering constraints; mesh-merging or batching changes require visual regression evidence;
- missing or invalid optional background/effect assets may retain the prior scene or a documented fallback, while invalid core chart/runtime data should surface an error;
- availability of original note-hit audio depends on the selected generated release and its runtime manifest.

Critical notes are authored chart data. They must not be removed or automatically restyled as a Project SEKAI-style yellow note when the selected native assets do not define that presentation.

## Performance diagnostics

Performance collection is disabled on the normal path. To measure a dense section, pass `settings.__perf: true` to `ChartPlayer` and listen for the `perf` event. Summaries are emitted over 500 ms windows and include build, render, and total timings together with draw calls, triangle count, active notes, holds, particles, and native-effect refresh counts.

Diagnostics are intended for controlled comparisons. Record the browser, operating system, device/GPU, viewport, device-pixel ratio, graphics-quality setting, chart, playback mode, and capture interval with every result.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @haneoka/chart typecheck
pnpm --filter @haneoka/chart build
pnpm --filter @haneoka/chart pack --dry-run
```

`build` compiles Vue SFCs into executable ESM, keeps `vue` and `three` external, and emits declarations and source maps under `dist/`. `prepack` repeats type checking and the clean build. The repository does not currently include a dedicated automated frame pixel-diff harness; changes to scoring, timing, transparent rendering, or input behavior require focused manual regression evidence.

## License

Haneoka-authored package code is covered by this package's [MPL-2.0 notice](LICENSE) and the repository license text. Game resources, generated media, and third-party dependencies are excluded from that grant. See the repository's [third-party notices](https://github.com/haneoka-gakuen/haneoka/blob/main/THIRD_PARTY_NOTICES.md).
