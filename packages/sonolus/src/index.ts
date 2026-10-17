// L3 — GEB
// Input: 站点目录、模板、运行谱面及转换适配模块。
// Output: Haneoka Sonolus 站点适配公开接口。
// Pos: [Map](../L2-2.md)；网站资源到 Sonolus 服务的包边界。
// Effects/Dependencies: 依赖外部转换与 core；引擎编译和 worker-assets 由脚本生成，不在入口保证已就绪。
export * from "@haneoka/cassiopeia-plugin-sonolus";
export * from "./runtime/index.js";
export {
  createOurNotesSonolusItemLabels,
  encodeSonolusLocalizedText,
  localizeSonolusDocument,
  sonolusSongCategoryTitle,
  OUR_NOTES_SONOLUS_ITEM_NAMES,
} from "./sonolusLocalization.js";
export type {
  OurNotesSonolusNativeLabels,
  SonolusJsonObject,
  SonolusJsonPrimitive,
  SonolusJsonValue,
  SonolusLocalizedLabels,
  SonolusLocalization,
} from "./sonolusLocalization.js";
