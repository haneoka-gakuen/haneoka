# Contributing to Haneoka

Thank you for improving Haneoka. Contributions are welcome when they are technically reviewable, legally shareable, and consistent with the project's current pre-release scope.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Use [SUPPORT.md](SUPPORT.md) to choose the correct channel, and report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Choose the right starting point

| You want to…                                              | Start here                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Ask how to use, configure, or contribute to Haneoka       | [Q&A Discussions](https://github.com/haneoka-gakuen/haneoka/discussions/categories/q-a)                         |
| Explore an idea whose scope is not settled                | [Ideas Discussions](https://github.com/haneoka-gakuen/haneoka/discussions/categories/ideas)                     |
| Report reproducible application or package behavior       | [Bug report](https://github.com/haneoka-gakuen/haneoka/issues/new?template=bug_report.yml)                      |
| Correct catalog data or report a resource/release problem | [Catalog or resource report](https://github.com/haneoka-gakuen/haneoka/issues/new?template=resource_report.yml) |
| Correct unclear, missing, or outdated documentation       | [Documentation correction](https://github.com/haneoka-gakuen/haneoka/issues/new?template=documentation.yml)     |
| Propose a focused feature with a clear user need          | [Feature proposal](https://github.com/haneoka-gakuen/haneoka/issues/new?template=feature_request.yml)           |
| Report a vulnerability                                    | [Private vulnerability reporting](https://github.com/haneoka-gakuen/haneoka/security/advisories/new)            |

Questions and early ideas do not need a polished implementation plan. Issues should describe independently actionable work; security reports and sensitive evidence must never be posted publicly.

## Before opening a change

1. Search existing discussions, issues, and pull requests for the same problem.
2. For a substantial feature, data-contract change, architectural change, or new dependency, discuss the scope before investing in a complete implementation.
3. Keep the change focused. Separate unrelated refactors, generated-resource changes, and behavioral fixes.
4. Confirm that every submitted source file, image, audio file, fixture, and dataset can legally be contributed and redistributed under its stated terms.

Do not submit game packages, private CDN URLs, authorization headers, cloud credentials, third-party resources without documented provenance and redistribution terms, or personal data.

## First contribution workflow

1. For anything beyond an obvious typo or a small, self-contained documentation correction, pick an existing issue or open the appropriate form above. Comment before starting substantial work so maintainers can confirm the scope and avoid duplicate effort.
2. Fork the repository, create a branch from the current `main`, and keep that branch limited to one reviewable outcome.
3. Install the workspace and run the narrowest useful check while developing. Use a draft pull request when early feedback would prevent wasted work.
4. Before marking the pull request ready, update it from `main`, review the complete diff, and run the relevant checks described below.
5. Fill in the pull request template with actual results and evidence. A missing optional tool or physical device is not a reason to avoid contributing; state what you could not verify and why.

Branch names should be short and descriptive, such as `fix/story-editor-empty-dialogue` or `docs/local-preview`. Commit subjects follow the repository's Conventional Commit style, for example `fix(story-editor): preserve empty dialogue` or `docs(contributing): clarify local preview`.

## Development environment

The production toolchain uses:

- Node.js 24;
- the pnpm release pinned by `package.json#packageManager`;
- Python 3.13 for resource-pipeline work;
- FFmpeg and `vgmstream-cli` for complete media processing.

Install the JavaScript workspace from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
```

For resource-pipeline work, create the documented virtual environment:

```sh
python3.13 -m venv scripts/.venv
source scripts/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --require-hashes --requirement scripts/requirements.txt
```

See [scripts/README.md](scripts/README.md) before running resource-processing, publication, or storage-maintenance commands.

## Local catalog data

The Git repository does not include a generated catalog release. Runtime work needs one of:

- a local release produced from an authorized package by the resource pipeline;
- `RESOURCE_RELEASE_ROOT` pointing to a valid immutable release;
- `RESOURCE_BUILD_ROOT` pointing to a prepared build workspace.

The project preview defaults to `HOST=0.0.0.0`, `PORT=3000`, and `RELEASE_SERVERS=jp-cbt`. This ordered list contains Our Notes releases only; it is also the local detail/playlist fallback policy, never a list of Bestdori regions. Use `HOST=127.0.0.1` unless another device needs to reach the server on a trusted network.

Bestdori is an external Garupa provider, not a release server. To exercise its
transformed v1 API or its separate Sonolus catalog through `pnpm preview`, set
`BESTDORI_PROVIDER_ORIGIN` to a running Haneoka Worker/provider origin. A
`BESTDORI_RAW_MIRROR_ROOT` is only a raw upstream mirror (`/api`, `/assets`,
and `/res`) for that Worker. The Worker reaches it through its separate,
path-capable `BESTDORI_UPSTREAM_BASE`, under the preview gateway's private
`/_internal/providers/garupa/bestdori/raw` namespace. It must not receive
`/api/v1/garupa/bestdori`, expose top-level `/assets`, or stand in for an Our
Notes release.

## Make a focused change

- Follow the existing TypeScript, Vue, Python, and file-layout conventions.
- Prefer package public exports over imports into another package's internal directories.
- Keep host concerns out of `@haneoka/story` and `@haneoka/chart`; application routing, API access, localization, and website controls belong in `app/`.
- Do not silently replace exact data-backed behavior with a visual approximation. Document unavoidable fidelity boundaries.
- Preserve deterministic identities and fail-closed verification in the resource pipeline.
- Do not change production domains, R2 buckets, release pointers, credentials, or retention behavior as an incidental part of another change.

## Required checks

Run the checks relevant to the changed area. The baseline pull-request checks are:

```sh
pnpm typecheck
pnpm lint
pnpm build
```

The repository does not currently contain an automated unit or end-to-end test suite. Add focused tests when the changed code has a practical test boundary, and include manual evidence for behavior that cannot yet be automated.

If a check cannot be run, state why in the pull request. Do not describe an unrun check as passing.

## Internationalization

Interface messages are defined in five catalogs under `app/i18n/messages/`: Japanese, English, Traditional Chinese, Simplified Chinese, and Korean.

When changing a message:

1. update the same key in every catalog;
2. keep interpolation placeholders identical across locales;
3. avoid page-local translation maps;
4. run `pnpm typecheck`.

If a fluent translation is not available, ask for review instead of inserting machine-generated text without disclosure.

Archive data is separate from interface copy. Render visible localized archive fields with `resolveLocalized()` and the shared display-text components so the element retains the language of the slot or object key that supplied it. Use `localize()` for search, sorting, and other string-only operations. Do not infer the source language of a plain string from its glyphs; leave it `und` unless the data contract provides an explicit source language.

## Rendering and responsive changes

Visual behavior can differ by browser, GPU, device-pixel ratio, safe-area insets, viewport size, and orientation. For UI, WebGL, Live2D, video, or canvas changes, include:

- desktop and narrow/mobile viewport results;
- the exact browser and operating-system versions;
- physical-device results when fixing an iPhone, iPad, Android, or mobile-GPU-specific problem;
- before/after screenshots or a short recording for visible changes;
- the affected catalog URL and resource server;
- any fallback path exercised, such as the story renderer's RGBA8 field-target fallback.

A desktop browser emulating a mobile viewport is useful for layout checks but does not establish compatibility with mobile Safari or a physical mobile GPU.

## Documentation changes

Documentation must describe current code, not planned capabilities as if they were available. In particular:

- distinguish completed catalog pages from construction surfaces;
- distinguish the custom `pnpm preview` server from a generic Nuxt preview;
- state local resource prerequisites for runtime commands;
- preserve license and provenance boundaries;
- use repository-relative links for tracked files and absolute links for external services;
- update command examples when scripts, ports, environment variables, or workflow inputs change.

Keep prose direct, formal, and testable. Avoid unsupported compatibility, fidelity, performance, or legal claims.

## Resource and licensing changes

Every new vendor file or binary/media asset requires:

- its source and version or commit;
- the applicable license or distribution terms;
- confirmation that required notices are preserved;
- an update to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when the repository inventory changes.

Every workspace package must keep a package-level `README.md` and `LICENSE`. The README must identify its supported public entry points, runtime or resource prerequisites, and package-specific notices. Keep `description`, `license`, and `repository.directory` metadata in `package.json` consistent with those files. A package license describes only the material to which the repository contributors can grant that license; it must not imply that bundled game media or third-party code has been relicensed.

The root MPL-2.0 license covers Haneoka-authored Source Code Form and contributor modifications to existing MPL-covered files only where contributors have the necessary rights. New and modified covered files must keep an MPL-2.0 notice attached through the relevant package `LICENSE` or a file-level header. It does not change the terms of upstream contributions or relicense Live2D, Spine, Sonolus-derived code, game assets, or generated media.

## Pull requests

A reviewable pull request should contain:

- a concise problem statement and solution summary;
- links to related issues when they exist, or a short reason the change is self-contained;
- a list of checks actually run;
- manual reproduction and verification steps;
- screenshots/recordings for visible changes;
- compatibility and migration notes for schema or deployment changes;
- documentation and third-party-notice updates when applicable.

Open the pull request against `main`. Draft pull requests are welcome for an agreed issue when the implementation boundary or manual verification still needs feedback. Link the issue with `Closes #123` when the pull request fully resolves it; otherwise use a normal reference and describe what remains. A small, self-contained correction may use `None — <reason>` instead of creating a bookkeeping issue.

Keep generated output out of commits unless it is an intentional, reviewable, legally redistributable source artifact already tracked by the project. Do not force-push over active review without explaining the rewritten history.

## Review expectations

Maintainers may request narrower scope, tests, device evidence, documentation, provenance, or a different package boundary before accepting a change. Submission does not guarantee merge, release, or deployment. Response and review times are best effort; this project does not promise a service-level agreement.
