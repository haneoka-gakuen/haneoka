export const BESTDORI_CHARACTER_ICON_MAX_ID = 50;
export const BESTDORI_CATALOG_VERSION = "v19-live2d-id";

export const hasBestdoriCharacterIcon = (characterId: unknown): boolean => {
  const id = Number(characterId);
  return Number.isInteger(id) && id > 0 && id <= BESTDORI_CHARACTER_ICON_MAX_ID;
};
