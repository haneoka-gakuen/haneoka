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
