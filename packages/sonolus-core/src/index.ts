// L3 — GEB
// Input: 目录、谱面、repository 和服务实现模块。
// Output: SonolusLevelService、投影、检索、缓存及类型。
// Pos: [Map](../../L2.md)；通用 Sonolus 资料服务的公开入口。
// Effects/Dependencies: 重导出 repository／service；实际资料获取经调用者提供的 provider。
export {
  InMemoryChartRepository,
  matchesChartQuery,
  parseChartQuery,
  RevisionCache,
  RevisionMismatchError,
} from "./repository.js";
export { projectChartSearch } from "./search.js";
export {
  projectCatalogCharts,
  projectLevelDetails,
  projectLevelInfo,
  projectLevelItem,
  projectLevelList,
  projectPlaylistDetails,
  projectPlaylistInfo,
  projectPlaylistItem,
  projectPlaylistList,
  projectRandomLevelInfo,
  projectRandomLevelList,
  projectServerInfo,
  sonolusLevelName,
  sonolusPlaylistName,
  sonolusServerFromLevelName,
  sonolusSourceRoot,
  sonolusDifficultyTitle,
} from "./projection.js";
export { SonolusLevelService } from "./service.js";
export type {
  CatalogLocale,
  CatalogProjectionOptions,
  CatalogProjectionResult,
  ChartCatalogProvider,
  ChartCatalogSnapshot,
  ChartDataPayload,
  ChartDataProvider,
  ChartDescriptor,
  ChartFilterValue,
  ChartPage,
  ChartQuery,
  ChartRecord,
  ChartRepository,
  ChartRevision,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  LevelTemplate,
  LevelTemplateProvider,
  LevelDetailsOptions,
  LevelInfoOptions,
  SonolusLevelItem,
  SonolusPlaylistItem,
  PreparedChartData,
} from "./types.js";
export type {
  SonolusLevelDataRouteResult,
  SonolusLevelDocumentRouteResult,
  SonolusLevelRouteOptions,
  SonolusLevelRouteResult,
} from "./service.js";
