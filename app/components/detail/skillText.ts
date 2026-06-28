import type { LocalizedValue } from "~/types/archive";
import { localizeArchiveValue, type ArchiveLocale } from "~/i18n/locales";

export type SkillEffect = Record<string, unknown>;

interface SkillReferenceRow extends SkillEffect {
  raw?: SkillEffect;
}

export interface SkillReferenceDocument {
  conditionSets?: unknown;
  conditions?: unknown;
  cumulativeConditions?: unknown;
  targets?: unknown;
  effectSettings?: unknown;
  effectGroups?: unknown;
  icons?: unknown;
  ratings?: unknown;
  sourceTables?: string[];
}

export interface SkillReferenceIndex {
  conditionSetsByGroup: ReadonlyMap<number, SkillEffect[]>;
  conditionsById: ReadonlyMap<number, SkillEffect>;
  cumulativeConditionsById: ReadonlyMap<number, SkillEffect>;
  targetsById: ReadonlyMap<number, SkillReferenceRow>;
}

export interface SkillLevelEffects {
  effects: SkillEffect[];
  level?: number;
}

export const localizeSkillValue = (value: LocalizedValue | null | undefined, locale: ArchiveLocale): string =>
  localizeArchiveValue(value, locale);

const asRecord = (value: unknown): SkillEffect | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as SkillEffect) : undefined;

const rowsOf = (value: unknown): SkillReferenceRow[] => {
  const values = Array.isArray(value) ? value : Object.values(asRecord(value) || {});
  const rows: SkillReferenceRow[] = [];
  for (const value of values) {
    const row = asRecord(value);
    if (row) rows.push(row);
  }
  return rows;
};

const rawOf = (value: SkillEffect): SkillEffect => asRecord(value.raw) || value;

const fieldOf = (value: SkillEffect, ...keys: string[]): unknown => {
  const raw = rawOf(value);
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
};

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const numberField = (value: SkillEffect, ...keys: string[]): number | undefined => numberOf(fieldOf(value, ...keys));

const numberArray = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    const parsed = numberOf(entry);
    return parsed === undefined ? [] : [parsed];
  });

const indexRows = (value: unknown): Map<number, SkillReferenceRow> => {
  const output = new Map<number, SkillReferenceRow>();
  for (const row of rowsOf(value)) {
    const id = numberField(row, "id", "_id");
    if (id !== undefined) output.set(id, row);
  }
  return output;
};

export const buildSkillReferenceIndex = (reference: SkillReferenceDocument | null | undefined): SkillReferenceIndex => {
  const conditionSetsByGroup = new Map<number, SkillEffect[]>();
  for (const row of rowsOf(reference?.conditionSets)) {
    const group = numberField(row, "group", "_group");
    if (group === undefined) continue;
    const groupRows = conditionSetsByGroup.get(group) || [];
    groupRows.push(row);
    conditionSetsByGroup.set(group, groupRows);
  }
  for (const rows of conditionSetsByGroup.values()) {
    rows.sort((left, right) => (numberField(left, "id", "_id") || 0) - (numberField(right, "id", "_id") || 0));
  }
  return {
    conditionSetsByGroup,
    conditionsById: indexRows(reference?.conditions),
    cumulativeConditionsById: indexRows(reference?.cumulativeConditions),
    targetsById: indexRows(reference?.targets),
  };
};

const targetFromId = (id: number, reference: SkillReferenceIndex): SkillEffect => {
  const row = reference.targetsById.get(id);
  if (!row) return { id };
  const raw = rawOf(row);
  const target: SkillEffect = { ...raw, id, raw };
  // MasterSkillTarget in the current API has no display-name field. Only carry a
  // name if a future API exposes one directly; categorical IDs are not names.
  if (row.name !== undefined) target.name = row.name;
  return target;
};

const targetsFromIds = (ids: unknown, reference: SkillReferenceIndex): SkillEffect[] =>
  numberArray(ids).map((id) => targetFromId(id, reference));

const conditionFromId = (id: number, reference: SkillReferenceIndex): SkillEffect => {
  const row = reference.conditionsById.get(id);
  if (!row) return { id };
  const raw = rawOf(row);
  const values = fieldOf(row, "values", "conditionValues", "_conditionValues");
  const targetIds = fieldOf(row, "targetIds", "conditionTargetIds", "_conditionTargetIDs");
  return {
    ...raw,
    id,
    raw,
    values: Array.isArray(values) ? values : [],
    targets: targetsFromIds(targetIds, reference),
  };
};

const conditionsFromGroup = (group: number | undefined, reference: SkillReferenceIndex): SkillEffect[] => {
  if (!group) return [];
  return (reference.conditionSetsByGroup.get(group) || []).map((setRow) => {
    const conditions = numberArray(fieldOf(setRow, "conditionIds", "_conditionIds")).map((id) =>
      conditionFromId(id, reference),
    );
    // The localized Master templates use both set[0].values and set.values1.
    // valuesN is an exact alias of the Nth condition's _conditionValues.
    conditions.forEach((condition, index) => {
      (conditions as unknown as SkillEffect)[`values${index + 1}`] = condition.values;
    });
    return conditions as unknown as SkillEffect;
  });
};

const cumulativeConditionFromId = (id: number | undefined, reference: SkillReferenceIndex): SkillEffect | undefined => {
  if (!id) return undefined;
  const row = reference.cumulativeConditionsById.get(id);
  if (!row) return { id };
  const raw = rawOf(row);
  const values = fieldOf(row, "values", "conditionValues", "_conditionValues");
  const targetIds = fieldOf(row, "targetIds", "conditionTargetIds", "_conditionTargetIDs");
  return {
    ...raw,
    id,
    raw,
    values: Array.isArray(values) ? values : [],
    maxCount: fieldOf(row, "maxCount", "maxCumulativeCount", "_maxCumulativeCount"),
    targets: targetsFromIds(targetIds, reference),
  };
};

const effectLevel = (effect: SkillEffect): number | undefined => numberField(effect, "level", "_level");

const effectValueLabel = (effect: SkillEffect): string => {
  const value = numberField(effect, "effectValue", "_effectValue");
  if (value === undefined) return "";
  if (numberField(effect, "effectType", "_skillEffectType") !== 11005) return String(value);
  const chanceNoteResult = ["Invalid", "Miss", "Hit", "SuperHit", "Critical"][value];
  return chanceNoteResult ?? String(value - 1);
};

export const selectSkillLevelEffects = (effects: SkillEffect[], requestedLevel?: number): SkillLevelEffects => {
  const levels = effects.map(effectLevel).filter((level): level is number => level !== undefined);
  if (!levels.length) return { effects };
  const level = requestedLevel ?? Math.max(...levels);
  return {
    level,
    effects: effects.filter((effect) => effectLevel(effect) === level),
  };
};

export const resolveSkillLevelEffects = (
  effects: SkillEffect[],
  reference: SkillReferenceIndex,
  requestedLevel?: number,
): SkillLevelEffects => {
  const selected = selectSkillLevelEffects(effects, requestedLevel);
  return {
    level: selected.level,
    effects: selected.effects.map((effect) => {
      const targetIds = fieldOf(effect, "targetIds", "_skillTargetIDs");
      const conditionGroup = numberField(effect, "conditionGroup", "_skillConditionGroup");
      const releaseConditionGroup = numberField(effect, "releaseConditionGroup", "_skillReleaseConditionGroup");
      const triggerConditionGroup = numberField(effect, "triggerConditionGroup", "_skillTriggerConditionGroup");
      const cumulativeConditionId = numberField(effect, "cumulativeConditionId", "_skillCumulativeConditionID");
      return {
        ...effect,
        value: fieldOf(effect, "effectValue", "_effectValue"),
        valueLabel: effectValueLabel(effect),
        maxValue: fieldOf(effect, "maxEffectValue", "_maxEffectValue"),
        time: fieldOf(effect, "activationTimeSecond", "_activationTimeSecond"),
        limitCount: fieldOf(effect, "effectLimitCount", "_effectLimitCount"),
        executeLimitCount: fieldOf(effect, "executeLimitCount", "_effectExecuteLimitCount"),
        EffectExecuteLimitCount: fieldOf(effect, "executeLimitCount", "_effectExecuteLimitCount"),
        targets: targetsFromIds(targetIds, reference),
        con: conditionsFromGroup(conditionGroup, reference),
        rCon: conditionsFromGroup(releaseConditionGroup, reference),
        tCon: conditionsFromGroup(triggerConditionGroup, reference),
        cCon: cumulativeConditionFromId(cumulativeConditionId, reference),
      };
    }),
  };
};

const valueAtPath = (source: unknown, path: string): unknown =>
  path
    .replace(/\[(\d+)]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
      source,
    );

interface RenderResult {
  resolved: boolean;
  value: string;
}

const unresolved = (): RenderResult => ({ resolved: false, value: "" });

const renderValue = (
  expression: string,
  source: { effects: SkillEffect[] },
  localize: (value: LocalizedValue | null | undefined) => string,
): RenderResult => {
  const match = expression.trim().match(/^(effects(?:\[\d+])(?:[.\w]|\[\d+])*)(?:([/*])(\d+(?:\.\d+)?))?(?::F(\d+))?$/);
  if (!match) return unresolved();
  const raw = valueAtPath(source, match[1]!);
  if (typeof raw === "number") {
    const operand = match[3] === undefined ? undefined : Number(match[3]);
    const calculated = match[2] === "/" ? raw / operand! : match[2] === "*" ? raw * operand! : raw;
    if (!Number.isFinite(calculated)) return unresolved();
    return {
      resolved: true,
      value: match[4] === undefined ? String(calculated) : calculated.toFixed(Number(match[4])),
    };
  }
  if (typeof raw === "string") return { resolved: true, value: raw };
  if (Array.isArray(raw) || (raw && typeof raw === "object")) {
    const value = localize(raw as LocalizedValue);
    return value ? { resolved: true, value } : unresolved();
  }
  return raw === null ? { resolved: true, value: "" } : unresolved();
};

const renderBranch = (
  branch: string,
  source: { effects: SkillEffect[] },
  localize: (value: LocalizedValue | null | undefined) => string,
): RenderResult => {
  const trimmed = branch.trim();
  const quoted = trimmed.match(/^"([\s\S]*)"$/);
  if (quoted) return { resolved: true, value: quoted[1] || "" };
  const output: string[] = [];
  for (const part of trimmed.split(/\s*~\s*/)) {
    const literal = part.match(/^"([\s\S]*)"$/);
    if (literal) {
      output.push(literal[1] || "");
      continue;
    }
    const rendered = renderValue(part, source, localize);
    if (!rendered.resolved) return unresolved();
    output.push(rendered.value);
  }
  return { resolved: true, value: output.join("") };
};

export const resolveSkillDescription = (
  template: string,
  levelEffects: SkillEffect[],
  localize: (value: LocalizedValue | null | undefined) => string,
): string => {
  const source = { effects: levelEffects };
  return template.replace(/\{([^{}]+)\}/g, (token, body: string) => {
    const conditional = body.match(/^0\s*<\s*(effects(?:\[\d+])(?:[.\w]|\[\d+])*)\s*\?\s*(.*?)\s*:\s*(.*)$/);
    if (conditional) {
      const rawCondition = valueAtPath(source, conditional[1]!);
      if (typeof rawCondition !== "number") return token;
      const branch = renderBranch(rawCondition > 0 ? conditional[2]! : conditional[3]!, source, localize);
      return branch.resolved ? branch.value : token;
    }
    const rendered = renderValue(body, source, localize);
    return rendered.resolved ? rendered.value : token;
  });
};

export const unresolvedSkillDescriptionTokens = (description: string): string[] => [
  ...new Set(description.match(/\{[^{}]+\}/g) || []),
];

export const stripSkillDescriptionMarkup = (value: string): string =>
  value
    .replace(/<color=[^>]+>/gi, "")
    .replace(/<\/color>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\n/g, "\n")
    .trim();
