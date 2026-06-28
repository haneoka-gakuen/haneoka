import type { AdvMotionSyncRuntime, AdvMotionSyncSetting } from "../../types/AdvRuntime";

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isUsableSetting(value: unknown): value is AdvMotionSyncSetting {
  const setting = record(value);
  return (
    Array.isArray(setting.parameters) &&
    setting.parameters.length > 0 &&
    Array.isArray(setting.audioParameters) &&
    setting.audioParameters.length > 0 &&
    Array.isArray(setting.mappings) &&
    setting.mappings.length > 0
  );
}

/** Selects Unity setting index zero after discarding structurally unusable rows. */
export function selectAdvMotionSyncSetting(
  value: AdvMotionSyncRuntime | AdvMotionSyncSetting | unknown,
): AdvMotionSyncSetting | null {
  if (isUsableSetting(value)) return value;
  const settings = record(value).settings;
  return Array.isArray(settings) ? (settings.find(isUsableSetting) ?? null) : null;
}

/** Silence is the neutral viseme in every CubismMotionSyncData asset. */
export function advMotionSyncNeutralValues(setting: AdvMotionSyncSetting): Readonly<Record<string, number>> {
  const silence = setting.mappings.find(
    (mapping) => String(mapping?.audioParameterId || "").toLowerCase() === "silence",
  );
  const result: Record<string, number> = {};
  for (const target of silence?.targets || []) {
    const id = String(target?.id || "");
    const value = Number(target?.value);
    if (id && Number.isFinite(value)) result[id] = value;
  }
  return result;
}

/** Live2DLipSyncController's captured-base composition, including Cubism range clamping. */
export function applyAdvMotionSyncOnCapturedBase(
  baseValue: number,
  analyzedValue: number,
  neutralValue: number,
  minimum: number,
  maximum: number,
  weight = 1,
): number {
  const min = Math.min(finite(minimum), finite(maximum));
  const max = Math.max(finite(minimum), finite(maximum));
  const value = finite(baseValue) + (finite(analyzedValue) - finite(neutralValue)) * Math.max(0, finite(weight, 1));
  return Math.max(min, Math.min(max, value));
}
