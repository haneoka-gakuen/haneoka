// L3 — GEB
// Input: 数据来源、资源解析器及 loader 选项类型。
// Output: createEmbedLoader、来源工厂、错误与类型。
// Pos: [Map](../../L2.md)；嵌入数据／资源层的公开入口。
// Effects/Dependencies: 入口重导出不挂载 DOM；HTTP／文件读取与 dispose 由创建后的 loader／source 调用管理。
export { createEmbedLoader } from "./loader.js";
export { memoryDataSource, httpDataSource, fileDataSource, fileResourceResolver } from "./sources.js";
export { EmbedHttpError } from "./io.js";
export type {
  DataContext,
  DataSource,
  EmbedEvent,
  EmbedFetcher,
  EmbedLoader,
  EmbedLoaderOptions,
  LoadProgress,
  ResourceLocation,
  ResourceResolver,
} from "./types.js";
