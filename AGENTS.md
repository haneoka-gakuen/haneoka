# Guide for agents working on Haneoka

Read this before changing anything visible. These rules come from repeated
review; a change that breaks one of them is not finished.

## Working in this repository

- Several sessions edit the same checkout at once. Stage only your own
  files; never `git add -A` in the main checkout, never commit someone
  else's uncommitted work, and never reset or stash it away.
- Commit messages describe the change. No `Co-authored-by` trailer for an
  AI assistant.
- Verify before pushing: type-check and lint the files you touched, and
  look at every visible change in a browser at desktop width (1280px) and
  phone width (360–412px), in light and dark themes.
- D1 migrations in `worker/database/migrations/` are applied by the deploy
  workflow on every push to `main`. Write them additive and idempotent
  (`IF NOT EXISTS`), and append the same DDL to `worker/database/schema.sql`.
- Only `jp` and `intl` produce static pages. Test servers are data sources,
  not page builds.

## Copy

- Interface text is labels, values and states. No paragraphs explaining
  how something works, no caveats or disclaimers ("model estimate",
  "not verified", "results may differ"), no consent checkboxes, no
  "trial"/"beta" badges inside a page, no instructions that restate what a
  control already shows.
- Errors are one short line naming what is wrong, next to what fixes it.
- Every string exists in all five catalogues (`public/i18n/{en,ja,ko,zh-CN,zh-TW}.json`).
  A visible English fallback in another locale is a bug.
- Use the game's own terms in each locale. Support cards: 留影 / スナップ /
  Snapshot / 스냅 — never "photo", 照片, フォト or 포토.
- Code follows the same rule: no comments that narrate the obvious, no
  defensive re-validation of values the producer already guarantees.

## Shell and title bar

The shell (`src/components/AppShell.astro`) owns the top app bar. Pages put
their controls there instead of drawing their own toolbars.

- Page title: the shell `<h1>`. Entity pages pass `entity` to `AppShell`,
  which gives Back, the entity title and previous/next links.
- Search: `setAppBarSearch` (`src/lib/app-bar.ts`). Never an inline search
  field in the page body.
- Page actions: `setAppBarActions`. Collections get count, view switch and
  the filter toggle from `renderBrowse` automatically.
- Marks after the title (rarity, band, applied filters): `setAppBarIdentity`.
  Applied filters render there as a breadcrumb of removable chips.
- A client-side detail view that needs Back inserts it in the leading slot
  with `data-entity-back` and moves the navigation menu to the actions row,
  as `community-workspace` and `playlist-hub` do; restore both on leave.

## Collections and entities

Every browsable set of things is a collection with canonical entity pages.

- Routes: collection at `/{server}/{locale}/{kind}/`, entity at
  `/{server}/{locale}/{kind}/{id}/` through `src/pages/[server]/[locale]/[kind]/[id].astro`.
  Register new kinds in `RESOURCE_KINDS` (`src/lib/resource-route.ts`).
  Design the id to be stable and readable (`leader-4`, not an index).
  Old query-string addresses redirect to the canonical page.
- Catalogue resources use `<catalog-screen>` with a profile. A collection
  that cannot (help, Live2D, skills) still uses the same building blocks:
  `renderBrowse`, `viewSwitch`, `collectionList`, `collectionTable`,
  `tile`, `facet`, and an entity page component under
  `src/components/entities/`.
- Grid, list and table views all exist. Every tile, row and table title is
  a link (`href`) to the entity page, not a button that opens a pane.
- Load the whole collection. No "load more" over static data; filtering
  and search must see every item.
- Filters live in the filter sheet as facets with counts. Applied filters
  show as breadcrumb chips in the app bar.
- Entity detail: `renderPane({ page: true, hideHeader: true, … })` with
  `detailLayout(media, sections)`. Media goes through `<image-gallery>`.
  Sections use `paneSection` / `renderDetailSectionHeading`; facts in
  `.spec-list`; related objects as `.detail-object` rows; related entities
  as `tile`s in a `.collection` grid; long groups in `accordion`/`fold`.

## Layout stability

- Nothing appears or disappears in a way that moves content the reader is
  looking at. Selection counts, applied filters, save state and similar
  status go in the app bar, a breadcrumb, a chip already in place, or a
  snackbar (`snackbar()` in `src/lib/snackbar.ts`). No banner, inline
  message or field note that appears and pushes content down.
- Confirmations are dialogs (`<dialog class="dialog">` with `modal()`),
  not blocks inserted above the content.
- Validation: mark the field with an outline once the reader tries to
  submit; list what is missing in one place with links to each field. No
  extra text lines under every field, no errors before the first attempt.
- Reserve image boxes with known dimensions or aspect ratios so loading
  never reflows the page.

## Styling

- Material 3 Expressive through the existing system. Colours, type,
  shape, spacing and motion come from `--md-sys-*` tokens
  (`src/styles/base/tokens.css`). No literal colours except scrims and
  text over artwork.
- Reuse before writing CSS: `src/styles/components/` (buttons, chips,
  lists, tables, inputs, dialogs, accordion), `src/styles/patterns/`
  (browse, collection, detail), `src/styles/system/layout.css` (`.page`,
  `.stack`, `.cluster`, `.row`, `.grid`, `.split`). A page that needs a
  private copy of a shared pattern is using the pattern wrongly.
- Page CSS only for visuals that exist nowhere else, inside
  `@layer pages`, scoped under the page's root class. Do not borrow
  another page's private classes (`tb-*`, `anon-*`); they are not loaded
  elsewhere.
- Lit components render into light DOM (`createRenderRoot() { return this; }`)
  so shared CSS applies.
- Tools (team builder, song puzzle, editors) use the two-column tool
  layout: the working surface or results on one side, settings in
  `.surface` sections with a `detail-section-title` heading on the other;
  rarely used settings in an accordion; the primary action as a full-width
  button at the end of the settings.
- Touch targets are at least 48px. No horizontal page scroll at 360px;
  wide content scrolls inside its own region.
- Icons are written literally (`icon("search")`) so the sprite builder can
  find them; run `python3 scripts/build/icon_sprite.py` after adding one.

## Performance

- Prefer one complete, cacheable payload over many small requests, but
  never trade completeness for speed: search and filters work on the
  whole set.
- Lazy-load images (`loading="lazy"` or `LazyImages`) and heavy modules
  (`import()` on the route that needs them).
- Keep per-page embedded data to what that page renders.
