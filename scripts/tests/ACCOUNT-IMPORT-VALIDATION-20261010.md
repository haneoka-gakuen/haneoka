# Account import and activity workflows — validation

Validated on 2026-10-10 against `da667bc20711161538d842164d3dcdfd899b33f9`.
All inventory and device fixtures are synthetic. Activity checks use a locally
constructed five-character inventory and the public catalogue.

## Player workflows

| Task | Calculation conditions | Result |
| --- | --- | --- |
| Event farming | Selected songs/difficulties, normal-live boost cost, challenge CP cost; solo All Perfect, or Gekisou full combo with the selected JUST rate and first-place assumption; challenge All Perfect | Normal/challenge teams with songs and difficulties; separate PT and shop-medal rankings. Normal-live yield includes direct rewards plus the long-term value of earned CP. |
| Single live | One normal live, challenge or skip, the selected reward currency and cost; All Perfect or custom accuracy for played lives; game skip rules for skips | Team and direct rewards for that play. Earned CP is displayed separately, not converted into the direct-reward total. |
| Budget estimate | Available boosts and starting CP, fixed normal/challenge costs, selected charts and play assumptions | Estimated total PT, whole normal/challenge play counts, leftover CP, and both teams with their songs/difficulties. At zero boost cost the input is a play count. |

Played-live results use the average of 120 skill orders. Budget estimation keeps
the existing method: select teams by long-term yield, then estimate whole plays
from the available resources. It does not claim a globally optimal finite-budget
plan. Incomplete search status remains visible. Reward labels use the completed
request, so changing settings does not relabel an old result.

The Build tab retains score, Gekisou score, power and song-independent potential.
Activity tasks now share one tab. Navigation, copy and result presentation do not
change the search/scoring formulas. Import integration adds input qualification
before those calculations.

## Account import contract

- One entry offers file/text import, Android WebUSB reading and screenshot import.
  This is an inventory importer, not a network packet-capture module.
- Imported missing growth stays unknown (`null`). Raw experience uses decimal
  strings/BigInt for threshold lookup. Source-specific training/awakening domains
  remain distinct. Missing source fields do not erase existing values.
- Preview checks catalogue IDs, ranges, conflicting fields and the final merged
  growth combination. New cards/increases can be applied together; decreases need
  an explicit choice. Identical reimport produces no inventory writes.
- The same-game-account confirmation does not establish account identity, complete
  inventory coverage or cache freshness. Read time is separate from game update
  time. Older ONPKG1 exports may already have replaced absent fields with 0/1.
- Actual calculations require the fields used by the chosen goal. Power/skip do
  not require unused skills; Gekisou event calculations include the Gekisou skill.
  TGW rank 1 is valid even without a bonus row. Inactive memory bonuses are not
  requested or applied, matching the current upstream feature scope.
- Explicit simulation records its assumptions without saving them into inventory.
  Known-only candidates are transient; required cards, leaders and fixed bindings
  cannot be silently dropped. Page and real Worker API both enforce qualification.
- Android reads only the selected channel's files directory, through bounded,
  cancellable traversal: 32 directories, 512 entries, depth 2, 16 attempted files,
  16 MiB per file and 32 MiB total. It excludes cache directories and links.
  There is no shell, installation, game write or traffic interception.
- Tango dependencies are pinned to `@yume-chan/adb@2.6.4` and
  `@yume-chan/adb-daemon-webusb@2.3.2`; third-party notices and licenses are retained.
- Screenshots are checked and cropped locally before explicit upload to the existing
  recognition service. Header/pixel limits, HEIC recovery, cancellation and cleanup
  are covered. Recognition proves visible cards/levels only; unseen growth remains
  unknown. File/text import and manual entry remain available without recognition.

## Checks

| Check | Observed result |
| --- | --- |
| Synthetic import unit/integration tests | 33 passed, covering field domains, BigInt, missing/zero, conflicts, round trips, required inputs, simulation, locks/bindings, duplicate images, USB bounds/cancellation and recognition cleanup |
| Changed locale messages | 103 messages present in all five locales with matching placeholders |
| Changed source/test ESLint | Passed |
| Frontend TypeScript comparison | Base 81 errors → integrated 81 errors; no added diagnostic in the same installed dependency environment |
| Worker TypeScript comparison | Base 63 errors → integrated 63 errors; no added diagnostic |
| Real engine Worker on the current page | Score, Gekisou, power, potential, event and budget results match the six pre-change complete-inventory fixtures; this is not global formula/optimality proof |
| Activity browser checks | Three modes at 1280/390 widths, light/dark; five locale tabs; direct/converted rewards, stale result currency, CP cost, both budget teams, zero-cost input and incomplete-search status |
| Import browser checks | Edge 154.0.4258.62 at 1280/390/320 widths; desktop/mobile light/dark import dialog; parser Worker, actual/simulation engine Worker, confirm-before-write, repeated import, required fields, crop/upload, HEIC, Escape and owner-change cleanup |
| Browser errors/network | No page exceptions or unexpected application network requests. One environment-injected script request was blocked by the isolated import test harness. |
| Full site build / CI | Full dependency build and full-site checks not completed locally; the existing TypeScript errors remain reported above. CI status is tracked on the PR. |
| Real devices/services | Android USB, iPhone/iPad Safari/photo picker, real account sync and production recognition remain unverified. |

```sh
node scripts/test-account-import.mjs
node scripts/check-account-import-locales.mjs --base da667bc20711161538d842164d3dcdfd899b33f9
node scripts/check-account-import.mjs --baseline --base da667bc20711161538d842164d3dcdfd899b33f9
node scripts/check-account-import.mjs --base da667bc20711161538d842164d3dcdfd899b33f9
node scripts/check-account-import.mjs --worker --baseline --base da667bc20711161538d842164d3dcdfd899b33f9
node scripts/check-account-import.mjs --worker --base da667bc20711161538d842164d3dcdfd899b33f9
node scripts/test-account-import-browser.mjs
```

The browser runner accepts `PLAYWRIGHT_MODULE` and `EDGE_PATH`; otherwise it uses
the installed Playwright/Chromium. It bundles the actual Lit components and Workers,
with a synthetic store/catalogue and a mocked same-origin recognition service.
A 400×800 test image cropped 25% from the top is uploaded as 400×600. Before explicit
upload there is no image POST. Cleanup issues DELETE and revokes local preview URLs.
The narrow review test checks all three strategy buttons fit and can be selected.
Evidence receipts and generated screenshots go to ignored `.local-dev/` paths.

For activity reproduction, create five fully specified members with different
characters, fill the required account bonuses, disable snapshots, then compare the
three Activity modes. For a budget example use 17 boosts, 3 per normal play, 123
starting CP and 200 CP per challenge. Inspect both result teams; switch normal cost
to zero and check that the input becomes a number of plays. Change reward currency
after a completed single-live result and confirm that its old label stays bound to
the old request until recalculation.

## Visual evidence

The import screenshots use synthetic cards. Activity screenshots use a synthetic
inventory with public card images; neither contains a real account.

- [Budget result, desktop light](../../docs/assets/team-builder-import-and-events/activity-desktop.png)
- [Budget conditions, mobile dark](../../docs/assets/team-builder-import-and-events/activity-mobile-dark.png)
- [Import entry, desktop light](../../docs/assets/team-builder-import-and-events/import-desktop.png)
- [Import entry, mobile dark](../../docs/assets/team-builder-import-and-events/import-mobile-dark.png)
- [Screenshot review, narrow screen](../../docs/assets/team-builder-import-and-events/import-review-narrow.png)
