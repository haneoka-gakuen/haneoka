# Contributing to Haneoka

Contributions are welcome. Follow the [Code of Conduct](CODE_OF_CONDUCT.md),
use [SUPPORT.md](SUPPORT.md) for help, and report vulnerabilities through
[private security advisories](https://github.com/haneoka-gakuen/haneoka/security/advisories/new).

## Before you start

- Search existing issues, discussions, and pull requests.
- Discuss substantial features, data-contract changes, or new dependencies
  before implementing them.
- Keep each change focused.
- Do not submit credentials, private URLs, personal data, game packages, or
  resources that cannot legally be redistributed.

## Setup

```sh
corepack enable
pnpm install --frozen-lockfile
```

Resource-pipeline changes also require Python 3.13:

```sh
python3.13 -m venv scripts/.venv
source scripts/.venv/bin/activate
python -m pip install --require-hashes --requirement scripts/requirements.txt
```

Read [scripts/README.md](scripts/README.md) before processing or publishing
resources. A local catalog preview requires an authorized resource release.

## Checks

Run the checks relevant to your change:

```sh
pnpm typecheck
pnpm lint
HANEOKA_CUBISM_RUNTIME_POLICY=optional pnpm build
python3 -m unittest discover -s scripts/garupa_master/tests -t .
```

State any checks you could not run. Visual changes should include screenshots
and results for the affected desktop and mobile environments.

## Project conventions

- Use package public exports instead of internal paths.
- Keep source-specific behavior in its source plugin rather than generic
  engine or renderer packages.
- Update all five interface locale catalogs when changing translated copy.
- Preserve deterministic resource identities and fail-closed verification.
- Do not commit generated output unless it is an intentional, redistributable
  tracked artifact.
- Add third-party notices for new vendor files, adapted code, fonts, icons, or
  media.
- Keep package `README.md`, `LICENSE`, and package metadata accurate.

## Pull requests

Include the problem, the solution, checks run, reproduction steps, and visual
evidence where applicable. Link the relevant issue or explain why the change is
self-contained. Open focused pull requests against `main`.
