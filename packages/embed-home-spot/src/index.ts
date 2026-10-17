// L3 — GEB
// Input: 场景挂载与宿主选项类型。
// Output: mountHomeSpot 和场景句柄公开导出。
// Pos: [Map](../../L2.md)；Home Spot 嵌入的包入口。
// Effects/Dependencies: 入口重导出；实际挂载创建浏览器舞台并读取资源，生命周期由 mount 实现管理。
export { mountHomeSpot } from "./mount.js";
export type {
  HomeSpotDocument,
  HomeSpotInput,
  HomeSpotHostOptions,
  MountHomeSpotOptions,
  HomeSpotEvent,
  HomeSpotUpdate,
  HomeSpotExportOptions,
  HomeSpotHandle,
} from "./types.js";
