/** Browser-neutral mirror of Sonolus LevelData. No Sonolus runtime dependency is required. */
export type SonolusLevelDataValue = { name: string; value: number } | { name: string; ref: string };

export interface SonolusLevelDataEntity {
  name?: string;
  archetype: string;
  data: SonolusLevelDataValue[];
}

export interface SonolusLevelData {
  bgmOffset: number;
  entities: SonolusLevelDataEntity[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isSonolusLevelData = (value: unknown): value is SonolusLevelData =>
  isRecord(value) &&
  typeof value.bgmOffset === "number" &&
  Number.isFinite(value.bgmOffset) &&
  Array.isArray(value.entities) &&
  value.entities.every(
    (entity) =>
      isRecord(entity) &&
      typeof entity.archetype === "string" &&
      (entity.name === undefined || typeof entity.name === "string") &&
      Array.isArray(entity.data) &&
      entity.data.every(
        (data) =>
          isRecord(data) &&
          typeof data.name === "string" &&
          ((typeof data.value === "number" && Number.isFinite(data.value) && data.ref === undefined) ||
            (typeof data.ref === "string" && data.value === undefined)),
      ),
  );
