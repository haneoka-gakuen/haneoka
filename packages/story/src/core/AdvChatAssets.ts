export type AdvChatMaster = {
  id: number;
  chatSoundId: number;
  inOutSoundId: number;
  chatWindowAssetName: string;
  chatIconAssetName: string;
};

export type AdvChatWindowSpriteRect = {
  width: number;
  height: number;
  maskTop: number;
  maskHeight: number;
  maskWidth: number;
};

export type AdvChatRuntimeAssets = {
  defaultDataRoot: string;
  masters: Record<string, AdvChatMaster>;
  /** Human-readable authoring reference -> exact native chat preset. */
  presetsByRef?: Record<string, AdvChatMaster>;
  dataRootsByWindowAsset: Record<string, string>;
  windowRectsByDataRoot: Record<string, AdvChatWindowSpriteRect>;
  iconImagesByAsset: Record<string, string>;
};

type AdvChatRuntimeCarrier = {
  chatAssets?: Partial<AdvChatRuntimeAssets>;
};

/** Build-derived fallback used by resource packs that omit the shared chat runtime catalog. */
export const DEFAULT_ADV_CHAT_DATA_ROOT = "Assets/AddressableResources/Adv/Chat/Data/_template/data/ChatLINE";

const EMPTY_CHAT_WINDOW_SPRITE_RECT: AdvChatWindowSpriteRect = {
  width: 0,
  height: 0,
  maskTop: 0,
  maskHeight: 0,
  maskWidth: 0,
};

export function chatDefaultDataRoot(runtime?: AdvChatRuntimeCarrier | null) {
  const configured = String(runtime?.chatAssets?.defaultDataRoot || "")
    .trim()
    .replace(/\/+$/, "");
  return configured || DEFAULT_ADV_CHAT_DATA_ROOT;
}

export function resolveAdvChatMaster(chatId: unknown, runtime?: AdvChatRuntimeCarrier | null) {
  const id = Number(chatId);
  return Number.isFinite(id) ? runtime?.chatAssets?.masters?.[String(id)] || null : null;
}

export function chatDataRootForWindowAsset(assetName: unknown, runtime?: AdvChatRuntimeCarrier | null) {
  const key = String(assetName || "").trim();
  return runtime?.chatAssets?.dataRootsByWindowAsset?.[key] || "";
}

export function chatWindowSpriteRectForDataRoot(dataRoot: unknown, runtime?: AdvChatRuntimeCarrier | null) {
  const key = String(dataRoot || "").trim();
  const assets = runtime?.chatAssets;
  return (
    assets?.windowRectsByDataRoot?.[key] ||
    assets?.windowRectsByDataRoot?.[chatDefaultDataRoot(runtime)] ||
    EMPTY_CHAT_WINDOW_SPRITE_RECT
  );
}

export function chatDataRootForChatId(chatId: unknown, runtime?: AdvChatRuntimeCarrier | null) {
  const master = resolveAdvChatMaster(chatId, runtime);
  return master ? chatDataRootForWindowAsset(master.chatWindowAssetName, runtime) : "";
}

export function isAdvChatIconAssetName(value: unknown) {
  return /^adv_data_.*_chaticon_/i.test(String(value || "").trim());
}

export function chatIconImagePath(value: unknown, runtime?: AdvChatRuntimeCarrier | null) {
  return runtime?.chatAssets?.iconImagesByAsset?.[String(value || "").trim()] || "";
}

export function isGroupChatParticipants(value: unknown) {
  return (
    String(value || "")
      .trim()
      .split("_")
      .filter(Boolean).length > 1
  );
}
