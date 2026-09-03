# Third-party notices

The root [Mozilla Public License 2.0](LICENSE) applies to Haneoka-authored Source Code Form and documentation, and to Haneoka modifications of identified MPL-covered files, only to the extent Haneoka contributors can grant those rights. It does not change the terms of upstream contributions or relicense proprietary SDK runtimes, game data, media, fonts, icons, trademarks, or separately licensed software. Revisions previously distributed under MIT remain governed by the license attached to those revisions.

This file records the third-party material known to be vendored, adapted, generated into, or directly bundled by the current source tree. Package versions come from `pnpm-workspace.yaml` and `pnpm-lock.yaml`; a source URL identifies provenance but is not itself a license grant. A distributor must preserve the linked notices, review the terms for the exact build, and generate a complete dependency inventory. This is an engineering inventory, not legal advice.

## Vendored, packaged, and build-injected artifacts

| Component                     | Version or provenance                                                                                                                                                                                              | Local scope                                                                                                                                                                                                                                       | Terms and retained notice                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live2D Cubism Web Framework   | Cubism 5-r.3, upstream commit [`01e64ba44fc29e5e7206f0c397ee532edf824ee9`](https://github.com/Live2D/CubismWebFramework/tree/01e64ba44fc29e5e7206f0c397ee532edf824ee9)                                             | Operator-supplied, integrity-checked Haneoka/Deneb build input injected as `public/cubism-runtime/vega-cubism-web-runtime.mjs`; it is not part of the public [`vega-plugin-cubism`](https://github.com/haneoka-gakuen/vega-plugin-cubism) package | Live2D Open Software License; the matching notice is injected separately as [`public/licenses/cubism-framework/LICENSE.md`](public/licenses/cubism-framework/LICENSE.md) and validated into production output                            |
| Live2D Cubism Core            | Exact SDK release was not recorded; required JS SHA-256 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f`                                                                                         | External build input injected as `public/Core/live2dcubismcore.js`; integrity metadata is in [`config/cubism-runtime.lock.json`](config/cubism-runtime.lock.json)                                                                                 | Live2D Proprietary Software License, as stated in the injected file header; not covered by Haneoka's MPL-2.0 grant                                                                                                                       |
| Live2D Cubism 2 Web runtime   | Legacy release identifier was not recorded; required JS SHA-256 `e4ea1f18bdd44b65394ffd5a1bab16982e88757d45134d1bd0737c8a6b3ddd08`                                                                                 | Operator-supplied build input injected as `public/Core/live2d.min.js`; integrity metadata is in [`config/cubism-runtime.lock.json`](config/cubism-runtime.lock.json)                                                                              | Proprietary Live2D SDK runtime; the minified file has no embedded license banner and is not covered by Haneoka's MPL-2.0 grant. A distributor must confirm the exact source package and applicable Live2D agreement before publishing it |
| Live2D Cubism MotionSync Core | Exact SDK release was not recorded; required JS SHA-256 `60e2a8ba9b422a0f8a3d7e066739352e9b903cc1011339984ad922e80a3cd19a`, declaration SHA-256 `a4aedace54df065bcd2d93115021b3fdd580c36cf76e3724b02ef084ffccca5e` | External build inputs injected below `public/Core/CRI/`; integrity metadata is in [`config/cubism-runtime.lock.json`](config/cubism-runtime.lock.json)                                                                                            | Live2D Proprietary Software License; its license and redistributable-file notice are carried in the external bundle and validated into production output                                                                                 |
| Spine Runtimes                | `@esotericsoftware/spine-threejs@4.2.119`                                                                                                                                                                          | Spine rendering in the web application                                                                                                                                                                                                            | Spine Runtimes License Agreement (`LicenseRef-LICENSE`); not covered by Haneoka's MPL-2.0 grant; the exact package license is retained at [`public/licenses/spine-runtimes-license.txt`](public/licenses/spine-runtimes-license.txt)     |
| Basis Universal transcoder    | Copied byte-for-byte from `three@0.184.0/examples/jsm/libs/basis/`; ultimate upstream [BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal)                                                | `public/basis/basis_transcoder.js` (SHA-256 `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1`) and `.wasm` (SHA-256 `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a`)                                          | Apache-2.0; [`public/basis/LICENSE.txt`](public/basis/LICENSE.txt) and [`NOTICE.txt`](public/basis/NOTICE.txt) are retained with the browser artifacts                                                                                   |

The static Basis decoder is distinct from the `basisu` encoder used by the resource pipeline. The CI tool build pins the upstream Basis Universal repository at commit [`1aab02ba2df16ad873229030ea191ea8c10e3fc9`](https://github.com/BinomialLLC/basis_universal/tree/1aab02ba2df16ad873229030ea191ea8c10e3fc9); setup and version checks are documented in [`scripts/README.md`](scripts/README.md).

The public `vega-plugin-cubism` repository contains only Haneoka-authored, SDK-free provider, lifecycle, AIUEO, cache, descriptor, and adapter-port code under MPL-2.0. It does not distribute the Cubism Web Framework, Cubism Core, model files, textures, or other SDK assets, and its original source files are not subject to a blanket Live2D copyright notice.

The current Haneoka source tree does not track the Cubism Web Framework bundle, Cubism 2 runtime, Cubism Core, or MotionSync binaries. Their required hashes are committed, while matching files remain in an authorized external Haneoka/Deneb build bundle and are injected only during development or release builds. The exact SDK release packages and acquisition records were not recorded, and this integrity lock does not fill that provenance gap or grant redistribution permission. Do not replace the bundle or redistribute a release containing it until the applicable SDK versions, Live2D agreements, and any Publication License requirements have been checked.

## Adapted and derived source code

### Sonolus engine

The play, watch, preview, and tutorial engine began from NonSpicyBurrito's [`sonolus-pjsekai-engine`](https://github.com/NonSpicyBurrito/sonolus-pjsekai-engine), licensed under MIT. The original import did not record an exact upstream revision, so this repository does not claim that the current upstream head is the import source. Haneoka's later adaptations do not remove the upstream notice. It is retained at [`packages/sonolus/engine/LICENSE.pjsekai.txt`](packages/sonolus/engine/LICENSE.pjsekai.txt), and engine build artifacts include both that notice and Haneoka's package `LICENSE`.

### Next-SEKAI

Two separate Next-SEKAI sources apply:

- SUS analysis and conversion semantics in `packages/chart-editor/src/formats/sus.ts` are adapted from Kyle Chang's [`Next-SEKAI/sonolus-next-sekai-engine`](https://github.com/Next-SEKAI/sonolus-next-sekai-engine), MIT; the retained notice is [`packages/chart-editor/LICENSE.next-sekai.txt`](packages/chart-editor/LICENSE.next-sekai.txt).
- Chart-editor toolbar grouping, most-recently-used menu behavior, and portions of flat-timeline interaction geometry are adapted from NonSpicyBurrito's [`Next-SEKAI/sonolus-next-sekai-editor`](https://github.com/Next-SEKAI/sonolus-next-sekai-editor), MIT; the retained notice is [`packages/chart-editor/LICENSE.next-sekai-editor.txt`](packages/chart-editor/LICENSE.next-sekai-editor.txt).

The local imports did not record exact upstream revisions. The notices and source headers identify the repositories and copyright holders; a future import must also record its commit and affected files.

### Three renderer color and Unity interoperability

The independent
[`vega-renderer-three`](https://github.com/haneoka-gakuen/vega-renderer-three)
repository consumes host-supplied scene data whose schema may use Unity names.
Before its first public release, a provenance audit removed the former
`UnityEngine.Rendering.ColorUtils` ports (`UnityColorUtils.ts` and
`UnityColorGrading.ts`) and replaced them with renderer-authored implementations
expressed from W3C CSS Color 4, W3C Compositing and Blending, and CIECAT02/ICC
specifications. The publishable tree and reachable history contain no Unity
source code, package files, binaries, shader programs, or assets; no current
file is distributed under the Unity Companion License. Source headers and this
notice record the relevant scope and references.

Unity-named types and comments are interoperability vocabulary for serialized
data, coordinate conventions, or observable behavior. They do not identify
copied upstream source. Unity is a trademark of Unity Technologies; the
renderer is not affiliated with or endorsed by Unity Technologies.

### Generated Cloudflare declarations

`worker/worker-configuration.d.ts` is generated by Wrangler/workerd. It retains Cloudflare and Microsoft Apache-2.0 notices in the generated file. Do not remove those headers when regenerating it.

## WebGAL interoperability and adapted Terre interface code

The plugin-hosted story editor contains MPL-2.0-covered work adapted from
[OpenWebGAL/WebGAL](https://github.com/OpenWebGAL/WebGAL) and
[OpenWebGAL/WebGAL_Terre](https://github.com/OpenWebGAL/WebGAL_Terre).
The July 2026 provenance audit inspected WebGAL at commit
`e7f0abeb855b5b442460743bdaa9778ca751b43f` and WebGAL Terre at commit
`7b7a2159a5ccead80327437b7305b8fdb47a4e5f`. Relevant Terre history also
includes resource-view commits `ba3540a742e6efe4f0af7d31c076c13715f2c3cc`
and `fd9ae6d5122383f8622b386a81579d1607ee0b31`, Add Sentence/Ribbon commits
`8be1d57b504584504de0e08bd9461d4fe94d06d9` and
`baa9bde38bfb72413be4988ea3dd5d60ce0a876f`, and virtual graphical-list
commit `ca3de36c99b2f1dcc9e6c3ce7b0fe99e009a9bda`.

WebGAL command vocabulary, script semantics, escaping, choice splitting, and
loss-preserving workspace conversion are provided by the independent
[`altair-plugin-webgal`](https://github.com/haneoka-gakuen/altair-plugin-webgal)
repository, which retains its own WebGAL notice and license. The frontend
previously contained an adapted Terre interface; its provenance and license
obligations remain recorded here after that implementation's removal. The
Terre license text is retained as
[`LICENSE.webgal-terre.txt`](LICENSE.webgal-terre.txt); executable web
distributions retain the associated
[`WebGAL and Terre notice`](public/licenses/webgal-and-terre-notice.txt) and
the separate [`WebGAL`](public/licenses/webgal-mpl-2.0.txt) and
[`WebGAL Terre`](public/licenses/webgal-terre-mpl-2.0.txt) license copies.
Source and executable distributions must preserve the applicable notices and
make the corresponding covered Source Code Form available as required by
MPL-2.0. No statement here grants rights in upstream names or trademarks.

## Fonts, icons, and generated avatars

| Component                   | Locked version                                            | Local use                                                                                                                                | License and source                                                                                                                                        |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fluent UI System Icons      | `@fluentui/svg-icons@1.1.333`                             | Filled/regular 20 px resource-manager actions: arrow left, sort up/down, sync, delete, document/folder add, grid, list, more, and rename | MIT, Copyright Microsoft Corporation; [source](https://github.com/microsoft/fluentui-system-icons)                                                        |
| Material Icon Theme         | `material-icon-theme@4.34.0`                              | Audio, document, folder, image, and video resource-manager icons                                                                         | MIT, Copyright Philipp Kief; [source tag](https://github.com/material-extensions/vscode-material-icon-theme/tree/v4.34.0)                                 |
| DiceBear Core               | `@dicebear/core@10.3.0`                                   | Deterministic fallback-avatar generation                                                                                                 | MIT, Copyright Florian Körner; [source](https://github.com/dicebear/dicebear)                                                                             |
| DiceBear Thumbs             | `@dicebear/styles@10.2.0`, `thumbs.json` only             | Fallback-avatar artwork                                                                                                                  | CC0-1.0, artist DiceBear; [style source](https://www.dicebear.com/styles/thumbs/)                                                                         |
| Noto Sans variable families | `@fontsource-variable/noto-sans{,-jp,-kr,-sc,-tc}@5.2.10` | Locale-aware interface typography                                                                                                        | SIL Open Font License 1.1; packaged by [Fontsource](https://github.com/fontsource/font-files), with family copyright statements in each installed package |
| Space Grotesk Variable      | `@fontsource-variable/space-grotesk@5.2.10`               | Display typography                                                                                                                       | SIL Open Font License 1.1, Copyright 2020 The Space Grotesk Project Authors; packaged by [Fontsource](https://github.com/fontsource/font-files)           |

The SVG package and font licenses apply to the imported assets even when the build fingerprints or inlines them. Brand icons may also be protected as trademarks independently of their file license.

Static distributions retain the applicable UI notices at [`public/licenses/open-source-ui.txt`](public/licenses/open-source-ui.txt) and the font copyright statements plus OFL-1.1 text at [`public/licenses/fonts.txt`](public/licenses/fonts.txt).

### theSVG brand icons

The application imports the following entries from `@thesvg/icons@3.2.6`. The package code is MIT-licensed, while each generated module records its asset terms and source. This fixed-version list replaces reliance on a changing online registry:

| Recorded term in 3.2.6              | Imported IDs                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC BY 3.0                           | `android`                                                                                                                                                                                                                                                                                                                                                                                                             |
| CC BY 4.0                           | `vivaldi`                                                                                                                                                                                                                                                                                                                                                                                                             |
| CC BY-SA 2.5                        | `gentoo`                                                                                                                                                                                                                                                                                                                                                                                                              |
| CC BY-SA 3.0                        | `debian`                                                                                                                                                                                                                                                                                                                                                                                                              |
| CC BY-SA 4.0                        | `floorp`                                                                                                                                                                                                                                                                                                                                                                                                              |
| MIT                                 | `chrome`, `chromium`, `tor`, `yandex`                                                                                                                                                                                                                                                                                                                                                                                 |
| CC0-1.0                             | `alpine-linux`, `apple`, `arc`, `bilibili`, `blackberry`, `brave`, `centos`, `discord`, `duckduckgo`, `electron`, `elementary`, `firefox`, `freebsd`, `github`, `google`, `grapheneos`, `harmonyos`, `helium-browser`, `kaios`, `kali-linux`, `librewolf`, `lineageos`, `linux`, `linux-mint`, `manjaro`, `netbsd`, `openbsd`, `opensuse`, `opera`, `opera-gx`, `safari`, `sailfish-os`, `ubuntu`, `x`, `zen-browser` |
| Package-specific custom/brand terms | `archlinux`, `fedora`, `fuchsia`, `haiku`, `internetexplorer`, `microsoft-edge`, `microsoft-windows`, `samsung-browser`, `wearos`                                                                                                                                                                                                                                                                                     |

Historical interface code used the separately attributed icon sets described
above. The production Astro frontend uses build-generated SVG symbols from the
locked Material Symbols packages and the project's existing favicon artwork;
it does not ship the ligature icon font.

## Direct runtime dependencies

This table highlights code that is directly bundled or used at runtime. It is not a substitute for the complete lockfile inventory.

| Packages          | Locked version                              | License | Source                                                                                |
| ----------------- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| Astro             | `astro@5.18.2`                              | MIT     | [withastro/astro](https://github.com/withastro/astro)                                 |
| Lit               | `lit@3.3.3`                                 | BSD-3   | [lit/lit](https://github.com/lit/lit)                                                 |
| Three.js          | `three@0.184.0`                             | MIT     | [mrdoob/three.js](https://github.com/mrdoob/three.js)                                 |
| Spine Three.js    | `@esotericsoftware/spine-threejs@4.2.119`   | Spine   | [EsotericSoftware/spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes) |
| Better Auth       | `better-auth@1.6.23`                        | MIT     | [better-auth/better-auth](https://github.com/better-auth/better-auth)                 |
| Sonolus libraries | See the `sonolus-engine` workspace catalog. | MIT     | [Sonolus](https://github.com/Sonolus)                                                 |

Run `pnpm licenses list --prod --json` after an exact install to inventory production dependency license expressions. Review its package-provided license files and notices before distributing a build; this manually maintained document concentrates on vendored, adapted, media, and presentation assets that a package-manager report cannot explain.

## Game media, data, and remote artwork

The following material is not covered by Haneoka's MPL-2.0 license, and the repository does not claim redistribution rights merely because it records a source or processing workflow:

- `packages/sonolus/assets/original/` contains original-game audio, textures, and engine-facing derivatives prepared by the documented scripts;
- assets, runtime media, metadata, source indexes, and object trees generated under `data/` or published to object storage originate from operator-supplied packages and retain the rights and restrictions of their sources.

Online availability, source attribution, a checksum, or inclusion in a checkout does not place material in the public domain or grant further use. Operators must use inputs they are authorized to access and independently determine whether their intended processing, display, storage, or distribution is permitted. Haneoka provides no third-party credentials or license to game content.

## Names and trademarks

Haneoka is operated as an independent, unofficial, non-commercial fan project. This operational description does not restrict the rights granted for Haneoka-authored MPL-2.0-covered material. BanG Dream!, BanG Dream! Our Notes, associated characters, artwork, music, logos, and other marks or creative works belong to their respective owners. Haneoka is not authorized, affiliated with, endorsed by, sponsored by, or otherwise connected to BanG Dream! Project, Bushiroad Inc., FROM TOKYO Inc., bilibili game, or other rights holders.

Use of a third-party name or mark is descriptive and grants no trademark rights. The Haneoka shooting-star artwork is project branding; game artwork and third-party marks are not part of that brand license.
