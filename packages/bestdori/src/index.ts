// L3 — GEB
// Input: Bestdori 输入、传输和转换模块。
// Output: 包公开的资源、场景、谱面与诊断接口。
// Pos: [Map](../../L2.md)；Bestdori 能力的公开导出边界。
// Effects/Dependencies: 网络和缓存取决于调用的 transport／资源方法；导出存在不表示镜像已就绪。
export * from "./chart.js";
export * from "./cache-policy.js";
export * from "./diagnostics.js";
export * from "./input.js";
export * from "./live2d.js";
export * from "./resources.js";
export * from "./scene.js";
export * from "./scenario.js";
export * from "./transport.js";
