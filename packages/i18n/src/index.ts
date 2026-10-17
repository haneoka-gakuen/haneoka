// L3 — GEB
// Input: 基础 locale、内容和消息模块的导出。
// Output: i18n 包公开接口。
// Pos: [Map](../../L2.md)；国际化基础能力的包入口。
// Effects/Dependencies: 重导出基础实现；站点消息种子／HTTP 加载由 src/i18n 集成。
export * from "./content.js";
export * from "./locales.js";
export * from "./messages.js";
export * from "./loader.js";
