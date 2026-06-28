// Note/judgment enums.

export enum SsNoteType {
  Tap = 0,
  Flick = 1,
  Trace = 2,
  Long = 3,
  Guide = 4,
  Node = 5,
}

export enum NoteOperateType {
  None = 0,
  Normal = 1,
  SlideBegin = 20,
  SlideConnection = 21,
  SlideEnd = 22,
  Flick = 40,
  SlideBeginFlick = 41,
  SlideEndFlick = 42,
  Trace = 60,
  SlideBeginTrace = 61,
  SlideEndTrace = 62,
  SlideConnectionTrace = 63,
  HiddenSlideBegin = 80,
  HiddenSlideEnd = 82,
  GuideBegin = 100,
  GuideBeginNormal = 101,
  GuideBeginFlick = 102,
  GuideEnd = 103,
  GuideBeginTrace = 104,
  GuideEndTrace = 105,
  Combo = 120,
  ComboSkip = 121,
  Hidden = 122,
  InvalidHidden = 123,
}

export enum NoteJudgementType {
  None = 0,
  Normal = 1,
  EasyNormal = 2,
  Flick = 5,
  SlideBegin = 10,
  SlideEnd = 11,
  SlideEndFlick = 12,
  SlideBeginEasy = 15,
  Trace = 21,
  SlideEndTrace = 22,
}

export enum NoteDirection {
  Normal = 0,
  Left = 1,
  Right = 2,
}
export enum SsFlickDir {
  Up = 0,
  Left = 1,
  Right = 2,
  Down = 3,
}

export enum NoteSimulateJudgement {
  None = -1,
  Wait = 0,
  Miss = 1,
  Bad = 2,
  Good = 3,
  Great = 4,
  Perfect = 5,
  Just = 6,
  Pass = 7,
}

export enum JudgeTiming {
  None = 0,
  Fast = 1,
  Late = 2,
  Auto = 3,
  OutOfTime = 4,
}

export enum NoteLineEaseType {
  Linear = 0,
  EaseIn = 1,
  EaseOut = 2,
}
export enum SsEase {
  Linear = 0,
  EaseIn = 1,
  EaseOut = 2,
}
