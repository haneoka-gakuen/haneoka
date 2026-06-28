import { cloneStoryValue, createStoryId, type JsonObject, type JsonValue, type StoryProjectCommand } from "./model.js";

/** Mirrors `@haneoka/story`'s Unity ADV opcode table. Gaps 8 and 22 are intentional. */
export const ADV_COMMAND = Object.freeze({
  In: 0,
  Out: 1,
  Talk: 2,
  Delay: 3,
  Shake: 4,
  FadeOut: 5,
  FadeIn: 6,
  Focus: 7,
  Forward: 9,
  Back: 10,
  Flash: 11,
  Brightness: 12,
  MoveToRight: 13,
  MoveToLeft: 14,
  Bgm: 15,
  SoundVolume: 16,
  Expression: 17,
  Pause: 18,
  Resume: 19,
  Location: 20,
  Motion: 21,
  Character: 23,
  Costume: 24,
  Stage: 25,
  Movie: 26,
  Clip: 27,
  Subtitles: 28,
  Wait: 29,
  Still: 30,
  Se: 31,
  Angle: 32,
  Pan: 33,
  Tilt: 34,
  TalkWindow: 35,
  ChatWindow: 36,
  ChatTalk: 37,
  ChatStamp: 38,
  ChatRead: 39,
  ChoiceSet: 40,
  ChoiceShow: 41,
  GoTo: 42,
  PostEffect: 43,
  Frame: 44,
  Timeline: 45,
  Look: 46,
  Pedestal: 47,
  Track: 48,
  DoF: 49,
  Role: 50,
  CameraShake: 51,
  Voice: 52,
  Zoom: 53,
  Effect: 54,
  Alpha: 55,
  ForceAuto: 56,
  StageEnv: 57,
  RimLight: 58,
  CancelDelay: 59,
  MoveToUp: 60,
  MoveToDown: 61,
  MoveToForward: 62,
  MoveToBack: 63,
  MoveToDirection: 64,
  ChatTyping: 65,
  LookTarget: 66,
  PanV2: 67,
  /** Generic Story opcode namespace starts at 500. */
  CommandGroup: 500,
});

export type AdvCommandName = keyof typeof ADV_COMMAND;
export type CommandCategory =
  | "dialogue"
  | "character"
  | "stage"
  | "camera"
  | "audio"
  | "transition"
  | "chat"
  | "flow"
  | "timing"
  | "media"
  | "system";
export type CommandFieldKind =
  | "text"
  | "localized-text"
  | "localized-list"
  | "number"
  | "vector3"
  | "boolean"
  | "select"
  | "multi-select"
  | "choice-list"
  | "resource"
  | "resource-list";
export type CommandResourceKind =
  "live2d" | "background" | "still" | "frame" | "effect" | "post-effect" | "audio" | "video" | "timeline";

export interface CommandFieldDescriptor {
  /** Stable semantic editor key; never an opaque native column or P-number. */
  key: string;
  label: string;
  kind: CommandFieldKind;
  /** Top-level canonical field. Defaults to `key`. */
  sourceKey?: string;
  /** Zero-based native parameter slot used internally by this semantic field. */
  parameterIndex?: number;
  /** Native ADV parameters are strings even when their editor is numeric. */
  parameterEncoding?: "string";
  /** Only surface this global semantic field when imported data actually contains it. */
  presentOnly?: boolean;
  required?: boolean;
  resource?: CommandResourceKind;
  audioUsage?: "bgm" | "se" | "voice";
  choices?: ReadonlyArray<{ value: JsonValue; label: string }>;
  placeholder?: string;
}

export interface CommandDescriptor {
  code: number;
  name: AdvCommandName;
  type: string;
  label: string;
  category: CommandCategory;
  fields: readonly CommandFieldDescriptor[];
  defaultFields: JsonObject;
  primaryField?: string;
}

const field = (
  key: string,
  label: string,
  kind: CommandFieldKind,
  options: Omit<CommandFieldDescriptor, "key" | "label" | "kind"> = {},
): CommandFieldDescriptor => ({ key, label, kind, ...options });
const text = (key: string, label: string, options: Partial<CommandFieldDescriptor> = {}) =>
  field(key, label, "text", options);
const localized = (key: string, label: string, required = false) =>
  field(key, label, "localized-text", required ? { required: true } : {});
const localizedList = (key: string, label: string) => field(key, label, "localized-list");
const number = (key: string, label: string, options: Partial<CommandFieldDescriptor> = {}) =>
  field(key, label, "number", options);
const boolean = (key: string, label: string, options: Partial<CommandFieldDescriptor> = {}) =>
  field(key, label, "boolean", options);
const select = (
  key: string,
  label: string,
  choices: ReadonlyArray<{ value: JsonValue; label: string }>,
  options: Partial<CommandFieldDescriptor> = {},
) => field(key, label, "select", { choices, ...options });
const multiSelect = (
  key: string,
  label: string,
  choices: ReadonlyArray<{ value: JsonValue; label: string }>,
  options: Partial<CommandFieldDescriptor> = {},
) => field(key, label, "multi-select", { choices, ...options });
const resource = (
  key: string,
  label: string,
  kind: CommandResourceKind,
  options: Partial<CommandFieldDescriptor> = {},
) => field(key, label, "resource", { resource: kind, ...options });
const resourceList = (
  key: string,
  label: string,
  kind: CommandResourceKind,
  options: Partial<CommandFieldDescriptor> = {},
) => field(key, label, "resource-list", { resource: kind, ...options });
const parameter = (
  key: string,
  label: string,
  index: number,
  kind: "text" | "number" | "select",
  options: Partial<CommandFieldDescriptor> = {},
) => field(key, label, kind, { sourceKey: "params", parameterIndex: index, parameterEncoding: "string", ...options });
const parameterNumber = (key: string, label: string, index: number, options: Partial<CommandFieldDescriptor> = {}) =>
  parameter(key, label, index, "number", options);
const parameterText = (key: string, label: string, index: number, options: Partial<CommandFieldDescriptor> = {}) =>
  parameter(key, label, index, "text", options);
const parameterSelect = (
  key: string,
  label: string,
  index: number,
  choices: ReadonlyArray<{ value: JsonValue; label: string }>,
  options: Partial<CommandFieldDescriptor> = {},
) => parameter(key, label, index, "select", { choices, ...options });

const POSITION_CHOICES = Object.freeze([
  { value: 0, label: "None" },
  { value: 1, label: "Position 1" },
  { value: 2, label: "Between 1 and 2" },
  { value: 3, label: "Position 2" },
  { value: 4, label: "Between 2 and 3" },
  { value: 5, label: "Center" },
  { value: 6, label: "Between 3 and 4" },
  { value: 7, label: "Position 4" },
  { value: 8, label: "Between 4 and 5" },
  { value: 9, label: "Position 5" },
]);
const CAMERA_DISTANCE_CHOICES = Object.freeze([
  { value: 0, label: "Knee shot" },
  { value: 1, label: "Waist shot" },
  { value: 2, label: "Bust shot" },
  { value: 3, label: "Up shot" },
  { value: 4, label: "Close-up" },
  { value: 5, label: "Big close-up" },
  { value: 6, label: "Detail shot" },
]);
const CANVAS_LAYER_CHOICES = Object.freeze([
  { value: 0, label: "Background" },
  { value: 1, label: "Overlay" },
  { value: 2, label: "Character" },
  { value: 3, label: "Foreground" },
  { value: 4, label: "Chat" },
  { value: 5, label: "Frame" },
  { value: 6, label: "Video" },
  { value: 7, label: "Still" },
  { value: 8, label: "Front" },
  { value: 9, label: "Talk window" },
]);
const EASING_CHOICES = Object.freeze(
  [
    [1, "Linear"],
    [2, "In sine"],
    [3, "Out sine"],
    [4, "In/out sine"],
    [5, "In quad"],
    [6, "Out quad"],
    [7, "In/out quad"],
    [8, "In cubic"],
    [9, "Out cubic"],
    [10, "In/out cubic"],
    [11, "In quart"],
    [12, "Out quart"],
    [13, "In/out quart"],
    [14, "In quint"],
    [15, "Out quint"],
    [16, "In/out quint"],
    [17, "In expo"],
    [18, "Out expo"],
    [19, "In/out expo"],
    [20, "In circ"],
    [21, "Out circ"],
    [22, "In/out circ"],
    [26, "In back"],
    [27, "Out back"],
    [28, "In/out back"],
    [29, "In bounce"],
    [30, "Out bounce"],
    [31, "In/out bounce"],
  ].map(([value, label]) => ({ value, label })),
) as ReadonlyArray<{ value: JsonValue; label: string }>;
const TARGET_STATUS_CHOICES = Object.freeze([
  { value: 0, label: "Show name" },
  { value: 1, label: "Anonymous (???)" },
  { value: 2, label: "Hide name" },
]);
const LIP_SYNC_CHOICES = Object.freeze([
  { value: "", label: "Normal" },
  { value: "AirLipSync", label: "Air lip sync" },
  { value: "AirLipSync_HoldOpen", label: "Air lip sync · hold open" },
  { value: "EveryoneLipSync", label: "All characters" },
]);
const LOOK_MODE_CHOICES = Object.freeze([
  { value: "", label: "Start" },
  { value: "Start", label: "Start" },
  { value: "Stop", label: "Stop" },
]);
const ENABLED_STRING_CHOICES = Object.freeze([
  { value: "", label: "Disabled" },
  { value: "SkipClipTarget", label: "Enabled" },
]);
const CHAT_SCREEN_MODE_CHOICES = Object.freeze([
  { value: 0, label: "Chat" },
  { value: 1, label: "Incoming call" },
  { value: 2, label: "Lock screen" },
]);

const position = (key = "positionType", label = "Position") =>
  select(key, label, POSITION_CHOICES, { sourceKey: "positionType" });
const cameraDistance = select("cameraDistance", "Camera distance", CAMERA_DISTANCE_CHOICES);
const canvasLayers = multiSelect("canvasLayers", "Canvas layers", CANVAS_LAYER_CHOICES);
const duration = (label = "Duration") => number("duration", label);
const vector3 = (key: string, label: string) => field(key, label, "vector3");
const delay = number("delaySeconds", "Start delay");
const noWait = boolean("noWait", "Continue immediately");
const easing = (index = 1) => parameterSelect("easing", "Easing", index, EASING_CHOICES);
const targetName = (label = "Character") => text("targetName", label);
const sceneLabel = field("sceneLabel", "Scene label", "text", { sourceKey: "key", presentOnly: true });

const descriptor = (
  name: AdvCommandName,
  type: string,
  label: string,
  category: CommandCategory,
  fields: readonly CommandFieldDescriptor[] = [],
  defaultFields: JsonObject = {},
  primaryField?: string,
): CommandDescriptor => ({
  code: ADV_COMMAND[name],
  name,
  type,
  label,
  category,
  fields,
  defaultFields,
  ...(primaryField === undefined ? {} : { primaryField }),
});

/**
 * Haneoka-authored authoring schema validated against the documented native
 * opcode behavior. The descriptors expose semantic values only; native IDs,
 * row columns, snapshots, and unused parameter slots remain private codec state.
 */
export const COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = Object.freeze([
  descriptor(
    "In",
    "characterIn",
    "Character in",
    "character",
    [targetName(), position(), vector3("characterWorldPosition", "World position"), duration("Fade duration"), noWait],
    { targetName: "", positionType: 5, duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "Out",
    "characterOut",
    "Character out",
    "character",
    [targetName(), vector3("characterWorldPosition", "World destination"), duration("Fade duration"), noWait],
    { targetName: "", duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "Talk",
    "talk",
    "Talk",
    "dialogue",
    [
      targetName("Lip-sync character"),
      localizedList("targetTextNames", "Displayed speaker name"),
      select("targetStatus", "Name display", TARGET_STATUS_CHOICES),
      localized("text", "Dialogue"),
      resourceList("voiceRefs", "Character voice", "audio", { audioUsage: "voice" }),
      boolean("ignoreLipSync", "Disable lip sync"),
      parameterSelect("lipSyncMode", "Lip-sync mode", 0, LIP_SYNC_CHOICES),
      parameterNumber("mouthOpening", "Mouth opening", 1),
      boolean("hideTalkOnComplete", "Hide dialogue when complete"),
      noWait,
    ],
    { targetName: "", text: "" },
    "text",
  ),
  descriptor(
    "Delay",
    "delay",
    "Delay",
    "timing",
    [duration("Wait time"), field("sceneLabel", "Scene label", "text", { sourceKey: "key" })],
    { duration: 1 },
    "duration",
  ),
  descriptor(
    "Shake",
    "shake",
    "Screen shake",
    "transition",
    [canvasLayers, parameterNumber("strength", "Strength", 0), duration(), noWait],
    { canvasLayers: [], params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "FadeOut",
    "fadeOut",
    "Fade out",
    "transition",
    [text("targetAssetName", "Transition mask"), parameterText("color", "Color", 0), easing(), duration(), noWait],
    { params: ["#000000", "6"], duration: 0.3 },
  ),
  descriptor(
    "FadeIn",
    "fadeIn",
    "Fade in",
    "transition",
    [text("targetAssetName", "Transition mask"), parameterText("color", "Color", 0), easing(), duration(), noWait],
    { params: ["#000000", "6"], duration: 0.3 },
  ),
  descriptor(
    "Focus",
    "focus",
    "Focus",
    "camera",
    [targetName(), position(), cameraDistance, duration(), easing(), delay, noWait],
    { targetName: "", positionType: 5, cameraDistance: 2, params: ["", "6"], duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "Forward",
    "forward",
    "Bring stage position forward",
    "character",
    [position("positionType", "Stage position")],
    { positionType: 5 },
  ),
  descriptor(
    "Back",
    "back",
    "Send stage position backward",
    "character",
    [position("positionType", "Stage position")],
    { positionType: 5 },
  ),
  descriptor("Flash", "flash", "Flash", "transition", [duration(), noWait], { duration: 0.2 }),
  descriptor(
    "Brightness",
    "brightness",
    "Brightness",
    "camera",
    [
      targetName("Character (optional)"),
      position(),
      canvasLayers,
      parameterNumber("brightness", "Brightness", 0),
      duration(),
      noWait,
    ],
    { params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToRight",
    "moveToRight",
    "Move right",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToLeft",
    "moveToLeft",
    "Move left",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "Bgm",
    "bgm",
    "BGM",
    "audio",
    [
      resource("bgmRef", "Music", "audio", { audioUsage: "bgm" }),
      parameterNumber("fadeIn", "Fade in", 0),
      parameterNumber("startOffset", "Start offset", 1),
      duration("Auto-stop after"),
      parameterNumber("stopFade", "Stop fade", 2),
    ],
    { bgmRef: "", params: ["0", "0", "0"], duration: 0 },
    "bgmRef",
  ),
  descriptor(
    "SoundVolume",
    "soundVolume",
    "Sound volume",
    "audio",
    [
      parameterSelect("audioBus", "Audio category", 0, [
        { value: "Bgm", label: "Music" },
        { value: "Se", label: "Sound effects" },
        { value: "Voice", label: "Character voice" },
      ]),
      parameterNumber("volume", "Target volume", 1),
      duration("Transition duration"),
      noWait,
    ],
    { params: ["Bgm", "1"], duration: 0.3 },
  ),
  descriptor(
    "Expression",
    "expression",
    "Expression",
    "character",
    [
      targetName(),
      text("expressionName", "Expression", { required: true }),
      number("motionFadeIn", "Crossfade duration"),
    ],
    { targetName: "", expressionName: "", motionFadeIn: 0 },
    "expressionName",
  ),
  descriptor("Pause", "pause", "Pause character", "character", [targetName()], { targetName: "" }, "targetName"),
  descriptor("Resume", "resume", "Resume character", "character", [targetName()], { targetName: "" }, "targetName"),
  descriptor(
    "Location",
    "location",
    "Location",
    "dialogue",
    [localized("text", "Location", true), noWait],
    { text: "" },
    "text",
  ),
  descriptor(
    "Motion",
    "motion",
    "Motion",
    "character",
    [
      targetName(),
      text("motionName", "Motion", { required: true }),
      text("expressionName", "Expression"),
      number("motionFadeIn", "Crossfade duration"),
      number("motionWait", "Queued start delay"),
    ],
    { targetName: "", motionName: "", expressionName: "", motionFadeIn: 0, motionWait: 0 },
    "motionName",
  ),
  descriptor(
    "Character",
    "loadLive2d",
    "Load character model",
    "character",
    [targetName(), resource("live2dKey", "Character model", "live2d"), number("targetAssetIndex", "Costume index")],
    { targetName: "", live2dKey: "", targetAssetIndex: 0 },
    "live2dKey",
  ),
  descriptor(
    "Costume",
    "costume",
    "Costume",
    "character",
    [targetName(), number("targetAssetIndex", "Costume index")],
    { targetName: "", targetAssetIndex: 0 },
    "targetName",
  ),
  descriptor(
    "Stage",
    "background",
    "Background",
    "stage",
    [resource("backgroundRef", "Background", "background"), duration("Transition duration"), noWait],
    { backgroundRef: "", duration: 0.3 },
    "backgroundRef",
  ),
  descriptor(
    "Movie",
    "movie",
    "Movie",
    "media",
    [
      resource("videoRef", "Video", "video"),
      parameterNumber("fadeIn", "Fade in", 0),
      parameterNumber("fadeOut", "Fade out", 1),
    ],
    { videoRef: "", params: ["0", "0"] },
    "videoRef",
  ),
  descriptor(
    "Clip",
    "clip",
    "Clip",
    "media",
    [
      resource("videoRef", "Video", "video"),
      parameterNumber("transitionDuration", "Opacity transition", 0),
      parameterNumber("opacity", "Opacity", 1),
      parameterSelect("allowSkip", "Allow skip", 2, ENABLED_STRING_CHOICES),
    ],
    { videoRef: "", params: ["0", "1", ""] },
    "videoRef",
  ),
  descriptor(
    "Subtitles",
    "subtitles",
    "Video subtitles",
    "media",
    [localized("text", "Subtitle", true), noWait],
    { text: "" },
    "text",
  ),
  descriptor("Wait", "wait", "Wait for input", "dialogue"),
  descriptor(
    "Still",
    "still",
    "Still",
    "stage",
    [
      resource("stillRef", "Still", "still"),
      parameterNumber("transitionDuration", "Transition duration", 0),
      parameterNumber("stillOpacity", "Image opacity", 1),
      parameterNumber("animationIndex", "Animation index", 2),
      parameterNumber("overlayOpacity", "Overlay opacity", 3),
      noWait,
    ],
    { stillRef: "", params: ["0.3", "1", "0", "0"] },
    "stillRef",
  ),
  descriptor(
    "Se",
    "se",
    "Sound effect",
    "audio",
    [
      resource("seRef", "Sound effect", "audio", { audioUsage: "se" }),
      parameterSelect("playMode", "Action", 0, [
        { value: "", label: "Play" },
        { value: "Stop", label: "Stop" },
      ]),
      parameterNumber("fadeOut", "Stop fade", 1),
      parameterNumber("playbackDelay", "Playback delay", 2),
      duration("Auto-stop after"),
      delay,
    ],
    { seRef: "", params: ["", "0", "0"], duration: 0, delaySeconds: 0 },
    "seRef",
  ),
  descriptor(
    "Angle",
    "angle",
    "Character angle",
    "character",
    [
      targetName(),
      parameterNumber("faceAngle", "Face angle", 0),
      parameterNumber("bodyAngle", "Body angle", 1),
      duration(),
      delay,
      noWait,
    ],
    { targetName: "", params: ["0", "0"], duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "Pan",
    "pan",
    "Camera pan",
    "camera",
    [parameterNumber("yaw", "Horizontal rotation", 0), easing(), duration(), noWait],
    { params: ["0", "6"], duration: 0.3 },
  ),
  descriptor(
    "Tilt",
    "fieldTilt",
    "Camera tilt",
    "camera",
    [parameterNumber("pitch", "Vertical rotation", 0), easing(), duration(), noWait],
    { params: ["0", "6"], duration: 0.3 },
  ),
  descriptor(
    "TalkWindow",
    "talkWindow",
    "Talk window",
    "dialogue",
    [text("talkWindow", "Window style")],
    { talkWindow: "" },
    "talkWindow",
  ),
  descriptor(
    "ChatWindow",
    "chatWindow",
    "Chat window",
    "chat",
    [
      targetName("Participants"),
      text("chatPresetRef", "Chat preset"),
      localizedList("targetTextNames", "Displayed title"),
      parameterNumber("batteryLevel", "Battery level", 0),
      parameterSelect("screenMode", "Screen mode", 1, CHAT_SCREEN_MODE_CHOICES),
      parameterText("chatMemoryRef", "Conversation thread", 2),
      noWait,
    ],
    { targetName: "", chatPresetRef: "", params: ["", "0", ""] },
    "chatPresetRef",
  ),
  descriptor(
    "ChatTalk",
    "chatTalk",
    "Chat message",
    "chat",
    [
      text("chatPresetRef", "Sender chat preset"),
      localizedList("targetTextNames", "Displayed sender"),
      localized("text", "Message", true),
      parameterNumber("readCount", "Read count", 0),
      parameterText("chatMemoryRef", "Conversation thread", 2),
      resourceList("voiceRefs", "Character voice", "audio", { audioUsage: "voice" }),
      noWait,
    ],
    { chatPresetRef: "", text: "", params: ["0", "", ""] },
    "text",
  ),
  descriptor(
    "ChatStamp",
    "chatStamp",
    "Chat stamp",
    "chat",
    [
      text("chatPresetRef", "Sender chat preset"),
      localizedList("targetTextNames", "Displayed sender"),
      text("targetAssetName", "Stamp asset", { required: true }),
      parameterNumber("readCount", "Read count", 0),
      parameterText("chatMemoryRef", "Conversation thread", 2),
      noWait,
    ],
    { chatPresetRef: "", targetAssetName: "", params: ["0", "", ""] },
    "targetAssetName",
  ),
  descriptor(
    "ChatRead",
    "chatRead",
    "Chat read",
    "chat",
    [
      text("chatPresetRef", "Read target chat preset"),
      parameterNumber("readCount", "Read count", 0),
      parameterText("chatMemoryRef", "Conversation thread", 2),
      noWait,
    ],
    { chatPresetRef: "", params: ["0", "", ""] },
  ),
  descriptor("ChoiceSet", "choiceSet", "Retired choice no-op", "flow", [], {}),
  descriptor(
    "ChoiceShow",
    "choiceShow",
    "Show choices",
    "flow",
    [
      number("advId", "Story ID", { required: true }),
      parameterNumber("choiceIndex", "Choice group", 0, { required: true }),
      field("choices", "Choices", "choice-list", { required: true }),
    ],
    { advId: 0, params: ["0"], choices: [] },
    "choices",
  ),
  descriptor(
    "GoTo",
    "goTo",
    "Go to",
    "flow",
    [parameterText("destination", "Destination label", 0, { required: true })],
    { params: [""] },
    "destination",
  ),
  descriptor(
    "PostEffect",
    "postEffect",
    "Post effect",
    "stage",
    [resource("postEffectRef", "Post effect", "post-effect"), parameterNumber("fadeDuration", "Fade duration", 0)],
    { postEffectRef: "", params: [""] },
    "postEffectRef",
  ),
  descriptor(
    "Frame",
    "frame",
    "Frame",
    "stage",
    [
      resource("frameRef", "Frame", "frame"),
      text("frameName", "Frame instance"),
      parameterNumber("fadeDuration", "Fade duration", 0),
      parameterText("animatorState", "Animation state", 1),
      delay,
      noWait,
    ],
    { frameRef: "", frameName: "", params: ["", ""] },
    "frameRef",
  ),
  descriptor(
    "Timeline",
    "timeline",
    "Timeline",
    "stage",
    [text("targetAssetName", "Timeline asset", { required: true }), noWait],
    { targetAssetName: "" },
    "targetAssetName",
  ),
  descriptor(
    "Look",
    "look",
    "Look",
    "character",
    [
      targetName(),
      parameterNumber("lookX", "Horizontal gaze", 0),
      parameterNumber("lookY", "Vertical gaze", 1),
      parameterSelect("lookMode", "Action", 2, LOOK_MODE_CHOICES),
      duration(),
      delay,
      noWait,
    ],
    { targetName: "", params: ["0", "0", ""], duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "Pedestal",
    "pedestal",
    "Camera pedestal",
    "camera",
    [parameterNumber("verticalOffset", "Vertical offset", 0), easing(), duration(), delay, noWait],
    { params: ["0", "6"], duration: 0.3 },
  ),
  descriptor(
    "Track",
    "track",
    "Camera track",
    "camera",
    [parameterNumber("horizontalOffset", "Horizontal offset", 0), easing(), duration(), noWait],
    { params: ["0", "6"], duration: 0.3 },
  ),
  descriptor(
    "DoF",
    "dof",
    "Depth of field",
    "camera",
    [
      canvasLayers,
      targetName("Character (optional)"),
      position(),
      parameterNumber("blurIntensity", "Blur intensity", 0),
      easing(),
      duration(),
      delay,
      noWait,
    ],
    { canvasLayers: [0], params: ["1", "6"], duration: 0.3 },
  ),
  descriptor(
    "Role",
    "role",
    "Camera roll",
    "camera",
    [parameterNumber("rollAngle", "Roll angle", 0), easing(), duration(), delay, noWait],
    { params: ["0", "6"], duration: 0.3 },
  ),
  descriptor(
    "CameraShake",
    "cameraShake",
    "Camera shake",
    "camera",
    [parameterNumber("fadeDuration", "Fade duration", 0), parameterNumber("strength", "Strength", 1), noWait],
    { params: ["0.3", ""] },
  ),
  descriptor(
    "Voice",
    "voice",
    "Voice",
    "audio",
    [resourceList("voiceRefs", "Character voice", "audio", { audioUsage: "voice" })],
    { voiceRefs: [] },
    "voiceRefs",
  ),
  descriptor(
    "Zoom",
    "zoom",
    "Camera zoom",
    "camera",
    [
      parameterNumber("zoomRatio", "Zoom ratio", 0),
      easing(),
      parameterText("backgroundBlur", "Background blur", 2),
      duration(),
      delay,
      noWait,
    ],
    { params: ["1", "6", "sharp"], duration: 0.3 },
  ),
  descriptor(
    "Effect",
    "effect",
    "ADV effect",
    "stage",
    [
      resource("effectRef", "ADV effect", "effect"),
      targetName("Effect instance"),
      position(),
      canvasLayers,
      parameterSelect("stopMode", "Stop mode", 0, [
        { value: "", label: "Natural" },
        { value: "AtOnce", label: "Immediately" },
      ]),
    ],
    { effectRef: "", targetName: "", positionType: 0, canvasLayers: [], params: [""] },
    "effectRef",
  ),
  descriptor(
    "Alpha",
    "alpha",
    "Layer opacity",
    "transition",
    [canvasLayers, targetName("Character (optional)"), parameterNumber("opacity", "Opacity", 0), duration(), noWait],
    { canvasLayers: [2], params: ["1"], duration: 0.3 },
    "targetName",
  ),
  descriptor("ForceAuto", "forceAuto", "Force auto", "system"),
  descriptor(
    "StageEnv",
    "stageEnv",
    "Stage environment",
    "stage",
    [
      parameterSelect("environmentPart", "Environment component", 0, [
        { value: "All", label: "All" },
        { value: "Light", label: "Lighting" },
        { value: "Effect", label: "Stage effects" },
        { value: "PostEffect", label: "Stage post effects" },
        { value: "FocusPosition", label: "Focus positions" },
      ]),
      parameterNumber("presetIndex", "Preset index", 1),
    ],
    { params: ["All", "0"] },
  ),
  descriptor(
    "RimLight",
    "rimLight",
    "Rim light",
    "character",
    [
      targetName(),
      parameterText("rimColor", "Light color / state", 0),
      parameterNumber("rimStrength", "Shadow intensity", 1),
    ],
    { targetName: "", params: ["", "0"] },
    "targetName",
  ),
  descriptor("CancelDelay", "cancelDelay", "Cancel delay", "timing"),
  descriptor(
    "MoveToUp",
    "moveToUp",
    "Move up",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToDown",
    "moveToDown",
    "Move down",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToForward",
    "moveDepth",
    "Move forward",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToBack",
    "moveDepth",
    "Move back",
    "character",
    [position(), parameterNumber("distance", "Distance", 0), duration(), noWait],
    { positionType: 5, params: ["1"], duration: 0.3 },
  ),
  descriptor(
    "MoveToDirection",
    "moveToDirection",
    "Move direction",
    "character",
    [
      targetName(),
      position(),
      vector3("characterWorldPosition", "World destination"),
      parameterNumber("offsetX", "Horizontal offset", 0),
      parameterNumber("offsetY", "Vertical offset", 1),
      parameterNumber("offsetZ", "Depth offset", 2),
      duration(),
      noWait,
    ],
    { targetName: "", positionType: 5, params: ["0", "0", "0"], duration: 0.3 },
  ),
  descriptor(
    "ChatTyping",
    "chatTyping",
    "Chat typing",
    "chat",
    [localized("text", "Typing text"), noWait],
    { text: "" },
    "text",
  ),
  descriptor(
    "LookTarget",
    "lookTarget",
    "Look target",
    "character",
    [
      targetName("Source character"),
      position("positionType", "Target character position"),
      parameterSelect("lookMode", "Action", 2, LOOK_MODE_CHOICES),
      duration(),
      delay,
      noWait,
    ],
    { targetName: "", positionType: 5, params: ["", "", ""], duration: 0.3 },
    "targetName",
  ),
  descriptor(
    "PanV2",
    "fieldPan",
    "Field pan",
    "camera",
    [
      parameterNumber("yaw", "Horizontal rotation", 0),
      easing(),
      parameterNumber("focusSlideRate", "Focus slide rate", 2),
      duration(),
      delay,
      noWait,
    ],
    { params: ["0", "6", "0.5"], duration: 0.3 },
  ),
  descriptor("CommandGroup", "commandGroup", "Command group", "flow", [], {
    commandGroup: {
      waitForPrevious: false,
      cancelOnManualAdvance: false,
      durationSeconds: 0,
      actions: [],
    },
  }),
]);

export const COMMAND_DESCRIPTOR_BY_CODE: ReadonlyMap<number, CommandDescriptor> = new Map(
  COMMAND_DESCRIPTORS.map((item) => [item.code, item]),
);
export const COMMAND_DESCRIPTOR_BY_NAME: ReadonlyMap<AdvCommandName, CommandDescriptor> = new Map(
  COMMAND_DESCRIPTORS.map((item) => [item.name, item]),
);

export const commandDescriptor = (code: number | null | undefined): CommandDescriptor | undefined =>
  code == null ? undefined : COMMAND_DESCRIPTOR_BY_CODE.get(code);

/** Exact string for canonical numeric editor controls, including JSON's observable `-0`. */
export const storyNumberInputValue = (value: JsonValue | undefined): string =>
  typeof value !== "number" ? "" : Object.is(value, -0) ? "-0" : String(value);

/** Parse one numeric editor control without synthesizing a value for an empty field. */
export const storyNumberFromInput = (source: string): number | undefined => {
  if (!source.trim()) return undefined;
  const value = Number(source);
  return Number.isFinite(value) ? value : undefined;
};

const STORY_TARGET_SEPARATORS = Object.freeze(["・", ",", "，", "、"] as const);

/** Resolve the user-facing comma list and the game's native middle-dot list. */
export const storyTargetNames = (value: unknown): string[] => {
  let source = String(value ?? "");
  for (const separator of STORY_TARGET_SEPARATORS) source = source.replaceAll(separator, "\u0000");
  return source
    .split("\u0000")
    .map((target) => target.trim())
    .filter(Boolean);
};

/** Readable, keyboard-friendly representation used by visual controls. */
export const storyTargetNameForEditor = (value: unknown): string => storyTargetNames(value).join(", ");

/** Canonical representation expected by the original ADV Episode format. */
export const storyTargetNameFromEditor = (value: unknown): string => storyTargetNames(value).join("・");

const STORY_LOCALE_KEYS = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

/**
 * Resolve the value shown by a localized authoring control. Empty locale slots
 * from imported archives still fall back to another translation, while a
 * scalar empty string remains an explicit authored clear operation.
 */
export const storyLocalizedTextForEditor = (value: JsonValue | undefined, localeIndex: number): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const preferred = value[localeIndex];
    if (typeof preferred === "string" && preferred) return preferred;
    const japanese = value[0];
    if (typeof japanese === "string" && japanese) return japanese;
    const fallback = value.find((item) => typeof item === "string" && item);
    return typeof fallback === "string" ? fallback : "";
  }
  if (value && typeof value === "object") {
    const localeKey = STORY_LOCALE_KEYS[localeIndex] || String(localeIndex);
    const preferred = value[localeKey];
    if (typeof preferred === "string" && preferred) return preferred;
    const japanese = value.ja;
    if (typeof japanese === "string" && japanese) return japanese;
    const fallback = Object.values(value).find((item) => typeof item === "string" && item);
    return typeof fallback === "string" ? fallback : "";
  }
  return "";
};

/**
 * Replace one localized editor value. Clearing the control intentionally
 * collapses the value to a scalar empty string so locale fallback cannot
 * restore an older translation and the Talk command can clear its window.
 */
export const replaceStoryLocalizedTextForEditor = (
  original: JsonValue | undefined,
  localeIndex: number,
  text: string,
): JsonValue => {
  if (text === "") return "";
  if (Array.isArray(original)) {
    const next = [...original];
    while (next.length < STORY_LOCALE_KEYS.length) next.push("");
    next[localeIndex] = text;
    return next;
  }
  if (original && typeof original === "object") {
    const localeKey = STORY_LOCALE_KEYS[localeIndex] || String(localeIndex);
    return { ...original, [localeKey]: text };
  }
  if (localeIndex === 0) return text;
  const next: JsonValue[] = [typeof original === "string" ? original : "", "", "", "", ""];
  next[localeIndex] = text;
  return next;
};

const hasFieldValue = (value: JsonValue | undefined): boolean => value !== undefined && value !== null && value !== "";
const descriptorSourceKey = (field: CommandFieldDescriptor): string => field.sourceKey || field.key;

/** Read the concrete value represented by one semantic control. */
export const storyCommandFieldValue = (
  commandOrFields: StoryProjectCommand | JsonObject,
  field: CommandFieldDescriptor,
): JsonValue | undefined => {
  const candidate = commandOrFields as Partial<StoryProjectCommand>;
  const fields: JsonObject =
    typeof candidate.id === "string" &&
    candidate.fields !== null &&
    typeof candidate.fields === "object" &&
    !Array.isArray(candidate.fields)
      ? candidate.fields
      : (commandOrFields as JsonObject);
  const sourceKey = descriptorSourceKey(field);
  if (field.parameterIndex === undefined) {
    return fields[sourceKey];
  }
  const params = Array.isArray(fields[sourceKey]) ? fields[sourceKey] : [];
  return params[field.parameterIndex];
};

const encodedFieldValue = (field: CommandFieldDescriptor, value: JsonValue | undefined): JsonValue | undefined => {
  if (value === undefined) return undefined;
  if (field.parameterEncoding === "string" && (typeof value === "number" || typeof value === "boolean")) {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  return cloneStoryValue(value);
};

/** Return a new canonical field object after editing one semantic control. */
export const replaceStoryCommandFieldValue = (
  fields: JsonObject,
  field: CommandFieldDescriptor,
  value: JsonValue | undefined,
): JsonObject => {
  const next = cloneStoryValue(fields);
  const sourceKey = descriptorSourceKey(field);
  if (field.parameterIndex === undefined) {
    if (value === undefined) delete next[sourceKey];
    else next[sourceKey] = cloneStoryValue(value);
    return next;
  }

  const currentParams = Array.isArray(next[sourceKey]) ? [...next[sourceKey]] : [];
  while (currentParams.length <= field.parameterIndex) currentParams.push("");
  currentParams[field.parameterIndex] = encodedFieldValue(field, value) ?? "";
  while (currentParams.length && currentParams.at(-1) === "") currentParams.pop();
  if (currentParams.length) next[sourceKey] = currentParams;
  else delete next[sourceKey];
  return next;
};

/**
 * Only registered native semantics are authorable. Unknown and codec-only data
 * remains round-trippable in private metadata but is never dumped into the UI.
 */
export const commandFieldDescriptors = (command: StoryProjectCommand): readonly CommandFieldDescriptor[] => {
  const registered = commandDescriptor(command.command)?.fields || [];
  const visible = registered.filter(
    (item) => !item.presentOnly || Object.hasOwn(command.fields, descriptorSourceKey(item)),
  );
  if (hasFieldValue(command.fields.key) && !visible.some((item) => descriptorSourceKey(item) === "key")) {
    return [...visible, sceneLabel];
  }
  return visible;
};

export const createStoryCommand = (
  command: number | AdvCommandName = ADV_COMMAND.Talk,
  fields: JsonObject = {},
): StoryProjectCommand => {
  const code = typeof command === "number" ? command : ADV_COMMAND[command];
  const definition = commandDescriptor(code);
  return {
    id: createStoryId("command"),
    command: code,
    fields: { ...(definition ? cloneStoryValue(definition.defaultFields) : {}), ...cloneStoryValue(fields) },
    extensions: {},
  };
};

const displayValue = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const localizedValue = value.find((item) => typeof item === "string" && item.trim());
    if (typeof localizedValue === "string") return localizedValue;
    return value.length ? JSON.stringify(value) : "";
  }
  return value ? JSON.stringify(value) : "";
};

export const summarizeStoryCommand = (command: StoryProjectCommand): string => {
  const definition = commandDescriptor(command.command);
  if (!definition) return command.source?.command || `Command ${command.command ?? "?"}`;
  const orderedFields = definition.primaryField
    ? [
        ...definition.fields.filter((field) => field.key === definition.primaryField),
        ...definition.fields.filter((field) => field.key !== definition.primaryField),
      ]
    : definition.fields;
  for (const item of orderedFields) {
    const value = displayValue(storyCommandFieldValue(command, item));
    if (value) return `${definition.label} · ${value}`;
  }
  return definition.label;
};
