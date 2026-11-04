// L3 — GEB
// Input: 当前 Cubism SDK 包和锁定的 Core 运行时清单。
// Output: 与制作器共用的惰性适配器模块及 Core 脚本地址。
// Pos: [Map](L2-2.md)；网页查看器与公开图片模块的运行时入口。
// Effects/Dependencies: 按需导入工作区 SDK；Core 继续按许可清单加载。
import runtimeLock from "../../config/cubism-runtime.lock.json";

function runtimeUrl(source: string): string {
  const file = runtimeLock.files.find((entry) => entry.source === source);
  if (!file?.output) throw new Error(`Missing Cubism runtime file: ${source}`);
  return `/${file.output}?v=${file.sha256}`;
}

let runtimeModule: Promise<unknown> | undefined;
export function loadCubismWebRuntime<T = unknown>(): Promise<T> {
  runtimeModule ??= import("@haneoka/vega-plugin-cubism/web-runtime").catch((error: unknown) => {
    runtimeModule = undefined;
    throw error;
  });
  return runtimeModule as Promise<T>;
}

export const CUBISM_CORE_URLS = {
  cubismCoreUrl: runtimeUrl("Core/live2dcubismcore.js"),
  cubism2CoreUrl: runtimeUrl("Core/live2d.min.js"),
  motionSyncCoreUrl: runtimeUrl("Core/CRI/live2dcubismmotionsynccore.min.js"),
};
