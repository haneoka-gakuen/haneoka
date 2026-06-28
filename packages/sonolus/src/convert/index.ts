import { parseSs, parseSsAsync } from "./ssParser.js";
import { buildChart } from "./chartModel.js";
import type { InternalChart } from "./types.js";

export * from "./types.js";
export { decodeSsText, parseSs, parseSsAsync } from "./ssParser.js";
export { buildChart } from "./chartModel.js";
export * from "./resolveNote.js";
export * from "./resolveLine.js";
export { chartToUsc } from "./chartToUsc.js";
export { uscToLevelData } from "./usc/uscToLevelData.js";
export { chartToLevelData } from "./chartToLevelData.js";

export function convertChart(input: string | Uint8Array): InternalChart {
  return buildChart(parseSs(input));
}

export async function convertChartAsync(input: string | Uint8Array): Promise<InternalChart> {
  return buildChart(await parseSsAsync(input));
}
