import { ADV_TITLE_ANIMATION } from "../core/AdvTitle";

/** Canonical UI reference space used by the Unity ADV RectTransform assets. */
export const UNITY_ADV_REFERENCE_SIZE = Object.freeze({ width: 1920, height: 1080 });

/**
 * UIAdvChatWidget CanvasScaler.
 *
 * `ScaleWithScreenSize + Expand` uses `min(screenWidth / 1920,
 * screenHeight / 1080)` (the serialized MatchWidthOrHeight field is ignored
 * in this enum mode). On the ADV landscape viewport that is the height scale,
 * so horizontal reference pixels must not become percentages of the expanded
 * logical Canvas width.
 */
export const UNITY_ADV_CANVAS_SCALER = Object.freeze({
  uiScaleMode: 1,
  screenMatchMode: 1,
  matchWidthOrHeight: 1,
  referencePixelsPerUnit: 100,
});

export const UNITY_ADV_UI_LAYOUT = Object.freeze({
  // UIAdvTitleView Title + TitleText.
  title: Object.freeze({
    top: 30,
    paddingX: 80,
    paddingY: 15,
    fontSize: 36,
    ...ADV_TITLE_ANIMATION,
  }),
  location: Object.freeze({
    width: 1400,
    // UIAdvWidget overrides the standalone prefab's 62px root to 86px;
    // the visible Background and LocationText remain 62px high.
    frameHeight: 86,
    contentHeight: 62,
    travelX: 300,
    fontSize: 36,
  }),
  subtitles: Object.freeze({ bottom: 60, height: 141, fontSize: 36 }),
  choices: Object.freeze({
    width: 700,
    height: 540,
    centerY: 100,
    itemHeight: 120,
    textWidthDelta: -40,
    textHeightDelta: -19.000003814697266,
    textCenterY: 2.5000014305114746,
    fontSizeMax: 42,
  }),
  defaultTalk: Object.freeze({
    backgroundBottom: -66,
    backgroundHeight: 356,
    backgroundHorizontalOverflow: 400,
    contentWidth: 1580,
    speakerX: 184,
    speakerCenterY: 265,
    speakerWidth: 800,
    speakerHeight: 60,
    talkX: 198.7100067138672,
    talkTopY: 201.91000366210938,
    talkWidth: 1200,
    talkHeight: 200,
    indicatorRightCenter: 152,
    indicatorCenterY: 76,
    indicatorSize: 60,
    fontSize: 36,
  }),
  centerTalk: Object.freeze({
    talkHeight: 200,
    indicatorTopWithinTalk: 141.5,
    indicatorRight: 306,
    indicatorWidth: 28,
    indicatorHeight: 19,
    fontSize: 40,
  }),
  // UIPsychTalkWindow. TalkArea is the only scaled subtree;
  // TalkBackground remains at reference scale as a sibling of TalkArea.
  psychTalk: Object.freeze({
    baselineY: 50,
    backgroundWidth: 1350,
    backgroundHeight: 310,
    contentWidth: 1580,
    contentScale: 0.9,
    speakerX: 73,
    speakerCenterY: 276,
    speakerWidth: 600,
    speakerHeight: 75,
    speakerTextCenterX: 5,
    speakerTextWidthDelta: -50,
    talkX: 103,
    talkTopY: 206,
    talkWidth: 1200,
    talkHeight: 200,
    lineCenterY: 234,
    lineWidth: 1394,
    lineHeight: 13,
    lineBorderX: 15,
    edgeBorder: 32,
    edgePixelsPerUnitMultiplier: 0.7,
    indicatorRightCenter: 110,
    indicatorCenterY: 60,
    indicatorWidth: 28,
    indicatorHeight: 19,
    fontSize: 40,
  }),
});

export function unityAdvWidthPercent(value: number): string {
  return `${(value / UNITY_ADV_REFERENCE_SIZE.width) * 100}%`;
}

export function unityAdvHeightPercent(value: number): string {
  return `${(value / UNITY_ADV_REFERENCE_SIZE.height) * 100}%`;
}

export function unityAdvHeightUnit(value: number): string {
  return `${(value / UNITY_ADV_REFERENCE_SIZE.height) * 100}cqh`;
}

/** Convert a fixed RectTransform reference pixel on either axis. */
export function unityAdvReferenceUnit(value: number): string {
  return unityAdvHeightUnit(value);
}

export function unityAdvWidthUnit(value: number): string {
  return `${(value / UNITY_ADV_REFERENCE_SIZE.width) * 100}cqw`;
}
