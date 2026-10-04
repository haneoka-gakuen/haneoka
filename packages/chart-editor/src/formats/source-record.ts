import { structuredCloneValue, type JsonValue } from "../model";
import { isRecord } from "./shared";

export interface SourceRecord {
  source: Record<string, JsonValue>;
  baseline: Record<string, JsonValue>;
}

/** Preserve source spelling/omissions/extensions until a modeled field changes. */
export function restoreSourceRecord(record: unknown, current: Record<string, unknown>): Record<string, JsonValue> {
  const saved = isRecord(record) && isRecord(record.source) && isRecord(record.baseline) ? record : undefined;
  const source = saved ? structuredCloneValue(saved.source as Record<string, JsonValue>) : {};
  const baseline = saved?.baseline as Record<string, JsonValue> | undefined;
  for (const key of new Set([...Object.keys(baseline ?? {}), ...Object.keys(current)])) {
    const value = current[key];
    if (baseline && JSON.stringify(value) === JSON.stringify(baseline[key])) continue;
    if (value === undefined) delete source[key];
    else source[key] = structuredCloneValue(value) as JsonValue;
  }
  return source;
}

export const sourceRecord = (source: Record<string, unknown>, baseline: Record<string, unknown>): SourceRecord => ({
  source: structuredCloneValue(source) as Record<string, JsonValue>,
  baseline: JSON.parse(JSON.stringify(baseline)) as Record<string, JsonValue>,
});
