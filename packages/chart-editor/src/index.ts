// L3 — GEB
// Input: 编辑模型、格式、历史与浏览器组件模块。
// Output: 谱面编辑器的公开接口。
// Pos: [Map](../L2-2.md)；编辑包导出与宿主集成边界。
// Effects/Dependencies: 导入／使用的组件可依赖浏览器；格式转换和历史操作与宿主资源存储分开。
export * from "./history";
export * from "./model";
export * from "./timing";
export * from "./validation";
export * from "./viewport";
export * from "./waveform";
export * from "./formats/index";
