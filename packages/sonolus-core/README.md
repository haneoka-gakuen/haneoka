# `@haneoka/sonolus-core`

Runtime-neutral chart repository contracts and pure Sonolus level and playlist document projection.

The package has no framework or platform dependencies. Browser, Worker, and Node adapters provide release/catalog I/O and pass plain JSON into the core.

```ts
import { InMemoryChartRepository, projectCatalogCharts, projectLevelList } from "@haneoka/sonolus-core";

const projection = projectCatalogCharts(songs, bands, {
  mediaBaseUrl: "https://cdn.example.com",
});
const records = projection.charts.map((chart) => ({ ...chart, item: makeLevelItem(chart) }));
const repository = new InMemoryChartRepository(revision, records);
const page = await repository.query({ page: 0, pageSize: 20 });
const document = projectLevelList(page);
```

Every repository snapshot has an explicit revision. Callers can pin reads with `query.revision` or `find(name, revision)`; a mismatch throws `RevisionMismatchError` instead of returning mixed-release data.

`SonolusLevelService` is the platform-neutral application service. Supply a `readJson(releasePath)` adapter for fetch, R2, or the local filesystem; the service keeps a bounded revision cache and projects server, level, and song-playlist info, list, detail, and chart-data documents from one release snapshot. Level and playlist info each expose five random and five newest items; playlists embed every available difficulty for one song.

Level and playlist searches expose artist, category, difficulty, and rating filters alongside keywords. Artist and category options come from the full catalog with stable identifiers and localized titles. Selected values within a filter are combined with OR; different filters are combined with AND. Playlist results include songs with at least one matching chart and retain all their difficulties. Keyword search matches every available title, artist, and category translation.

Level details include every other difficulty for the same song and release server,
plus five songs sharing an artist. Artist recommendations favor the current
difficulty and nearby ratings, with a search link to the full artist catalog.
Section titles use Sonolus client localization tokens. Catalog `previewUrl`
values become the level's separate `preview` audio resource.

Descriptions show lyricist, composer and arranger credits with Sonolus's
`#LYRICIST`, `#COMPOSER`, `#ARRANGER` and `#SEPARATOR_COLON` interpolation keys.
Ruby and phonetic readings also provide hiragana, katakana and romaji keywords.
Game `<r=reading>text</r>` and `<ruby=reading>text</ruby>` markup contributes both
the text and reading without displaying the markup.
Search includes these readings, every credit translation and description text;
it filters descriptors before preparing chart data.

Song playlists display the same localized category tags and description as their
levels, including credits and reading keywords. Difficulty tags remain on the
embedded levels.
