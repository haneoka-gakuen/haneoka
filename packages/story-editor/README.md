# `@haneoka/story-editor`

`@haneoka/story-editor` is a browser-neutral ADV and visual-novel authoring core. It defines a canonical multi-scene project model, a semantic command schema, loss-aware format adapters, validation, undo history, draft reconciliation, resource aliases, and compilation to the object consumed by `@haneoka/story`.

The package publishes tree-shakeable ES2022 ESM and declarations from `dist/`. It has no source-service, Vue, renderer, storage, or network dependency. Source-specific adapters depend on this package through its public extension contract.

## Project contract

- Haneoka Project JSON is the canonical editing format. Scenes and commands have stable editor IDs.
- Native numeric opcodes are represented by named command descriptors and semantic fields. Original archive IDs and codec-only fields stay in explicit canonical extensions rather than becoming visual controls.
- Unknown top-level, scene, command, asset, and runtime data is retained so an untouched native import can be exported without silently narrowing its open JSON shape.
- Project JSON is complete and self-contained. Its canonical extensions preserve codec data directly, so parsing never depends on a previous in-memory project.
- Native ADV JSON and WebGAL are projections of the canonical project. Every adapter returns diagnostics for approximate or unsupported conversions.
- Plain WebGAL cannot express the complete native ADV command set. Optional Haneoka metadata comments can preserve a scene or complete project for editor round trips while remaining comments to WebGAL.

## Entry points

| Import                             | Purpose                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `@haneoka/story-editor`            | Complete model, command, compile, history, resource, validation, and format surface   |
| `@haneoka/story-editor/commands`   | ADV opcode table, semantic command descriptors, defaults, and editor value adapters   |
| `@haneoka/story-editor/compile`    | Compile one canonical scene for `@haneoka/story`, with diagnostics and source indexes |
| `@haneoka/story-editor/formats`    | Haneoka Project JSON, native ADV JSON, ADV Episode table, and WebGAL codecs           |
| `@haneoka/story-editor/history`    | Generic `ProjectHistory` undo/redo model                                              |
| `@haneoka/story-editor/model`      | Canonical project types, IDs, cloning, and scene helpers                              |
| `@haneoka/story-editor/resources`  | Canonical resource kinds and path-alias generation                                    |
| `@haneoka/story-editor/validation` | Project validation and structured issues                                              |

The root entry additionally exports draft-conflict helpers. Deep entry points exist to keep application bundles and responsibilities explicit; consumers should not import files below `src/` directly.

## Formats

| Format                     | Import | Export | Notes                                                                                            |
| -------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------ |
| Haneoka Project JSON       | Yes    | Yes    | Complete canonical editing format, including explicit codec extensions                           |
| Normalized ADV story JSON  | Yes    | Yes    | Open object shape consumed by `@haneoka/story`                                                   |
| Original ADV Episode table | Yes    | Yes    | Preserves source rows, header presence, indexes, and unknown fields                              |
| WebGAL scene text          | Yes    | Yes    | Representable statements are mapped; diagnostics describe approximations and unsupported statements |

WebGAL export can emit plain text or add `@haneoka-lossless` comments. A plain export should be used for interchange with WebGAL; lossless metadata should be used when the same file must return to Haneoka without losing native-only commands.

## Minimal use

```ts
import {
  compileStoryProjectWithDiagnostics,
  createStoryCommand,
  importAdvStoryJson,
  serializeStoryProjectJson,
} from "@haneoka/story-editor";

const imported = importAdvStoryJson(sourceJson, { assetServer: "jp-cbt" });
const scene = imported.project.scenes[0];

scene?.commands.push(
  createStoryCommand("Talk", {
    targetName: "taki, mutsumi",
    text: "",
  }),
);

const projectJson = serializeStoryProjectJson(imported.project);
const compiled = compileStoryProjectWithDiagnostics(imported.project);
```

An empty dialogue string is intentional and must be preserved: native playback can use it to clear the dialogue window. The visual editor accepts comma-separated target names and converts them to the native middle-dot representation only at the ADV codec boundary.

## Host boundary

This package has no Vue, DOM, WebGL, storage, network, or player dependency. The host is responsible for file/archive selection, autosave, resource discovery, localization, preview scheduling, and rendering diagnostics. Playback is provided separately by `@haneoka/story`.

Resource helpers return aliases and semantic kinds only. They do not prove that an R2 object exists or fetch it. The application must hydrate catalog IDs to localized text and canonical resource references before presenting imported commands to users.

## Failure behavior

Malformed canonical projects and invalid hard requirements throw `TypeError`; assertion helpers never repair input silently. Import adapters return structured diagnostics for supported but approximate mappings and throw on data that cannot be parsed safely. Compilation returns diagnostics alongside output so a host can block unsupported commands or allow an explicitly reviewed approximation. File access, retries, autosave recovery, and network fallbacks remain host responsibilities.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @haneoka/story-editor typecheck
pnpm --filter @haneoka/story-editor build
pnpm --filter @haneoka/story-editor pack --dry-run
```

`build` emits executable multi-entry ESM, declarations, and source maps under `dist/`. `prepack` repeats type checking and the clean build.

## License and provenance

Haneoka-authored code and covered modifications are licensed under this package's [MPL-2.0 notice](LICENSE) and the repository's complete MPL-2.0 text.

The WebGAL codec contains work adapted from the MPL-2.0-licensed [WebGAL parser](https://github.com/OpenWebGAL/WebGAL). The Nuxt editor interface contains Vue adaptations of the MPL-2.0-licensed [WebGAL Terre editor](https://github.com/OpenWebGAL/WebGAL_Terre), including its resource manager, Ribbon, tabs, graphical sentence editor, command picker, and main workspace layout. These are not described as merely visual references.

Preserve [`LICENSE.webgal.txt`](LICENSE.webgal.txt), [`LICENSE.webgal-terre.txt`](LICENSE.webgal-terre.txt), and the detailed [local-to-upstream provenance map](NOTICE.webgal.md). All three are included in the published archive. Review the repository's [third-party notices](https://github.com/haneoka-gakuen/haneoka/blob/main/THIRD_PARTY_NOTICES.md) for the full license boundary.
