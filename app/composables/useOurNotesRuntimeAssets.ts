import {
  OUR_NOTES_RUNTIME_SOURCES,
  ourNotesAssetManifestForServer,
  type OurNotesRuntimeMediaManifest,
} from "@haneoka/chart/assets";
import type { RuntimeSourceDescriptor } from "~/composables/useRuntimeSourceDescriptor";
import { liveScoreRankIconUrl } from "~/utils/scoreRankAssets";

const normalComboDigitNames = [
  "SP_combo_normal_0.png",
  "SP_combo_normal_1.png",
  "SP_combo_normal_2.png",
  "SP_combo_normal_3.png",
  "SP_combo_normal_4.png",
  "SP_combo_normal_5.png",
  "SP_combo_normal_6.png",
  "SP_combo_normal_7.png",
  "SP_combo_normal_8.png",
  "SP_combo_normal_9.png",
] as const;

const perfectComboDigitNames = [
  "SP_combo_perfect_0.png",
  "SP_combo_perfect_1.png",
  "SP_combo_perfect_2.png",
  "SP_combo_perfect_3.png",
  "SP_combo_perfect_4.png",
  "SP_combo_perfect_5.png",
  "SP_combo_perfect_6.png",
  "SP_combo_perfect_7.png",
  "SP_combo_perfect_8.png",
  "SP_combo_perfect_9.png",
] as const;

/**
 * Resolves the decoded Our Notes runtime media once for every consumer.
 * Chart preview and authoring surfaces must share this manifest so neither
 * can silently drift to substitute note or HUD artwork.
 */
export const useOurNotesRuntimeAssets = () => {
  const { assetRoot, assetServer } = useAssetServer();
  const noteAtlasRequest = useRuntimeSourceDescriptor(OUR_NOTES_RUNTIME_SOURCES.noteAtlas);
  const judgementAtlasRequest = useRuntimeSourceDescriptor(OUR_NOTES_RUNTIME_SOURCES.judgementAtlas);
  const liveAtlasRequest = useRuntimeSourceDescriptor(OUR_NOTES_RUNTIME_SOURCES.liveAtlas);
  const comboAtlasRequest = useRuntimeSourceDescriptor(OUR_NOTES_RUNTIME_SOURCES.comboAtlas);
  const fontRequest = useRuntimeSourceDescriptor(OUR_NOTES_RUNTIME_SOURCES.font);

  const error = computed(
    () =>
      noteAtlasRequest.error.value ||
      judgementAtlasRequest.error.value ||
      liveAtlasRequest.error.value ||
      comboAtlasRequest.error.value,
  );

  const refresh = () =>
    Promise.all([
      noteAtlasRequest.refresh(),
      judgementAtlasRequest.refresh(),
      liveAtlasRequest.refresh(),
      comboAtlasRequest.refresh(),
      fontRequest.refresh(),
    ]);

  const assets = computed(() => {
    const noteAtlas = noteAtlasRequest.data.value;
    const judgementAtlas = judgementAtlasRequest.data.value;
    const liveAtlas = liveAtlasRequest.data.value;
    const comboAtlas = comboAtlasRequest.data.value;
    const font = fontRequest.data.value;
    if (!noteAtlas || !judgementAtlas || !liveAtlas || !comboAtlas || (!font && !fontRequest.error.value)) {
      return undefined;
    }

    const sprite = (descriptor: RuntimeSourceDescriptor, logicalName: string) =>
      resolveRuntimeOutputUrl(descriptor, assetServer.value, logicalName, "Sprite");
    const runtimeMedia: OurNotesRuntimeMediaManifest = {
      noteAtlasTextureUrl: resolveRuntimeOutputUrlByType(noteAtlas, assetServer.value, "Texture2D"),
      ...(font ? { fontAtlasTextureUrl: resolveRuntimeOutputUrlByType(font, assetServer.value, "Texture2D") } : {}),
      hud: {
        judgementImages: {
          just: sprite(judgementAtlas, "judgment_just.png"),
          perfect: sprite(judgementAtlas, "judgment_perfect.png"),
          great: sprite(judgementAtlas, "judgment_great.png"),
          good: sprite(judgementAtlas, "judgment_good.png"),
          bad: sprite(judgementAtlas, "judgment_bad.png"),
          miss: sprite(judgementAtlas, "judgment_miss.png"),
          fast: sprite(judgementAtlas, "judgment_fast.png"),
          late: sprite(judgementAtlas, "judgment_late.png"),
        },
        comboLabelUrl: sprite(comboAtlas, "SP_combo_normal.png"),
        comboDigitUrls: normalComboDigitNames.map((name) => sprite(comboAtlas, name)),
        perfectComboLabelUrl: sprite(comboAtlas, "SP_combo_perfect.png"),
        perfectComboDigitUrls: perfectComboDigitNames.map((name) => sprite(comboAtlas, name)),
        pauseIconUrl: sprite(liveAtlas, "IconPause_ingame.png"),
        pauseFrameUrl: sprite(liveAtlas, "FrameNormalButton_H80_ingame.png"),
        pauseShadowUrl: sprite(liveAtlas, "FrameNormalButton_H80_Shadow_ingame.png"),
        lifeIconUrls: {
          normal: sprite(liveAtlas, "SP_ingame_icon_life.png"),
          danger: sprite(liveAtlas, "SP_ingame_icon_life_danger_0.png"),
          over: sprite(liveAtlas, "SP_ingame_icon_life_over_0.png"),
        },
        rankIconUrls: {
          D: liveScoreRankIconUrl(assetRoot.value, "D"),
          C: liveScoreRankIconUrl(assetRoot.value, "C"),
          B: liveScoreRankIconUrl(assetRoot.value, "B"),
          A: liveScoreRankIconUrl(assetRoot.value, "A"),
          S: liveScoreRankIconUrl(assetRoot.value, "S"),
          SS: liveScoreRankIconUrl(assetRoot.value, "SS"),
        },
        rankBaseUrl: sprite(liveAtlas, "SP_ingame_header_rankbase.png"),
        roundMask14Url: sprite(liveAtlas, "CircleBase14px_Mask_ingame.png"),
        statusBaseUrl: sprite(liveAtlas, "circle_ingame_half.png"),
        scoreStarUrl: sprite(liveAtlas, "star_ingame.png"),
        whiteSpriteUrl: sprite(liveAtlas, "live_game_white.png"),
      },
    };
    return ourNotesAssetManifestForServer(assetServer.value, runtimeMedia);
  });

  return { assets, error, refresh };
};
