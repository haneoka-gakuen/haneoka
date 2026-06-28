# `@haneoka/story`

`@haneoka/story` is a host-neutral ADV and visual-novel engine with lightweight text playback and opt-in Three.js, Live2D, audio, and Vue adapters. It interprets authored commands, manages deterministic playback and seeking, renders a scene when requested, and exposes lower-level runtime APIs for custom hosts.

The package publishes ES2022 ESM and declarations from `dist/`. `vue`, `three`, and `howler` are peers and remain external to the build. Import a focused entry so transcript-only pages do not load the visual runtime:

```ts
import "@haneoka/story/styles.css";
import { StoryPlayerText } from "@haneoka/story/vue/text";
```

`styles.css` contains the package-owned scoped presentation used by the Vue players. Hosts using only lower-level core APIs do not need it.

## Scope

The package owns:

- typed ADV command interpretation and playback-session state;
- deterministic backward-seek replay and forward-seek stabilization;
- preload scheduling and shared immutable resource caches;
- Unity coordinate, camera, viewport, field, transition, and post-processing behavior;
- Live2D Cubism model, motion, expression, physics, lighting, masking, and MotionSync integration;
- BGM, sound-effect, voice, analyzer, volume, and seek-safe audio state;
- full visual playback, a lightweight text/voice browser, and model-viewer APIs;
- a typed control surface that a host can render with its own design system.

The package does not import Haneoka routes, API clients, catalog state, locale state, or application CSS. The host supplies resource resolution and localization at its composition root.

## Package entry points

| Import                        | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `@haneoka/story`              | Complete component, runtime, player, quality, viewer, and type surface                 |
| `@haneoka/story/runtime`      | Runtime adapters, localization, and canonical-resource URL validation                  |
| `@haneoka/story/viewer`       | `CubismModelViewer`, harmonic-motion data, and public viewer types                     |
| `@haneoka/story/vue`          | `StoryPlayer`, `StoryPlayerText`, controls, autoplay helpers, and selected story types |
| `@haneoka/story/vue/controls` | Control composable, control types, and autoplay interval helpers                       |
| `@haneoka/story/vue/player`   | Visual `StoryPlayer` and its `AdvStory`/sprite input types                             |
| `@haneoka/story/vue/text`     | Lightweight `StoryPlayerText` and its `AdvStory` input type                            |

Use these package entry points instead of importing implementation files below `src/`. `StoryPlayerFull` is available from the root entry because it couples the runtime to the package-provided full presentation.

The main components are:

- `StoryPlayer`: complete visual ADV playback with a scoped controls contract;
- `StoryPlayerFull`: package-provided presentation for hosts that do not supply outer controls;
- `StoryPlayerText`: lightweight dialogue and voice browsing without mounting Three.js, WebGL, or Cubism.

`StoryPlayer` exposes volume, BGM, autoplay, instant-text, text-size, and fullscreen operations through the typed `controls` scoped slot. This boundary keeps the runtime independent of website toolbar components.

## Host configuration

Configure the runtime before mounting a player:

```ts
import { configureStoryRuntime, requireCanonicalStoryResourceUrl } from "@haneoka/story/runtime";

configureStoryRuntime({
  assetUrl: (path) => requireCanonicalStoryResourceUrl(path),
  sourceAssetUrl: (path) => requireCanonicalStoryResourceUrl(`/story-assets/${path}`),
  validateResourceUrl: (value, label) => requireCanonicalStoryResourceUrl(value, label),
  resourceBelongsToServer: () => true,
  localize: (value) => String(value ?? ""),
  resolveLocalized: (value) => ({ text: String(value ?? ""), lang: "und" }),
  message: (key) => key,
  defaultAssetServer: "default",
});
```

`localize` is the required string adapter. Hosts that retain source-language metadata should also provide `resolveLocalized`; the full player and transcript then apply `lang` only to story titles, speakers, dialogue, locations, subtitles, choices, and chat content. Player controls continue to inherit the host interface language and global font. If the source language is unknown, omit `lang` or return the BCP 47 value `und` rather than inferring it from glyphs.

The engine has no knowledge of a site's asset namespaces. `assetUrl`, `sourceAssetUrl`, `validateResourceUrl`, and `resourceBelongsToServer` form the resource-resolution port. Hosts may accept same-origin paths, signed URLs, `blob:` URLs, or another policy, but should reject traversal and unsafe schemes at that boundary. The default validator accepts ordinary relative paths and `data:`, `blob:`, and HTTP(S) URLs while rejecting control characters, protocol-relative URLs, and `.`/`..` path segments.

## Architecture

| Path                       | Responsibility                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/core/`                | Command interpreter, player model, playback session, seek replay, quality, title, and timing    |
| `src/rendering/three/`     | Scene, camera, viewport, field composition, transitions, character lifecycle, and post pipeline |
| `src/rendering/cubism/`    | Cubism resource cache, models, motion, physics, lighting, and MotionSync behavior               |
| `src/rendering/particles/` | Unity particle data, routing, caches, and renderer math                                         |
| `src/rendering/post/`      | Bloom, depth of field, color grading, motion blur, FXAA, and other post passes                  |
| `src/components/`          | Vue players, control contract, story UI, and lightweight transcript surface                     |
| `src/sound/`               | BGM, sound effects, voice, analyzer, and playback-state coordination                            |
| `src/viewer/`              | Standalone Cubism model-viewer API                                                              |
| `src/vendor/cubism/`       | Vendored Live2D Cubism Web Framework source under separate terms                                |

## Playback and seeking model

Backward seeking destroys the active scene and replays the authored command stream from index zero while reusing immutable, preloaded resources. Recorded choices are carried into the replay so the same branch is followed.

This is deliberate: a renderer snapshot that omits Cubism motion, expression, physics, particle simulation, audio state, or applied stage children cannot reproduce the authored state. Forward seeking continues from the live command index after detached no-wait work reaches a stable barrier. Intermediate Cubism, physics, particle, and rendering updates are paused while the target state is assembled so asset-decode timing does not change the restored scene.

## Rendering requirements

The full scene renderer requires:

- a current ES2022-capable browser;
- WebGL2;
- browser audio and media APIs used by Howler and native media elements.

The field-target format is capability-probed. When `EXT_texture_norm16` is present and an RGBA16 UNorm framebuffer probe succeeds, the renderer uses `R16G16B16A16_UNorm`. Otherwise it falls back to core RGBA8/unsigned-byte targets so browsers such as Firefox can use the portable LDR path. `StoryPlayerText` does not mount the WebGL runtime and can be used when only transcript/voice access is needed.

Browser and GPU behavior must be tested on the affected physical device. Desktop success does not establish iPhone/iPad Safari compatibility for framebuffer formats, texture upload, compositing, video, or context-restoration paths.

## Failure behavior

Runtime configuration and malformed resource URLs fail with `TypeError` at the boundary. Required warm-up assets are preloaded with bounded concurrency; a required phase-one failure rejects player boot with the original failures collected in the message. Background look-ahead failures do not stall the current command stream. The engine does not retry a host's network policy or silently rewrite rejected URLs. Text mode avoids WebGL/Cubism initialization but still reports invalid story and audio inputs through the owning component state.

## Quality policy

The source game does not have one universal `BaseQualityMode`; it scores a device on first launch and persists one of Worst, Low, Middle, High, or Best. When the host supplies no value, this package selects the deterministic `High` mode, including its 60 fps target and complete lighting/background-blur/stage-post path.

That default is a browser policy, not a claim about the game's default on every device. A host can select a lower supported mode, and `allowUnityLighting=false` continues to gate Unity-style lighting.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @haneoka/story typecheck
pnpm --filter @haneoka/story build
pnpm --filter @haneoka/story pack --dry-run
```

`build` compiles Vue SFCs, emits declarations and source maps, fingerprints package-owned images, and keeps `vue`, `three`, and `howler` external. `prepack` repeats type checking and the clean build. There is no dedicated automated visual regression suite in the current repository, so renderer, seek, audio, fallback, and device-compatibility changes require focused manual evidence.

## Licensing

Read the package [license-scope file](LICENSE) before redistribution. Haneoka-authored Source Code Form is covered by MPL-2.0, but the package is not uniformly MPL-licensed:

- the vendored Cubism Web Framework is Live2D code under the Live2D Open Software License;
- Cubism Core and MotionSync Core are Live2D proprietary redistributable components;
- Live2D release-license requirements may apply to some business users;
- third-party game resources and generated derivatives are not licensed by Haneoka.

The vendored framework identifies Live2D Cubism Web Framework `5-r.3`, commit `01e64ba44fc29e5e7206f0c397ee532edf824ee9`. `LICENSE`, `CUBISM-LICENSE.md`, and a legal banner are retained in the published archive and generated JavaScript. Review the repository's [third-party notices](https://github.com/haneoka-gakuen/haneoka/blob/main/THIRD_PARTY_NOTICES.md) before use or distribution. Package metadata therefore uses `SEE LICENSE IN LICENSE` instead of implying that every file and required runtime component is MPL-2.0-covered.
