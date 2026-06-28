/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * WebGAL command semantics and portions of the text-format behavior are
 * adapted from OpenWebGAL/WebGAL at commit
 * e7f0abeb855b5b442460743bdaa9778ca751b43f.
 * See packages/story-editor/NOTICE.webgal.md for complete provenance.
 */
import { ADV_COMMAND } from "../commands.js";
import {
  storyDiagnostic,
  type StoryConversionFidelity,
  type StoryDiagnostic,
} from "../diagnostics.js";
import {
  STORY_PROJECT_VERSION,
  cloneStoryValue,
  importedStoryId,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
  type StoryScene,
  type StorySourceLocation,
} from "../model.js";
import { assertValidStoryProject } from "../validation.js";
import { stringifyStoryJson, type StoryImportResult } from "./shared.js";

export interface WebGalArgument {
  name: string;
  value: string | true;
}

export interface WebGalStatement {
  line: number;
  raw: string;
  kind: "comment" | "dialogue" | "command";
  name: string;
  content: string;
  arguments: WebGalArgument[];
  terminated: boolean;
  trailing: string;
}

export interface WebGalParseResult {
  statements: WebGalStatement[];
  diagnostics: StoryDiagnostic[];
}

const WEBGAL_COMMANDS = new Set([
  "applystyle",
  "bgm",
  "callsteam",
  "callscene",
  "changebg",
  "changefigure",
  "changescene",
  "choose",
  "chooselabel",
  "end",
  "filmmode",
  "getuserinput",
  "if",
  "intro",
  "jumplabel",
  "label",
  "minavatar",
  "pixiinit",
  "pixiperform",
  "playeffect",
  "playvideo",
  "say",
  "setanimation",
  "setcomplexanimation",
  "setfilter",
  "settextbox",
  "settempanimation",
  "settransition",
  "settransform",
  "setvar",
  "showvars",
  "spine",
  "unlockbgm",
  "unlockcg",
  "wait",
]);

const findUnescaped = (value: string, wanted: string): number => {
  let escaped = false;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] || "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === wanted) return index;
  }
  return -1;
};

const unescapeWebGal = (value: string): string => value.replace(/\\([;|])/g, "$1").replace(/\\\\/g, "\\");

const splitBodyAndArguments = (value: string): [string, string] => {
  let escaped = false;
  let quote = "";
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index] || "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character) && value[index + 1] === "-") return [value.slice(0, index), value.slice(index + 1)];
  }
  return [value, ""];
};

const argumentTokens = (value: string): string[] => {
  const tokens: string[] = [];
  let token = "";
  let escaped = false;
  let quote = "";
  let depth = 0;
  const finish = (): void => {
    if (token) tokens.push(token);
    token = "";
  };
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      token += character;
      escaped = true;
      continue;
    }
    if (quote) {
      token += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      token += character;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) finish();
    else token += character;
  }
  finish();
  return tokens;
};

const stripQuotes = (value: string): string => {
  const first = value[0];
  if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
  return value;
};

const parseArguments = (value: string): WebGalArgument[] => {
  const parsed: WebGalArgument[] = [];
  for (const token of argumentTokens(value)) {
    if (!token.startsWith("-") || token.length === 1) continue;
    const separator = token.indexOf("=");
    if (separator < 0) parsed.push({ name: token.slice(1), value: true });
    else parsed.push({ name: token.slice(1, separator), value: stripQuotes(token.slice(separator + 1)) });
  }
  return parsed;
};

/** Haneoka's compact parser for WebGAL's one-statement-per-line syntax. */
export const parseWebGalScene = (input: string | Uint8Array): WebGalParseResult => {
  const source = typeof input === "string" ? input : new TextDecoder().decode(input);
  const statements: WebGalStatement[] = [];
  const diagnostics: StoryDiagnostic[] = [];
  for (const [lineIndex, physicalLine] of source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    const line = lineIndex + 1;
    const trimmed = physicalLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(";")) {
      statements.push({
        line,
        raw: trimmed,
        kind: "comment",
        name: "comment",
        content: trimmed.slice(1).trim(),
        arguments: [],
        terminated: true,
        trailing: "",
      });
      continue;
    }
    const terminator = findUnescaped(trimmed, ";");
    const terminated = terminator >= 0;
    const rawBody = (terminated ? trimmed.slice(0, terminator) : trimmed).trim();
    if (!terminated) {
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "webgal.parse.missingTerminator",
          `line:${line}`,
          "WebGAL statement is missing its terminating semicolon",
          "approximate",
          line,
        ),
      );
    }
    const [body, rawArguments] = splitBodyAndArguments(rawBody);
    const colon = findUnescaped(body, ":");
    const prefix = colon < 0 ? "" : unescapeWebGal(body.slice(0, colon).trim());
    const colonlessCommand = colon < 0 ? unescapeWebGal(body.trim()).toLowerCase() : "";
    const normalized = colon < 0 ? colonlessCommand : prefix.toLowerCase();
    const kind = WEBGAL_COMMANDS.has(normalized) ? "command" : "dialogue";
    const content = unescapeWebGal(
      (kind === "command" && colon < 0 ? "" : colon < 0 ? body : body.slice(colon + 1)).trim(),
    );
    statements.push({
      line,
      raw: trimmed,
      kind,
      name: kind === "dialogue" ? prefix : normalized,
      content,
      arguments: parseArguments(rawArguments),
      terminated,
      trailing: terminated ? trimmed.slice(terminator + 1).trim() : "",
    });
  }
  return { statements, diagnostics };
};

export interface ImportWebGalOptions {
  title?: string;
  sceneId?: string;
  sceneName?: string;
  assetServer?: string;
  localeIndex?: number;
}

export type WebGalLosslessMetadataScope = false | "scene" | "project";

export interface WebGalLosslessBlock {
  ids: string[];
  projection: string;
}

/** Hidden editor state stored beside a plain WebGAL textarea value. */
export interface WebGalSceneEditContext {
  version: 1;
  sceneId: string;
  baselineText: string;
  localeIndex?: number;
  scene: StoryScene;
  blocks: WebGalLosslessBlock[];
}

export interface WebGalSceneDraft {
  text: string;
  context: WebGalSceneEditContext;
}

interface WebGalLosslessEnvelope {
  version: 1;
  scope: "scene" | "project";
  sceneId: string;
  localeIndex?: number;
  scene?: StoryProject["scenes"][number];
  project?: StoryProject;
  blocks: WebGalLosslessBlock[];
}

const LOSSLESS_HEADER = "@haneoka-lossless";
const LOSSLESS_COMMAND = "@haneoka-command";
const LOSSLESS_CHUNK_SIZE = 1800;

const encodeBase64Url = (value: JsonValue): string => {
  const bytes = new TextEncoder().encode(stringifyStoryJson(value, false));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const decodeBase64Url = (value: string): JsonValue => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
};

const metadataLines = (envelope: WebGalLosslessEnvelope): string[] => {
  const encoded = encodeBase64Url(envelope as unknown as JsonValue);
  const chunks = Array.from({ length: Math.ceil(encoded.length / LOSSLESS_CHUNK_SIZE) }, (_, index) =>
    encoded.slice(index * LOSSLESS_CHUNK_SIZE, (index + 1) * LOSSLESS_CHUNK_SIZE),
  );
  return chunks.map((chunk, index) => `; ${LOSSLESS_HEADER} ${index + 1}/${chunks.length} ${chunk}`);
};

const commandMetadataLine = (ids: readonly string[]): string => `; ${LOSSLESS_COMMAND} ${encodeBase64Url([...ids])}`;

const argumentsObject = (args: readonly WebGalArgument[]): JsonObject =>
  Object.fromEntries(args.map((argument) => [argument.name, argument.value])) as JsonObject;
const argument = (statement: WebGalStatement, name: string): string | true | undefined =>
  statement.arguments.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
const numericArgument = (statement: WebGalStatement, name: string): number | undefined => {
  const value = argument(statement, name);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const normalizedVolume = (statement: WebGalStatement): number | undefined => {
  const value = numericArgument(statement, "volume");
  return value === undefined ? undefined : Math.max(0, Math.min(100, value)) / 100;
};
const durationSecondsArgument = (statement: WebGalStatement): number | undefined => {
  const value = numericArgument(statement, "duration");
  return value === undefined ? undefined : Math.max(0, value) / 1000;
};

const sourceFor = (statement: WebGalStatement): StorySourceLocation => ({
  format: "webgal",
  raw: statement.raw,
  line: statement.line,
  command: statement.kind === "dialogue" ? "dialogue" : statement.name,
  arguments: {
    ...argumentsObject(statement.arguments),
    ...(statement.trailing ? { __trailing: statement.trailing } : {}),
  },
});

const commandFrom = (
  statement: WebGalStatement,
  suffix: string | number,
  opcode: number | null,
  fields: JsonObject,
): StoryProjectCommand => ({
  id: importedStoryId("webgal", statement.line, suffix),
  command: opcode,
  fields,
  source: sourceFor(statement),
  extensions: { webgalOriginalFields: cloneStoryValue(fields) },
});

const splitChoices = (content: string): Array<{ text: string; target: string }> =>
  content.split(/(?<!\\)\|/).flatMap((part) => {
    const separator = part.lastIndexOf(":");
    if (separator < 0) return [];
    return [{ text: unescapeWebGal(part.slice(0, separator).trim()), target: part.slice(separator + 1).trim() }];
  });

const positionFromArguments = (statement: WebGalStatement): number => {
  if (argument(statement, "left") !== undefined) return 1;
  if (argument(statement, "right") !== undefined) return 9;
  return 5;
};

const defaultFigureTarget = (statement: WebGalStatement): string => {
  const id = argument(statement, "id");
  if (typeof id === "string" && id) return id;
  if (argument(statement, "left") !== undefined) return "fig-left";
  if (argument(statement, "right") !== undefined) return "fig-right";
  return "fig-center";
};

const mapStatement = (
  statement: WebGalStatement,
): { commands: StoryProjectCommand[]; fidelity: StoryConversionFidelity; message: string } => {
  if (statement.kind === "dialogue") {
    const extraArgs = statement.arguments.filter((item) => item.name.toLowerCase() !== "next");
    const fidelity: StoryConversionFidelity = extraArgs.length ? "approximate" : "exact";
    return {
      commands: [
        commandFrom(
          statement,
          0,
          ADV_COMMAND.Talk,
          {
            targetName: statement.name,
            text: statement.content,
            ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
          },
        ),
      ],
      fidelity,
      message: extraArgs.length
        ? "Dialogue imported; WebGAL-only dialogue arguments remain in source metadata"
        : "Dialogue maps to Talk",
    };
  }
  switch (statement.name) {
    case "say": {
      const speaker = argument(statement, "speaker");
      const ignored = statement.arguments.filter((item) => !["speaker", "next"].includes(item.name.toLowerCase()));
      const fidelity: StoryConversionFidelity = ignored.length ? "approximate" : "exact";
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Talk,
            {
              targetName: typeof speaker === "string" ? speaker : "",
              text: statement.content,
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity,
        message: ignored.length
          ? "Explicit say imported; WebGAL-only dialogue arguments remain in source metadata"
          : "Explicit say maps to Talk",
      };
    }
    case "bgm": {
      const enter = numericArgument(statement, "enter");
      const volume = normalizedVolume(statement);
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Bgm,
            {
              bgmRef: statement.content,
              ...(enter === undefined ? {} : { params: [Math.max(0, enter) / 1000] }),
              ...(volume === undefined ? {} : { volume }),
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "BGM maps to Bgm; bind the filename to an available audio resource",
      };
    }
    case "playeffect": {
      const id = argument(statement, "id");
      const volume = normalizedVolume(statement);
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Se,
            {
              seRef: statement.content,
              ...(typeof id === "string" && id ? { targetName: id } : {}),
              ...(volume === undefined ? {} : { volume }),
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "Effect audio maps to Se; bind the filename to an available sound resource",
      };
    }
    case "playvideo":
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Movie,
            {
              videoRef: statement.content,
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "Video maps to Movie; bind the filename to an available video resource",
      };
    case "wait": {
      const milliseconds = Number(statement.content);
      const valid = Number.isFinite(milliseconds) && milliseconds >= 0;
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Delay,
            { duration: valid ? milliseconds / 1000 : 0 },
          ),
        ],
        fidelity: valid ? "exact" : "approximate",
        message: valid
          ? "WebGAL milliseconds map to Haneoka seconds"
          : "Invalid wait duration was imported as zero seconds",
      };
    }
    case "label":
      return {
        commands: [commandFrom(statement, 0, ADV_COMMAND.Delay, { duration: 0, key: statement.content })],
        fidelity: "approximate",
        message: "Label is represented by a zero-duration keyed command",
      };
    case "jumplabel":
      return {
        commands: [commandFrom(statement, 0, ADV_COMMAND.GoTo, { params: [statement.content] })],
        fidelity: "exact",
        message: "Label jump maps to GoTo",
      };
    case "choose": {
      const choices = splitChoices(statement.content);
      if (!choices.length || choices.some((choice) => !choice.text.trim() || !choice.target)) {
        return {
          commands: [commandFrom(statement, 0, null, {})],
          fidelity: "unsupported",
          message: "Choice syntax requires non-empty text:label pairs",
        };
      }
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.ChoiceShow,
            {
              advId: 0,
              params: ["0"],
              choices: choices.map((choice, index) => ({
                choiceValue: index,
                text: choice.text,
                nextKey: choice.target,
              })),
            },
          ),
        ],
        fidelity: "exact",
        message: "WebGAL choice maps to one structured ChoiceShow group",
      };
    }
    case "changebg": {
      const duration = durationSecondsArgument(statement);
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Stage,
            {
              backgroundRef: statement.content,
              ...(duration === undefined ? {} : { duration }),
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "Background command imported; bind the filename to a Haneoka/R2 background resource",
      };
    }
    case "changefigure": {
      const id = argument(statement, "id");
      const motion = argument(statement, "motion");
      const expression = argument(statement, "expression");
      const duration = durationSecondsArgument(statement);
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Character,
            {
              targetName: typeof id === "string" && id ? id : defaultFigureTarget(statement),
              live2dKey: statement.content,
              positionType: positionFromArguments(statement),
              ...(typeof motion === "string" && motion ? { motionName: motion } : {}),
              ...(typeof expression === "string" && expression ? { expressionName: expression } : {}),
              ...(duration === undefined ? {} : { duration }),
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "Figure command imported; bind the filename to a Live2D resource",
      };
    }
    case "intro":
      return {
        commands: [
          commandFrom(
            statement,
            0,
            ADV_COMMAND.Subtitles,
            {
              text: statement.content,
              ...(argument(statement, "next") === undefined ? {} : { noWait: true }),
            },
          ),
        ],
        fidelity: "approximate",
        message: "Intro maps to Haneoka subtitles without WebGAL typography",
      };
    default:
      return {
        commands: [commandFrom(statement, 0, null, {})],
        fidelity: "unsupported",
        message: `WebGAL '${statement.name}' has no Haneoka 66-command equivalent`,
      };
  }
};

const isGeneratedHaneokaProjectionComment = (raw: string): boolean =>
  /^;\s*(?:Unsupported Haneoka command\b|Haneoka Choice(?:Set|Show)\b)/i.test(raw.trim());

const importWebGalPlain = (input: string | Uint8Array, options: ImportWebGalOptions = {}): StoryImportResult => {
  const parsed = parseWebGalScene(input);
  const diagnostics = [...parsed.diagnostics];
  const commands: StoryProjectCommand[] = [];
  const comments: JsonValue[] = [];
  for (const statement of parsed.statements) {
    if (statement.kind === "comment") {
      if (!isGeneratedHaneokaProjectionComment(statement.raw)) {
        comments.push({ line: statement.line, raw: statement.raw });
      }
      continue;
    }
    const mapped = mapStatement(statement);
    const path = `line:${statement.line}`;
    diagnostics.push(
      storyDiagnostic(
        mapped.fidelity === "unsupported" ? "warning" : "info",
        `webgal.import.${mapped.fidelity}`,
        path,
        mapped.message,
        mapped.fidelity,
        statement.line,
      ),
    );
    commands.push(...mapped.commands);
  }
  const sceneId = options.sceneId ?? "scene-main";
  const project: StoryProject = {
    version: STORY_PROJECT_VERSION,
    meta: {
      title: options.title ?? "",
      ...(options.assetServer === undefined ? {} : { assetServer: options.assetServer }),
    },
    entrySceneId: sceneId,
    scenes: [
      {
        id: sceneId,
        name: options.sceneName ?? options.title ?? "Main",
        commands,
        extensions: { webgal: { comments } },
      },
    ],
    assets: {},
    runtime: {},
    storyFields: {},
    extensions: { source: { format: "webgal" } },
  };
  assertValidStoryProject(project);
  return { format: "webgal", project, diagnostics };
};

const sameJson = (left: JsonValue | undefined, right: JsonValue | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : stringifyStoryJson(left, false) === stringifyStoryJson(right, false);
const originalWebGalFields = (command: StoryProjectCommand): JsonObject | undefined => {
  const value = command.extensions.webgalOriginalFields;
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
};
const escapeContent = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/[\r\n]+/g, " ");
const localizedText = (value: JsonValue | undefined, localeIndex: number): { text: string; collapsed: boolean } => {
  if (typeof value === "string") return { text: value, collapsed: false };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const localeKey = localeObjectKeys[localeIndex] || String(localeIndex);
    const preferred = value[localeKey];
    const localized = Object.values(value).filter((item): item is string => typeof item === "string" && Boolean(item));
    return {
      text: typeof preferred === "string" ? preferred : localized[0] || "",
      collapsed: localized.length > 1,
    };
  }
  if (!Array.isArray(value)) return { text: value == null ? "" : String(value), collapsed: false };
  const preferred = value[localeIndex];
  const text = typeof preferred === "string" ? preferred : value.find((item) => typeof item === "string" && item) || "";
  return {
    text: typeof text === "string" ? text : String(text),
    collapsed: value.filter((item) => typeof item === "string" && item).length > 1,
  };
};
const fieldText = (fields: JsonObject, key: string): string => {
  const value = fields[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const firstFieldText = (fields: JsonObject, key: string): string => {
  const value = fields[key];
  if (!Array.isArray(value)) return fieldText(fields, key);
  const first = value.find((item) => typeof item === "string" || typeof item === "number");
  return first === undefined ? "" : String(first);
};
const paramsOf = (fields: JsonObject): JsonValue[] => (Array.isArray(fields.params) ? fields.params : []);
const choiceDefinitionsOf = (fields: JsonObject): JsonObject[] =>
  Array.isArray(fields.choices)
    ? fields.choices.filter(
        (choice): choice is JsonObject => Boolean(choice) && typeof choice === "object" && !Array.isArray(choice),
      )
    : [];
const escapeChoicePart = (value: string): string => escapeContent(value).replace(/\|/g, "\\|");
const finiteNumber = (value: JsonValue | undefined, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const durationMilliseconds = (fields: JsonObject, fallbackSeconds = 0): number =>
  Math.max(
    0,
    finiteNumber(typeof fields.duration === "number" ? fields.duration : fields.delaySeconds, fallbackSeconds) * 1000,
  );
const positionTarget = (fields: JsonObject, preferAuthoredName = true): string => {
  const authored = fieldText(fields, "targetName").trim();
  if (preferAuthoredName && authored) return authored;
  const position = finiteNumber(fields.positionType, 5);
  if (position <= 3) return "fig-left";
  if (position >= 7) return "fig-right";
  return "fig-center";
};
const visualTarget = (fields: JsonObject, fallback = "stage-main"): string => {
  const authored = fieldText(fields, "targetName").trim();
  if (authored) return authored;
  return finiteNumber(fields.positionType, 0) ? positionTarget(fields, false) : fallback;
};
const positionArgument = (fields: JsonObject): string => {
  const position = finiteNumber(fields.positionType, 5);
  if (position <= 3) return " -left";
  if (position >= 7) return " -right";
  return "";
};
const targetIdArgument = (fields: JsonObject): string => {
  const target = fieldText(fields, "targetName").trim();
  return target && !["fig-left", "fig-center", "fig-right"].includes(target) ? ` -id=${escapeContent(target)}` : "";
};
const nextArgument = (fields: JsonObject): string => (fields.noWait === true ? " -next" : "");
const changeFigureStatement = (asset: string, fields: JsonObject, extraArguments: readonly string[] = []): string => {
  const duration = durationMilliseconds(fields);
  return `changeFigure:${escapeContent(asset || "none")}${positionArgument(fields)}${targetIdArgument(fields)}${
    duration ? ` -duration=${duration}` : ""
  }${extraArguments.map((item) => ` -${item}`).join("")}${nextArgument(fields)};`;
};
const transformJson = (frame: JsonObject): string => escapeContent(JSON.stringify(frame));
const setTransformStatement = (
  frame: JsonObject,
  target: string,
  fields: JsonObject,
  options: { duration?: number; next?: boolean } = {},
): string => {
  const duration = options.duration ?? durationMilliseconds(fields);
  const next = options.next ?? fields.noWait === true;
  return `setTransform:${transformJson(frame)} -target=${escapeContent(target)} -duration=${duration}${next ? " -next" : ""};`;
};
const setTempAnimationStatement = (
  frames: JsonObject[],
  target: string,
  fields: JsonObject,
  options: { next?: boolean } = {},
): string =>
  `setTempAnimation:${escapeContent(JSON.stringify(frames))} -target=${escapeContent(target)}${
    (options.next ?? fields.noWait === true) ? " -next" : ""
  };`;
const movementTransform = (fields: JsonObject, deltaX: number, deltaY: number): string => {
  const frame: JsonObject = {};
  if (deltaX || deltaY) frame.position = { x: deltaX, y: -deltaY };
  return setTransformStatement(frame, positionTarget(fields), fields);
};
const webGalComments = (project: StoryProject, sceneId: string): Array<{ line: number; raw: string }> => {
  const scene = project.scenes.find((item) => item.id === sceneId);
  const sceneWebgal = scene?.extensions.webgal;
  const webgal =
    sceneWebgal && typeof sceneWebgal === "object" && !Array.isArray(sceneWebgal)
      ? sceneWebgal
      : project.extensions.webgal;
  if (!webgal || typeof webgal !== "object" || Array.isArray(webgal)) return [];
  const comments = webgal.comments;
  if (!Array.isArray(comments)) return [];
  return comments
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return typeof value.line === "number" && typeof value.raw === "string"
        ? [{ line: value.line, raw: value.raw }]
        : [];
    })
    .sort((left, right) => left.line - right.line);
};
const appendOriginalTrailingComment = (output: string, command: StoryProjectCommand): string => {
  const trailing = command.source?.arguments?.__trailing;
  return typeof trailing === "string" && trailing ? `${output} ${trailing}` : output;
};

interface RawWebGalArgumentToken extends WebGalArgument {
  raw: string;
}

const rawArgumentTokens = (raw: string | undefined): RawWebGalArgumentToken[] => {
  if (!raw) return [];
  const trimmed = raw.trim();
  const terminator = findUnescaped(trimmed, ";");
  const rawBody = (terminator >= 0 ? trimmed.slice(0, terminator) : trimmed).trim();
  const [, rawArguments] = splitBodyAndArguments(rawBody);
  return argumentTokens(rawArguments).flatMap((token) => {
    const parsed = parseArguments(token)[0];
    return parsed ? [{ ...parsed, raw: token }] : [];
  });
};

const argumentFieldValue = (
  command: number | null,
  name: string,
  fields: JsonObject,
): { known: boolean; value: JsonValue | undefined } => {
  const normalized = name.toLowerCase();
  if (normalized === "next") return { known: true, value: fields.noWait === true };
  if (normalized === "speaker") return { known: true, value: fields.targetName };
  if (normalized === "enter" && command === ADV_COMMAND.Bgm) return { known: true, value: paramsOf(fields)[0] };
  if (normalized === "volume") {
    if (command === ADV_COMMAND.Bgm || command === ADV_COMMAND.Se) return { known: true, value: fields.volume };
    if (command === ADV_COMMAND.SoundVolume) return { known: true, value: paramsOf(fields)[1] };
  }
  if (normalized === "id" && command === ADV_COMMAND.Se) return { known: true, value: fields.targetName };
  if (normalized === "id") return { known: true, value: fields.targetName };
  if (normalized === "duration") return { known: true, value: fields.duration };
  if (normalized === "motion") return { known: true, value: fields.motionName };
  if (normalized === "expression") return { known: true, value: fields.expressionName };
  if (normalized === "left") return { known: true, value: finiteNumber(fields.positionType, 5) <= 3 };
  if (normalized === "right") return { known: true, value: finiteNumber(fields.positionType, 5) >= 7 };
  return { known: false, value: undefined };
};

const mergeOriginalWebGalArguments = (output: string, command: StoryProjectCommand): string => {
  if (command.source?.format !== "webgal") return output;
  const originalTokens = rawArgumentTokens(command.source.raw);
  if (!originalTokens.length) return output;
  const originalFields = originalWebGalFields(command);
  const lines = output.split("\n");
  let lineIndex = lines.length - 1;
  while (lineIndex >= 0 && (!lines[lineIndex]?.trim() || lines[lineIndex]!.trimStart().startsWith(";"))) lineIndex -= 1;
  if (lineIndex < 0) return output;
  const line = lines[lineIndex]!;
  const terminator = findUnescaped(line, ";");
  if (terminator < 0) return output;
  const rawBody = line.slice(0, terminator).trim();
  const [body, canonicalArguments] = splitBodyAndArguments(rawBody);
  const canonicalTokens = rawArgumentTokens(`${body}${canonicalArguments ? ` ${canonicalArguments}` : ""};`);
  const canonicalByName = new Map<string, RawWebGalArgumentToken[]>();
  for (const token of canonicalTokens) {
    const name = token.name.toLowerCase();
    canonicalByName.set(name, [...(canonicalByName.get(name) || []), token]);
  }
  const consumed = consumedArgumentsForCommand(command.command);
  const shouldKeepOriginal = (name: string): boolean => {
    const normalized = name.toLowerCase();
    if (!consumed.has(normalized)) return true;
    if (!originalFields) return false;
    const before = argumentFieldValue(command.command, normalized, originalFields);
    const after = argumentFieldValue(command.command, normalized, command.fields);
    return before.known && after.known && sameJson(before.value, after.value);
  };
  const mergedTokens: string[] = [];
  const handledNames = new Set<string>();
  for (const token of originalTokens) {
    const name = token.name.toLowerCase();
    if (handledNames.has(name)) {
      if (shouldKeepOriginal(name)) mergedTokens.push(token.raw);
      continue;
    }
    handledNames.add(name);
    if (shouldKeepOriginal(name)) {
      mergedTokens.push(token.raw);
    } else {
      mergedTokens.push(...(canonicalByName.get(name) || []).map((item) => item.raw));
    }
  }
  for (const token of canonicalTokens) {
    const name = token.name.toLowerCase();
    if (handledNames.has(name)) continue;
    handledNames.add(name);
    mergedTokens.push(...(canonicalByName.get(name) || []).map((item) => item.raw));
  }
  lines[lineIndex] = `${body}${mergedTokens.length ? ` ${mergedTokens.join(" ")}` : ""};${line.slice(terminator + 1)}`;
  return lines.join("\n");
};

const sameOriginalWebGalStatement = (
  left: StoryProjectCommand | undefined,
  right: StoryProjectCommand | undefined,
): boolean => {
  const leftSource = left?.source;
  const rightSource = right?.source;
  return (
    leftSource?.format === "webgal" &&
    rightSource?.format === "webgal" &&
    typeof leftSource.line === "number" &&
    leftSource.line === rightSource.line &&
    leftSource.command === rightSource.command &&
    leftSource.raw === rightSource.raw
  );
};

export interface SerializeWebGalOptions {
  sceneId?: string;
  localeIndex?: number;
  lineEnding?: "\n" | "\r\n";
  preserveUnchangedSource?: boolean;
  /**
   * Embed a Haneoka snapshot in ordinary WebGAL comments. `scene` is intended
   * for the editor projection; `project` makes an exported file independently
   * round-trip the complete project. The default remains plain WebGAL.
   */
  losslessMetadata?: WebGalLosslessMetadataScope;
}

export interface SerializeWebGalResult {
  text: string;
  diagnostics: StoryDiagnostic[];
}

/** Export what WebGAL can carry and emit explicit comments for everything else. */
export const serializeWebGal = (project: StoryProject, options: SerializeWebGalOptions = {}): SerializeWebGalResult => {
  assertValidStoryProject(project);
  const sceneId = options.sceneId ?? project.entrySceneId;
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new RangeError(`Story scene '${sceneId}' does not exist`);
  const diagnostics: StoryDiagnostic[] = [];
  const lines: string[] = [];
  const losslessBlocks: WebGalLosslessBlock[] = [];
  const localeIndex = options.localeIndex ?? 0;
  const preserveSource = options.preserveUnchangedSource !== false;
  const losslessScope = options.losslessMetadata || false;
  const comments = webGalComments(project, sceneId);
  const characterAssetByTarget = new Map<string, string>();
  const characterPositionByTarget = new Map<string, number>();
  const activePixiEffects = new Map<string, string>();
  let commentIndex = 0;
  const emitCommentsBefore = (line: number): void => {
    while (comments[commentIndex] && comments[commentIndex]!.line < line) {
      lines.push(comments[commentIndex]!.raw);
      commentIndex += 1;
    }
  };
  for (let index = 0; index < scene.commands.length; index += 1) {
    const sourceIndex = index;
    const command = scene.commands[index];
    if (!command) continue;
    emitCommentsBefore(command.source?.line ?? Number.POSITIVE_INFINITY);
    const path = `$.scenes[${project.scenes.indexOf(scene)}].commands[${index}]`;
    const original = originalWebGalFields(command);
    if (command.command === ADV_COMMAND.Character) {
      const target = positionTarget(command.fields);
      const asset = fieldText(command.fields, "live2dKey");
      if (target && asset) characterAssetByTarget.set(target, asset);
      if (target) characterPositionByTarget.set(target, finiteNumber(command.fields.positionType, 5));
    }
    if (
      preserveSource &&
      command.source?.format === "webgal" &&
      command.source.command === "choose" &&
      command.source.raw &&
      typeof command.source.line === "number"
    ) {
      const raw = command.source.raw;
      if (sameOriginalWebGalStatement(command, scene.commands[index - 1])) continue;
      let end = index;
      while (sameOriginalWebGalStatement(command, scene.commands[end + 1])) end += 1;
      const unchanged = scene.commands
        .slice(index, end + 1)
        .every((item) => sameJson(originalWebGalFields(item), item.fields));
      if (unchanged) {
        const ids = scene.commands.slice(sourceIndex, end + 1).map((item) => item.id);
        if (losslessScope) lines.push(commandMetadataLine(ids));
        lines.push(raw);
        if (losslessScope) losslessBlocks.push({ ids, projection: raw });
        diagnostics.push(
          storyDiagnostic(
            "info",
            "webgal.export.exact",
            path,
            "Original WebGAL choice statement preserved",
            "exact",
            command.source.line,
          ),
        );
        index = end;
        continue;
      }
    }
    if (
      preserveSource &&
      command.source?.format === "webgal" &&
      command.source.command !== "choose" &&
      command.source.raw &&
      original &&
      sameJson(original, command.fields)
    ) {
      const ids = [command.id];
      if (losslessScope) lines.push(commandMetadataLine(ids));
      lines.push(command.source.raw);
      if (losslessScope) losslessBlocks.push({ ids, projection: command.source.raw });
      diagnostics.push(
        storyDiagnostic(
          "info",
          "webgal.export.exact",
          path,
          "Original WebGAL statement preserved",
          "exact",
          command.source.line,
        ),
      );
      continue;
    }
    const noWait = command.fields.noWait === true ? " -next" : "";
    let fidelity: StoryConversionFidelity = "exact";
    let output = "";
    switch (command.command) {
      case ADV_COMMAND.In: {
        const duration = durationMilliseconds(command.fields, 0.3);
        output = setTempAnimationStatement(
          [
            { alpha: 0, duration: 0, ease: "linear" },
            { alpha: 1, duration, ease: "linear" },
          ],
          positionTarget(command.fields),
          command.fields,
        );
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Out:
        output = setTempAnimationStatement(
          [{ alpha: 0, duration: durationMilliseconds(command.fields, 0.3), ease: "linear" }],
          positionTarget(command.fields),
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Talk: {
        const resolved = localizedText(command.fields.text, localeIndex);
        if (resolved.collapsed) fidelity = "approximate";
        output = `${escapeContent(fieldText(command.fields, "targetName"))}:${escapeContent(resolved.text)}${noWait};`;
        break;
      }
      case ADV_COMMAND.Shake: {
        const strength = finiteNumber(paramsOf(command.fields)[0], 1);
        const frameDuration = Math.max(1, durationMilliseconds(command.fields, 0.3) / 4);
        output = setTempAnimationStatement(
          [
            { position: { x: strength, y: 0 }, duration: frameDuration, ease: "linear" },
            { position: { x: -strength, y: 0 }, duration: frameDuration, ease: "linear" },
            { position: { x: strength, y: 0 }, duration: frameDuration, ease: "linear" },
            { position: { x: 0, y: 0 }, duration: frameDuration, ease: "linear" },
          ],
          visualTarget(command.fields),
          command.fields,
        );
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.FadeOut:
        output = [
          "setTextbox:hide -next;",
          setTempAnimationStatement(
            [{ alpha: 0, duration: durationMilliseconds(command.fields, 0.3), ease: "linear" }],
            "stage-main",
            command.fields,
          ),
        ].join("\n");
        fidelity = "approximate";
        break;
      case ADV_COMMAND.FadeIn:
        output = [
          setTempAnimationStatement(
            [{ alpha: 1, duration: durationMilliseconds(command.fields, 0.3), ease: "linear" }],
            "stage-main",
            command.fields,
            { next: true },
          ),
          `setTextbox:show${noWait};`,
        ].join("\n");
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Flash: {
        const half = Math.max(1, durationMilliseconds(command.fields, 0.2) / 2);
        output = setTempAnimationStatement(
          [
            { brightness: 3, duration: half, ease: "linear" },
            { brightness: 1, duration: half, ease: "linear" },
          ],
          "stage-main",
          command.fields,
        );
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Brightness:
        output = setTransformStatement(
          { brightness: finiteNumber(paramsOf(command.fields)[0], 1) },
          visualTarget(command.fields, "bg-main"),
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.MoveToRight:
        output = movementTransform(command.fields, finiteNumber(paramsOf(command.fields)[0], 1), 0);
        fidelity = "approximate";
        break;
      case ADV_COMMAND.MoveToLeft:
        output = movementTransform(command.fields, -finiteNumber(paramsOf(command.fields)[0], 1), 0);
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Bgm: {
        const fade = Math.max(0, finiteNumber(paramsOf(command.fields)[0], 0) * 1000);
        const volume = finiteNumber(command.fields.volume, -1);
        const asset = fieldText(command.fields, "bgmRef") || "none";
        output = `bgm:${escapeContent(asset)}${fade ? ` -enter=${fade}` : ""}${
          volume >= 0 ? ` -volume=${Math.min(100, volume <= 1 ? volume * 100 : volume)}` : ""
        }${noWait};`;
        if (finiteNumber(command.fields.duration, 0) > 0 || paramsOf(command.fields).slice(1).some(Boolean)) {
          fidelity = "approximate";
        }
        break;
      }
      case ADV_COMMAND.SoundVolume: {
        const parameters = paramsOf(command.fields);
        const category = String(parameters[0] ?? "")
          .trim()
          .toLowerCase();
        const asset = fieldText(command.fields, "targetAssetName");
        const volume = Math.max(0, Math.min(100, finiteNumber(parameters[1], 1) * 100));
        if (category === "bgm" && asset) {
          output = `bgm:${escapeContent(asset)} -volume=${volume}${noWait};`;
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL needs a BGM filename to change its volume`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Se: {
        const asset = fieldText(command.fields, "seRef") || "none";
        const soundId = fieldText(command.fields, "targetName") || fieldText(command.fields, "seId");
        const volume = finiteNumber(command.fields.volume, -1);
        output = `playEffect:${escapeContent(asset)}${soundId ? ` -id=${escapeContent(soundId)}` : ""}${
          volume >= 0 ? ` -volume=${Math.min(100, volume <= 1 ? volume * 100 : volume)}` : ""
        }${noWait};`;
        break;
      }
      case ADV_COMMAND.Location: {
        const resolved = localizedText(command.fields.text, localeIndex);
        output = `intro:${escapeContent(resolved.text)}${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Movie:
        output = `playVideo:${escapeContent(fieldText(command.fields, "videoRef"))}${noWait};`;
        break;
      case ADV_COMMAND.Clip:
        output = `playVideo:${escapeContent(fieldText(command.fields, "videoRef"))}${noWait};`;
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Voice:
        output = `playEffect:${escapeContent(firstFieldText(command.fields, "voiceRefs"))}${noWait};`;
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Delay: {
        const key = fieldText(command.fields, "key");
        const seconds =
          typeof command.fields.duration === "number"
            ? command.fields.duration
            : typeof command.fields.delaySeconds === "number"
              ? command.fields.delaySeconds
              : 0;
        if (key) {
          output =
            seconds > 0
              ? `label:${escapeContent(key)} -next;\nwait:${Math.max(0, seconds) * 1000};`
              : `label:${escapeContent(key)};`;
        } else output = `wait:${Math.max(0, seconds) * 1000};`;
        break;
      }
      case ADV_COMMAND.GoTo:
        output = `jumpLabel:${escapeContent(String(paramsOf(command.fields)[0] ?? ""))};`;
        break;
      case ADV_COMMAND.Wait:
        output = `wait:0${noWait};`;
        fidelity = "approximate";
        break;
      case ADV_COMMAND.ChoiceSet:
        output = `; Haneoka ChoiceSet (${command.id}) is a retired no-op`;
        fidelity = "unsupported";
        break;
      case ADV_COMMAND.ChoiceShow: {
        const choices = choiceDefinitionsOf(command.fields);
        if (!choices.length || choices.length !== (command.fields.choices as JsonValue[] | undefined)?.length) {
          output = `; Haneoka ChoiceShow (${command.id}) has no portable valid choice group`;
          fidelity = "unsupported";
          break;
        }
        const projected: string[] = [];
        for (const [choiceIndex, choice] of choices.entries()) {
          const resolved = localizedText(choice.text, localeIndex);
          const nextKey = typeof choice.nextKey === "string" ? choice.nextKey : "";
          const choiceValue = choice.choiceValue;
          if (!resolved.text || !nextKey || !Number.isSafeInteger(choiceValue)) {
            fidelity = "unsupported";
            break;
          }
          if (resolved.collapsed || choiceValue !== choiceIndex) fidelity = "approximate";
          projected.push(`${escapeChoicePart(resolved.text)}:${escapeChoicePart(nextKey)}`);
        }
        output =
          fidelity === "unsupported"
            ? `; Haneoka ChoiceShow (${command.id}) contains an invalid choice entry`
            : `choose:${projected.join("|")};`;
        break;
      }
      case ADV_COMMAND.Stage: {
        const duration = durationMilliseconds(command.fields);
        output = `changeBg:${escapeContent(fieldText(command.fields, "backgroundRef") || "none")}${
          duration ? ` -duration=${duration}` : ""
        }${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Character: {
        const extraArguments: string[] = [];
        const motion = fieldText(command.fields, "motionName");
        const expression = fieldText(command.fields, "expressionName");
        if (motion) extraArguments.push(`motion=${escapeContent(motion)}`);
        if (expression) extraArguments.push(`expression=${escapeContent(expression)}`);
        output = changeFigureStatement(fieldText(command.fields, "live2dKey"), command.fields, extraArguments);
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Costume: {
        const asset = fieldText(command.fields, "targetAssetName");
        if (asset) {
          output = changeFigureStatement(asset, command.fields);
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL needs the costume figure filename`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Motion:
      case ADV_COMMAND.Expression: {
        const target = positionTarget(command.fields);
        const asset = characterAssetByTarget.get(target) || "";
        const name = fieldText(
          command.fields,
          command.command === ADV_COMMAND.Motion ? "motionName" : "expressionName",
        );
        if (asset && name) {
          const figureFields = {
            ...command.fields,
            positionType: characterPositionByTarget.get(target) ?? command.fields.positionType ?? 5,
          };
          output = changeFigureStatement(asset, figureFields, [
            `${command.command === ADV_COMMAND.Motion ? "motion" : "expression"}=${escapeContent(name)}`,
          ]);
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL needs the figure asset before changing Live2D state`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Forward:
      case ADV_COMMAND.Back: {
        const target = positionTarget(command.fields);
        const asset = characterAssetByTarget.get(target) || "";
        if (asset) {
          const figureFields = {
            ...command.fields,
            positionType: characterPositionByTarget.get(target) ?? command.fields.positionType ?? 5,
          };
          output = changeFigureStatement(asset, figureFields, [
            `zIndex=${command.command === ADV_COMMAND.Forward ? 100 : -100}`,
          ]);
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL needs the figure asset to change z-order`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Still: {
        const asset = fieldText(command.fields, "stillRef") || "none";
        const duration = durationMilliseconds(command.fields);
        output = `changeFigure:${escapeContent(asset)} -id=haneoka-still -zIndex=100${
          duration ? ` -duration=${duration}` : ""
        }${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Frame: {
        const asset = fieldText(command.fields, "frameRef") || "none";
        const frameId = fieldText(command.fields, "frameName") || "haneoka-frame";
        output = `changeFigure:${escapeContent(asset)} -id=${escapeContent(frameId)} -zIndex=200${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Subtitles: {
        const resolved = localizedText(command.fields.text, localeIndex);
        output = `intro:${escapeContent(resolved.text)}${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.ChatTalk: {
        const resolved = localizedText(command.fields.text, localeIndex);
        output = `${escapeContent(fieldText(command.fields, "targetName"))}:${escapeContent(resolved.text)}${noWait};`;
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.TalkWindow: {
        const windowName = fieldText(command.fields, "talkWindow").trim().toLowerCase();
        if (["hide", "hidden", "none", "off"].includes(windowName)) {
          output = `setTextbox:hide${noWait};`;
          fidelity = "approximate";
        } else if (["show", "default", "on"].includes(windowName)) {
          output = `setTextbox:show${noWait};`;
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL can only show or hide its standard textbox`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.MoveToUp:
        output = movementTransform(command.fields, 0, finiteNumber(paramsOf(command.fields)[0], 1));
        fidelity = "approximate";
        break;
      case ADV_COMMAND.MoveToDown:
        output = movementTransform(command.fields, 0, -finiteNumber(paramsOf(command.fields)[0], 1));
        fidelity = "approximate";
        break;
      case ADV_COMMAND.MoveToDirection: {
        const parameters = paramsOf(command.fields);
        const x = finiteNumber(parameters[0], 0);
        const y = finiteNumber(parameters[1], 0);
        output = movementTransform(command.fields, x, y);
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.CameraShake: {
        const parameters = paramsOf(command.fields);
        const strength = finiteNumber(parameters[1], 1);
        const total = Math.max(1, durationMilliseconds(command.fields, finiteNumber(parameters[0], 0.3)));
        const frameDuration = total / 4;
        output = setTempAnimationStatement(
          [
            { position: { x: strength, y: -strength }, duration: frameDuration, ease: "linear" },
            { position: { x: -strength, y: strength }, duration: frameDuration, ease: "linear" },
            { position: { x: strength, y: strength }, duration: frameDuration, ease: "linear" },
            { position: { x: 0, y: 0 }, duration: frameDuration, ease: "linear" },
          ],
          "stage-main",
          command.fields,
        );
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.Pedestal:
        output = setTransformStatement(
          { position: { y: -finiteNumber(paramsOf(command.fields)[0], 0) } },
          "stage-main",
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Track:
        output = setTransformStatement(
          { position: { x: finiteNumber(paramsOf(command.fields)[0], 0) } },
          "stage-main",
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Role:
        output = setTransformStatement(
          { rotation: (finiteNumber(paramsOf(command.fields)[0], 0) * Math.PI) / 180 },
          "stage-main",
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Zoom: {
        const ratio = Math.max(0.01, finiteNumber(paramsOf(command.fields)[0], 1));
        output = setTransformStatement({ scale: { x: ratio, y: ratio } }, "stage-main", command.fields);
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.DoF: {
        const intensity = command.fields.dofActive === false ? 0 : finiteNumber(paramsOf(command.fields)[0], 1);
        output = setTransformStatement({ blur: Math.max(0, intensity) }, visualTarget(command.fields), command.fields);
        fidelity = "approximate";
        break;
      }
      case ADV_COMMAND.PostEffect: {
        const animation =
          fieldText(command.fields, "webgalAnimationName") || fieldText(command.fields, "postEffectRef");
        if (animation) {
          output = `setAnimation:${escapeContent(animation)} -target=stage-main${noWait};`;
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): no portable WebGAL animation name is available`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Look: {
        const target = positionTarget(command.fields);
        const asset = characterAssetByTarget.get(target) || "";
        if (asset) {
          const parameters = paramsOf(command.fields);
          const stopping =
            String(parameters[2] ?? "")
              .trim()
              .toLowerCase() === "stop";
          const focus = stopping
            ? { x: 0, y: 0, instant: durationMilliseconds(command.fields) === 0 }
            : {
                x: finiteNumber(parameters[0], 0),
                y: finiteNumber(parameters[1], 0),
                instant: durationMilliseconds(command.fields) === 0,
              };
          const figureFields = {
            ...command.fields,
            positionType: characterPositionByTarget.get(target) ?? command.fields.positionType ?? 5,
          };
          output = changeFigureStatement(asset, figureFields, [`focus=${escapeContent(JSON.stringify(focus))}`]);
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): WebGAL needs the Live2D figure asset before changing focus`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Alpha:
        output = setTransformStatement(
          { alpha: Math.max(0, Math.min(1, finiteNumber(paramsOf(command.fields)[0], 1))) },
          visualTarget(command.fields),
          command.fields,
        );
        fidelity = "approximate";
        break;
      case ADV_COMMAND.Timeline: {
        const timeline = command.fields.timeline;
        const frames = Array.isArray(timeline)
          ? timeline.filter((item): item is JsonObject =>
              Boolean(item && typeof item === "object" && !Array.isArray(item)),
            )
          : [];
        if (frames.length) {
          output = setTempAnimationStatement(frames, visualTarget(command.fields), command.fields);
          fidelity = "approximate";
        } else if (fieldText(command.fields, "targetAssetName")) {
          output = `setAnimation:${escapeContent(fieldText(command.fields, "targetAssetName"))} -target=${escapeContent(
            visualTarget(command.fields),
          )}${noWait};`;
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): timeline data is not a WebGAL animation frame array`;
          fidelity = "unsupported";
        }
        break;
      }
      case ADV_COMMAND.Effect: {
        const perform = fieldText(command.fields, "webgalPerformName") || fieldText(command.fields, "effectRef");
        const key = fieldText(command.fields, "targetName") || perform;
        if (perform) {
          if (activePixiEffects.has(key)) {
            activePixiEffects.delete(key);
            const remaining = [...activePixiEffects.values()];
            output = [
              `pixiInit:${remaining.length ? " -next" : noWait};`,
              ...remaining.map(
                (name, effectIndex) =>
                  `pixiPerform:${escapeContent(name)}${
                    effectIndex < remaining.length - 1 || command.fields.noWait === true ? " -next" : ""
                  };`,
              ),
            ].join("\n");
          } else {
            activePixiEffects.set(key, perform);
            output = `pixiPerform:${escapeContent(perform)}${noWait};`;
          }
          fidelity = "approximate";
        } else {
          output = `; Unsupported Haneoka command ${command.command} (${command.id}): no portable WebGAL Pixi perform name is available`;
          fidelity = "unsupported";
        }
        break;
      }
      default:
        output = `; Unsupported Haneoka command ${command.command ?? "source"} (${command.id})`;
        fidelity = "unsupported";
    }
    output = mergeOriginalWebGalArguments(output, command);
    const commandKey = fieldText(command.fields, "key");
    if (commandKey && command.command !== ADV_COMMAND.Delay && command.command !== ADV_COMMAND.ChoiceSet) {
      output = `label:${escapeContent(commandKey)} -next;\n${output}`;
    }
    const emitted = appendOriginalTrailingComment(output, command);
    const ids = scene.commands.slice(sourceIndex, index + 1).map((item) => item.id);
    if (losslessScope) lines.push(commandMetadataLine(ids));
    lines.push(emitted);
    if (losslessScope) losslessBlocks.push({ ids, projection: emitted });
    diagnostics.push(
      storyDiagnostic(
        fidelity === "unsupported" ? "warning" : "info",
        `webgal.export.${fidelity}`,
        path,
        fidelity === "exact"
          ? "Command exported to WebGAL"
          : fidelity === "approximate"
            ? "Command exported with reduced WebGAL semantics"
            : "Command emitted as an explicit unsupported comment",
        fidelity,
      ),
    );
  }
  emitCommentsBefore(Number.POSITIVE_INFINITY);
  if (losslessScope) {
    const envelope: WebGalLosslessEnvelope = {
      version: 1,
      scope: losslessScope,
      sceneId,
      localeIndex,
      ...(losslessScope === "project" ? { project: cloneStoryValue(project) } : { scene: cloneStoryValue(scene) }),
      blocks: losslessBlocks,
    };
    lines.unshift(...metadataLines(envelope));
  }
  return {
    text: lines.join(options.lineEnding ?? "\n") + (lines.length ? (options.lineEnding ?? "\n") : ""),
    diagnostics,
  };
};

export const serializeWebGalText = (project: StoryProject, options: SerializeWebGalOptions = {}): string =>
  serializeWebGal(project, options).text;

interface ParsedLosslessSegment {
  ids?: string[];
  text: string;
}

interface ParsedLosslessInput {
  cleanText: string;
  envelope?: WebGalLosslessEnvelope;
  segments: ParsedLosslessSegment[];
  diagnostics: StoryDiagnostic[];
  hasCommandMetadata: boolean;
  sawLosslessMetadata: boolean;
  invalidLosslessMetadata: boolean;
}

const losslessEnvelope = (value: JsonValue): WebGalLosslessEnvelope | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as unknown as Partial<WebGalLosslessEnvelope>;
  if (
    candidate.version !== 1 ||
    (candidate.scope !== "scene" && candidate.scope !== "project") ||
    typeof candidate.sceneId !== "string" ||
    (candidate.localeIndex !== undefined &&
      (!Number.isSafeInteger(candidate.localeIndex) || candidate.localeIndex < 0)) ||
    !Array.isArray(candidate.blocks)
  ) {
    return undefined;
  }
  return candidate as WebGalLosslessEnvelope;
};

const parseLosslessInput = (input: string | Uint8Array): ParsedLosslessInput => {
  const source = typeof input === "string" ? input : new TextDecoder().decode(input);
  const cleanLines: string[] = [];
  const rawSegments: Array<{ ids?: string[]; lines: string[] }> = [{ lines: [] }];
  const chunks = new Map<number, string>();
  const diagnostics: StoryDiagnostic[] = [];
  let chunkTotal = 0;
  let hasCommandMetadata = false;
  let sawLosslessMetadata = false;
  let invalidLosslessMetadata = false;
  const anchoredIds = new Set<string>();
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    const reservedMetadataLine = /^\s*;\s*@haneoka-(?:lossless|command)\b/.test(line);
    if (reservedMetadataLine) sawLosslessMetadata = true;
    const header = line.match(/^\s*;\s*@haneoka-lossless\s+(\d+)\/(\d+)\s+([A-Za-z0-9_-]+)\s*$/);
    if (header) {
      sawLosslessMetadata = true;
      const index = Number(header[1]);
      const total = Number(header[2]);
      if (index > 0 && total > 0 && index <= total && (!chunkTotal || chunkTotal === total) && !chunks.has(index)) {
        chunkTotal = total;
        chunks.set(index, header[3] || "");
      } else {
        invalidLosslessMetadata = true;
        diagnostics.push(
          storyDiagnostic(
            "warning",
            "webgal.lossless.invalidMetadata",
            `line:${lineIndex + 1}`,
            "Invalid Haneoka lossless metadata chunk",
            "unsupported",
            lineIndex + 1,
          ),
        );
      }
      continue;
    }
    const command = line.match(/^\s*;\s*@haneoka-command\s+([A-Za-z0-9_-]+)\s*$/);
    if (command) {
      sawLosslessMetadata = true;
      try {
        const decoded = decodeBase64Url(command[1] || "");
        const ids = Array.isArray(decoded)
          ? decoded.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        if (
          !Array.isArray(decoded) ||
          !decoded.length ||
          ids.length !== decoded.length ||
          ids.some((id) => anchoredIds.has(id))
        ) {
          throw new TypeError("command metadata must contain IDs");
        }
        ids.forEach((id) => anchoredIds.add(id));
        hasCommandMetadata = true;
        rawSegments.push({ ids, lines: [] });
        continue;
      } catch {
        invalidLosslessMetadata = true;
        diagnostics.push(
          storyDiagnostic(
            "warning",
            "webgal.lossless.invalidCommandMetadata",
            `line:${lineIndex + 1}`,
            "Invalid Haneoka command metadata was retained as a WebGAL comment",
            "unsupported",
            lineIndex + 1,
          ),
        );
      }
    }
    if (reservedMetadataLine) {
      invalidLosslessMetadata = true;
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "webgal.lossless.invalidMetadataLine",
          `line:${lineIndex + 1}`,
          "Malformed Haneoka lossless metadata line",
          "unsupported",
          lineIndex + 1,
        ),
      );
      continue;
    }
    cleanLines.push(line);
    rawSegments.at(-1)!.lines.push(line);
  }
  let envelope: WebGalLosslessEnvelope | undefined;
  if (chunkTotal) {
    try {
      if (chunks.size !== chunkTotal) throw new TypeError("metadata chunks are incomplete");
      const encoded = Array.from({ length: chunkTotal }, (_, index) => chunks.get(index + 1) || "").join("");
      envelope = losslessEnvelope(decodeBase64Url(encoded));
      if (!envelope) throw new TypeError("metadata envelope is invalid");
    } catch {
      invalidLosslessMetadata = true;
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "webgal.lossless.invalidMetadata",
          "$",
          "Haneoka lossless metadata could not be decoded; WebGAL text was still imported",
          "unsupported",
        ),
      );
    }
  }
  if (hasCommandMetadata && !envelope) invalidLosslessMetadata = true;
  if (envelope) {
    const blockIds = envelope.blocks.flatMap((block) => block.ids);
    if (
      envelope.blocks.some(
        (block) =>
          !Array.isArray(block.ids) ||
          !block.ids.length ||
          block.ids.some((id) => typeof id !== "string" || !id) ||
          typeof block.projection !== "string",
      ) ||
      new Set(blockIds).size !== blockIds.length
    ) {
      invalidLosslessMetadata = true;
    }
    if (hasCommandMetadata && (blockIds.length !== anchoredIds.size || blockIds.some((id) => !anchoredIds.has(id)))) {
      invalidLosslessMetadata = true;
    }
  }
  return {
    cleanText: cleanLines.join("\n"),
    ...(envelope ? { envelope } : {}),
    segments: rawSegments
      .map(({ ids, lines }) => ({ ...(ids ? { ids } : {}), text: lines.join("\n") }))
      .filter((segment) => segment.ids || segment.text.trim()),
    diagnostics,
    hasCommandMetadata,
    sawLosslessMetadata,
    invalidLosslessMetadata,
  };
};

/** Build the plain textarea value and its non-rendered lossless baseline. */
export const createWebGalSceneDraft = (
  project: StoryProject,
  options: Omit<SerializeWebGalOptions, "losslessMetadata"> = {},
): WebGalSceneDraft => {
  const sceneId = options.sceneId ?? project.entrySceneId;
  const serialized = serializeWebGal(project, { ...options, sceneId, losslessMetadata: "scene" });
  const parsed = parseLosslessInput(serialized.text);
  if (parsed.invalidLosslessMetadata || !parsed.envelope?.scene) {
    throw new Error("Could not create the WebGAL edit baseline");
  }
  return {
    text: parsed.cleanText,
    context: {
      version: 1,
      sceneId,
      baselineText: parsed.cleanText,
      localeIndex: options.localeIndex ?? 0,
      scene: cloneStoryValue(parsed.envelope.scene),
      blocks: cloneStoryValue(parsed.envelope.blocks),
    },
  };
};

const normalizedWebGalText = (value: string): string => value.replace(/\r\n/g, "\n");
const objectValue = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

interface WebGalFieldConflict {
  commandId: string;
  field: string;
  baselinePresent: boolean;
  currentPresent: boolean;
  editedPresent: boolean;
  baseline?: JsonValue;
  current?: JsonValue;
  edited?: JsonValue;
  editedSource?: StorySourceLocation;
}

interface MergedRepresentableFields {
  fields: JsonObject;
  conflicts: WebGalFieldConflict[];
  changedFields: number;
}

const localeObjectKeys = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
const localizedSlot = (value: JsonValue | undefined, localeIndex: number): JsonValue | undefined => {
  if (Array.isArray(value)) return value[localeIndex];
  if (value && typeof value === "object") return value[localeObjectKeys[localeIndex] || String(localeIndex)];
  return value;
};
const withLocalizedSlot = (
  value: JsonValue | undefined,
  localeIndex: number,
  edited: JsonValue | undefined,
): JsonValue | undefined => {
  if (Array.isArray(value)) {
    const localized = cloneStoryValue(value);
    while (localized.length <= localeIndex) localized.push("");
    localized[localeIndex] = edited ?? "";
    return localized;
  }
  if (value && typeof value === "object") {
    const localized = cloneStoryValue(value);
    localized[localeObjectKeys[localeIndex] || String(localeIndex)] = edited ?? "";
    return localized;
  }
  return edited;
};

/** Apply only projection baseline -> edited deltas onto the current visual command. */
const mergeRepresentableFields = (
  baselineOriginal: JsonObject,
  current: JsonObject,
  baselineProjection: JsonObject,
  edited: JsonObject,
  localeIndex: number,
  commandId: string,
  editedSource?: StorySourceLocation,
): MergedRepresentableFields => {
  const merged = cloneStoryValue(current);
  const conflicts: WebGalFieldConflict[] = [];
  let changedFields = 0;
  for (const key of new Set([...Object.keys(baselineProjection), ...Object.keys(edited)])) {
    const projectionBefore = baselineProjection[key];
    const projectionAfter = edited[key];
    if (sameJson(projectionBefore, projectionAfter)) continue;
    if (
      key === "params" &&
      [projectionBefore, projectionAfter, baselineOriginal.params, current.params].some(Array.isArray)
    ) {
      const projectedBefore = Array.isArray(projectionBefore) ? projectionBefore : [];
      const projectedAfter = Array.isArray(projectionAfter) ? projectionAfter : [];
      const baselineParams = Array.isArray(baselineOriginal.params) ? baselineOriginal.params : [];
      const currentParams = Array.isArray(current.params) ? current.params : [];
      const nextParams = cloneStoryValue(currentParams);
      for (let index = 0; index < Math.max(projectedBefore.length, projectedAfter.length); index += 1) {
        if (sameJson(projectedBefore[index], projectedAfter[index])) continue;
        changedFields += 1;
        const baselineValue = baselineParams[index];
        const currentValue = currentParams[index];
        const desired = projectedAfter[index];
        if (!sameJson(baselineValue, currentValue) && !sameJson(currentValue, desired)) {
          conflicts.push({
            commandId,
            field: `params[${index}]`,
            baselinePresent: index < baselineParams.length,
            currentPresent: index < currentParams.length,
            editedPresent: index < projectedAfter.length,
            ...(baselineValue === undefined ? {} : { baseline: cloneStoryValue(baselineValue) }),
            ...(currentValue === undefined ? {} : { current: cloneStoryValue(currentValue) }),
            ...(desired === undefined ? {} : { edited: cloneStoryValue(desired) }),
            ...(editedSource ? { editedSource: cloneStoryValue(editedSource) } : {}),
          });
        } else if (desired === undefined) {
          if (nextParams.length > index + 1) nextParams[index] = "";
          else if (index < nextParams.length) nextParams.splice(index, 1);
        } else {
          while (nextParams.length <= index) nextParams.push("");
          nextParams[index] = cloneStoryValue(desired);
        }
      }
      if (nextParams.length) merged.params = nextParams;
      else delete merged.params;
      continue;
    }
    changedFields += 1;
    const baselinePresent = key in baselineOriginal;
    const currentPresent = key in current;
    const editedPresent = key in edited;
    const baselineValue = baselineOriginal[key];
    const currentValue = current[key];
    let desired: JsonValue | undefined = projectionAfter;
    let currentChanged = !sameJson(baselineValue, currentValue);
    if (key === "text" && typeof projectionAfter === "string" && baselineValue !== undefined) {
      const baselineSlot = localizedSlot(baselineValue, localeIndex);
      const currentSlot = localizedSlot(currentValue, localeIndex);
      currentChanged = !sameJson(baselineSlot, currentSlot);
      desired = withLocalizedSlot(currentValue ?? baselineValue, localeIndex, projectionAfter);
    }
    if (currentChanged && !sameJson(currentValue, desired)) {
      conflicts.push({
        commandId,
        field: key,
        baselinePresent,
        currentPresent,
        editedPresent,
        ...(baselineValue === undefined ? {} : { baseline: cloneStoryValue(baselineValue) }),
        ...(currentValue === undefined ? {} : { current: cloneStoryValue(currentValue) }),
        ...(desired === undefined ? {} : { edited: cloneStoryValue(desired) }),
        ...(editedSource ? { editedSource: cloneStoryValue(editedSource) } : {}),
      });
      continue;
    }
    if (!editedPresent) delete merged[key];
    else if (desired !== undefined) merged[key] = cloneStoryValue(desired);
  }
  return { fields: merged, conflicts, changedFields };
};

const archiveCommand = (
  extensions: JsonObject,
  command: StoryProjectCommand,
  reason: "deleted" | "rewritten",
  context: {
    sceneId: string;
    originalIndex: number;
    previousCommandId?: string;
    nextCommandId?: string;
  },
): void => {
  const lossless = objectValue(extensions.webgalLossless);
  const archived = Array.isArray(lossless.archivedCommands) ? cloneStoryValue(lossless.archivedCommands) : [];
  const entry: JsonObject = {
    reason,
    command: cloneStoryValue(command) as unknown as JsonValue,
    sceneId: context.sceneId,
    originalIndex: context.originalIndex,
    ...(context.previousCommandId ? { previousCommandId: context.previousCommandId } : {}),
    ...(context.nextCommandId ? { nextCommandId: context.nextCommandId } : {}),
  };
  const signature = stringifyStoryJson(entry, false);
  if (!archived.some((item) => stringifyStoryJson(item, false) === signature)) archived.push(entry);
  extensions.webgalLossless = { ...lossless, archivedCommands: archived };
};

const archiveFieldConflict = (extensions: JsonObject, conflict: WebGalFieldConflict): void => {
  const lossless = objectValue(extensions.webgalLossless);
  const conflicts = Array.isArray(lossless.conflicts) ? cloneStoryValue(lossless.conflicts) : [];
  const value = cloneStoryValue(conflict as unknown as JsonObject);
  const signature = stringifyStoryJson(value, false);
  if (!conflicts.some((item) => stringifyStoryJson(item, false) === signature)) conflicts.push(value);
  extensions.webgalLossless = { ...lossless, conflicts };
};

const blockKey = (ids: readonly string[]): string => JSON.stringify(ids);

const projectionFieldsForCommand = (_command: number | null, fields: JsonObject): JsonObject =>
  cloneStoryValue(fields);

const canonicalProjectionForCommands = (
  baseline: readonly StoryProjectCommand[],
  edited: readonly StoryProjectCommand[],
  localeIndex: number,
): string => {
  const sceneId = "webgal-canonical-scene";
  const project: StoryProject = {
    version: STORY_PROJECT_VERSION,
    meta: { title: "" },
    entrySceneId: sceneId,
    scenes: [
      {
        id: sceneId,
        name: "Canonical",
        commands: baseline.map((command, index) => ({
          id: `canonical-${index}`,
          command: command.command,
          fields: projectionFieldsForCommand(command.command, edited[index]?.fields || {}),
          extensions: {},
        })),
        extensions: {},
      },
    ],
    assets: {},
    runtime: {},
    storyFields: {},
    extensions: {},
  };
  return serializeWebGal(project, { localeIndex, preserveUnchangedSource: false }).text;
};

const consumedArgumentsForCommand = (command: number | null): ReadonlySet<string> => {
  switch (command) {
    case ADV_COMMAND.Talk:
      return new Set(["speaker", "next"]);
    case ADV_COMMAND.ChatTalk:
    case ADV_COMMAND.Location:
    case ADV_COMMAND.Subtitles:
    case ADV_COMMAND.Movie:
    case ADV_COMMAND.Clip:
    case ADV_COMMAND.Voice:
    case ADV_COMMAND.Wait:
      return new Set(["next"]);
    case ADV_COMMAND.Bgm:
      return new Set(["enter", "volume", "next"]);
    case ADV_COMMAND.Se:
      return new Set(["id", "volume", "next"]);
    case ADV_COMMAND.Stage:
      return new Set(["duration", "next"]);
    case ADV_COMMAND.Character:
      return new Set(["left", "right", "id", "duration", "motion", "expression", "next"]);
    case ADV_COMMAND.Costume:
    case ADV_COMMAND.Motion:
    case ADV_COMMAND.Expression:
    case ADV_COMMAND.Forward:
    case ADV_COMMAND.Back:
    case ADV_COMMAND.Still:
    case ADV_COMMAND.Frame:
    case ADV_COMMAND.Look:
      return new Set(["left", "right", "id", "duration", "motion", "expression", "zindex", "focus", "next"]);
    default:
      return new Set();
  }
};

const projectionShape = (value: string): string[] => {
  const parsed = parseWebGalScene(value).statements;
  if (parsed.length) return parsed.map((statement) => `${statement.kind}:${statement.name}`);
  return normalizedProjection(value) ? ["comment"] : [];
};

const webGalLines = (value: string): string[] => {
  const normalized = normalizedWebGalText(value).replace(/\n+$/g, "");
  return normalized ? normalized.split("\n") : [];
};

interface LineMatch {
  baseline: number;
  edited: number;
}

const longestCommonLineMatches = (baseline: readonly string[], edited: readonly string[]): LineMatch[] => {
  const rows = Array.from({ length: baseline.length + 1 }, () => new Uint16Array(edited.length + 1));
  for (let left = baseline.length - 1; left >= 0; left -= 1) {
    for (let right = edited.length - 1; right >= 0; right -= 1) {
      rows[left]![right] =
        baseline[left] === edited[right]
          ? rows[left + 1]![right + 1]! + 1
          : Math.max(rows[left + 1]![right]!, rows[left]![right + 1]!);
    }
  }
  const matches: LineMatch[] = [];
  let left = 0;
  let right = 0;
  while (left < baseline.length && right < edited.length) {
    if (baseline[left] === edited[right]) {
      matches.push({ baseline: left, edited: right });
      left += 1;
      right += 1;
    } else if (rows[left + 1]![right]! >= rows[left]![right + 1]!) left += 1;
    else right += 1;
  }
  return matches;
};

interface RangedLosslessBlock extends WebGalLosslessBlock {
  start: number;
  end: number;
}

interface ExactStructuralItem {
  kind: "block" | "addition";
  ids: string[];
  start: number;
  end: number;
  text?: string;
}

interface ExactStructuralPlan {
  items: ExactStructuralItem[];
  deletedIds: string[];
}

const hasUnchangedProjectionField = (baseline: string, edited: string): boolean => {
  const before = importWebGalPlain(baseline).project.scenes[0]?.commands || [];
  const after = importWebGalPlain(edited).project.scenes[0]?.commands || [];
  if (before.length !== after.length || before.some((command, index) => command.command !== after[index]?.command)) {
    return false;
  }
  return before.some((command, index) => {
    const baselineFields = projectionFieldsForCommand(command.command, command.fields);
    const editedFields = projectionFieldsForCommand(after[index]!.command, after[index]!.fields);
    return Object.entries(baselineFields).some(([key, value]) => {
      const meaningful = value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
      return meaningful && key in editedFields && sameJson(value, editedFields[key]);
    });
  });
};

const exactPlainStructuralPlan = (
  editedLines: readonly string[],
  blocks: readonly RangedLosslessBlock[],
): ExactStructuralPlan | undefined => {
  const projections = blocks.map((block) => normalizedProjection(block.projection));
  if (new Set(projections).size !== projections.length) return undefined;
  const exactMatches: ExactStructuralItem[] = [];
  const matchedBlockKeys = new Set<string>();
  for (const block of blocks) {
    const projectionLines = webGalLines(block.projection);
    const starts: number[] = [];
    for (let start = 0; start + projectionLines.length <= editedLines.length; start += 1) {
      if (projectionLines.every((line, offset) => editedLines[start + offset] === line)) starts.push(start);
    }
    if (starts.length > 1) {
      throw new Error("Ambiguous WebGAL structural edit: one projection occurs more than once in the edited scene");
    }
    if (starts.length === 1) {
      const start = starts[0]!;
      exactMatches.push({ kind: "block", ids: block.ids, start, end: start + projectionLines.length });
      matchedBlockKeys.add(blockKey(block.ids));
    }
  }
  exactMatches.sort((left, right) => left.start - right.start);
  if (exactMatches.some((match, index) => index > 0 && match.start < exactMatches[index - 1]!.end)) {
    throw new Error("Ambiguous WebGAL structural edit: exact command projections overlap");
  }

  const matches = exactMatches;
  const blockByKey = new Map(blocks.map((block) => [blockKey(block.ids), block]));
  const baselineIndexes = matches.map((match) => blocks.indexOf(blockByKey.get(blockKey(match.ids))!));
  const structuralEvidence =
    matches.some((match) => match.start !== blockByKey.get(blockKey(match.ids))?.start) ||
    baselineIndexes.some((index, position) => position > 0 && index < baselineIndexes[position - 1]!);

  const items: ExactStructuralItem[] = [];
  let cursor = 0;
  let sawUnmatchedGeneratedComment = false;
  for (const match of [
    ...matches,
    { kind: "block" as const, ids: [], start: editedLines.length, end: editedLines.length },
  ]) {
    if (cursor < match.start) {
      const text = editedLines.slice(cursor, match.start).join("\n");
      const statements = parseWebGalScene(text).statements;
      if (statements.some((statement) => statement.kind !== "comment")) {
        items.push({ kind: "addition", ids: [], start: cursor, end: match.start, text });
      }
      if (
        statements.some(
          (statement) => statement.kind === "comment" && isGeneratedHaneokaProjectionComment(statement.raw),
        )
      ) {
        sawUnmatchedGeneratedComment = true;
      }
    }
    if (match.ids.length) items.push(match);
    cursor = match.end;
  }
  const deletedBlocks = blocks.filter((block) => !matchedBlockKeys.has(blockKey(block.ids)));
  const deletedIds = deletedBlocks.flatMap((block) => block.ids);
  const additions = items.filter((item) => item.kind === "addition");
  if (!structuralEvidence) {
    if (!deletedBlocks.length || !additions.length) return undefined;
    const baselineBlock = deletedBlocks[0];
    const editedBlock = additions[0];
    const editedStatement = editedBlock
      ? parseWebGalScene(editedBlock.text || "").statements.find((statement) => statement.kind !== "comment")
      : undefined;
    const editedCommandStart = editedStatement ? editedBlock!.start + editedStatement.line - 1 : editedBlock?.start;
    if (
      deletedBlocks.length === 1 &&
      additions.length === 1 &&
      baselineBlock &&
      editedBlock &&
      baselineBlock.start === editedCommandStart &&
      (blocks.length === 1 || hasUnchangedProjectionField(baselineBlock.projection, editedBlock.text || ""))
    ) {
      return undefined;
    }
    throw new Error("Ambiguous WebGAL structural edit: unmatched commands cannot be merged by position");
  }
  if (deletedIds.length && sawUnmatchedGeneratedComment) {
    throw new Error(
      "Unsupported generated WebGAL projections cannot be structurally reassigned without stable anchors",
    );
  }
  if (deletedIds.length && additions.length) {
    throw new Error("Ambiguous WebGAL structural edit: an unanchored rewrite cannot inherit a stable command identity");
  }
  return { items, deletedIds };
};

const findLineSequence = (haystack: readonly string[], needle: readonly string[], start: number): number => {
  if (!needle.length) return start;
  for (let index = start; index + needle.length <= haystack.length; index += 1) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) return index;
  }
  return -1;
};

const rangeLosslessBlocks = (
  baselineLines: readonly string[],
  blocks: readonly WebGalLosslessBlock[],
): RangedLosslessBlock[] => {
  let cursor = 0;
  return blocks.map((block) => {
    const projection = webGalLines(block.projection);
    const start = findLineSequence(baselineLines, projection, cursor);
    if (start < 0) throw new Error(`WebGAL edit baseline is inconsistent at command block ${blockKey(block.ids)}`);
    const ranged = { ...cloneStoryValue(block), start, end: start + projection.length };
    cursor = ranged.end;
    return ranged;
  });
};

interface WebGalEditHunk {
  baselineStart: number;
  baselineEnd: number;
  editedStart: number;
  editedEnd: number;
  ids: string[];
  baselineText?: string;
  editedText?: string;
  moveIds?: string[];
}

const normalizedProjection = (value: string): string => normalizedWebGalText(value).trim();

const recognizeMoveHunks = (
  hunks: readonly WebGalEditHunk[],
  baselineLines: readonly string[],
  editedLines: readonly string[],
  blocks: readonly RangedLosslessBlock[],
): WebGalEditHunk[] => {
  const textOfBaseline = (hunk: WebGalEditHunk) =>
    hunk.baselineText ?? baselineLines.slice(hunk.baselineStart, hunk.baselineEnd).join("\n");
  const textOfEdit = (hunk: WebGalEditHunk) =>
    hunk.editedText ?? editedLines.slice(hunk.editedStart, hunk.editedEnd).join("\n");
  const projectionCounts = new Map<string, number>();
  for (const block of blocks) {
    const projection = normalizedProjection(block.projection);
    projectionCounts.set(projection, (projectionCounts.get(projection) || 0) + 1);
  }
  for (const hunk of hunks) {
    const touched = blocks.filter((block) => block.ids.some((id) => hunk.ids.includes(id)));
    if (touched.some((block) => (projectionCounts.get(normalizedProjection(block.projection)) || 0) > 1)) {
      throw new Error(
        "Ambiguous WebGAL structural edit: duplicate projections cannot be assigned to stable command IDs",
      );
    }
  }
  const insertions = hunks.filter(
    (hunk) => !hunk.ids.length && !normalizedProjection(textOfBaseline(hunk)) && normalizedProjection(textOfEdit(hunk)),
  );
  const deletions = hunks.filter(
    (hunk) => hunk.ids.length && normalizedProjection(textOfBaseline(hunk)) && !normalizedProjection(textOfEdit(hunk)),
  );
  const consumed = new Set<WebGalEditHunk>();
  const moved = new Map<WebGalEditHunk, string[]>();
  for (const insertion of insertions) {
    const projection = normalizedProjection(textOfEdit(insertion));
    const candidates = deletions.filter(
      (deletion) => !consumed.has(deletion) && normalizedProjection(textOfBaseline(deletion)) === projection,
    );
    if (!candidates.length) continue;
    if (candidates.length !== 1 || (projectionCounts.get(projection) || 0) !== 1) {
      throw new Error("Ambiguous WebGAL move: the projection does not identify one stable command");
    }
    consumed.add(candidates[0]!);
    moved.set(insertion, candidates[0]!.ids);
  }
  return hunks.flatMap((hunk) =>
    consumed.has(hunk) ? [] : [{ ...hunk, ...(moved.has(hunk) ? { moveIds: moved.get(hunk)! } : {}) }],
  );
};

const editHunks = (
  baselineLines: readonly string[],
  editedLines: readonly string[],
  blocks: readonly RangedLosslessBlock[],
): WebGalEditHunk[] => {
  const matches = longestCommonLineMatches(baselineLines, editedLines);
  const raw: WebGalEditHunk[] = [];
  let previousBaseline = -1;
  let previousEdited = -1;
  for (const match of [...matches, { baseline: baselineLines.length, edited: editedLines.length }]) {
    const baselineStart = previousBaseline + 1;
    const editedStart = previousEdited + 1;
    if (baselineStart < match.baseline || editedStart < match.edited) {
      const touched = blocks.filter((block) => block.start < match.baseline && block.end > baselineStart);
      const expandedStart = touched.length
        ? Math.min(baselineStart, ...touched.map((block) => block.start))
        : baselineStart;
      const expandedEnd = touched.length
        ? Math.max(match.baseline, ...touched.map((block) => block.end))
        : match.baseline;
      const before = [...matches].reverse().find((item) => item.baseline < expandedStart);
      const after = matches.find((item) => item.baseline >= expandedEnd);
      raw.push({
        baselineStart: expandedStart,
        baselineEnd: expandedEnd,
        editedStart: before ? before.edited + 1 : 0,
        editedEnd: after ? after.edited : editedLines.length,
        ids: blocks
          .filter((block) => block.start < expandedEnd && block.end > expandedStart)
          .flatMap((block) => block.ids),
      });
    }
    previousBaseline = match.baseline;
    previousEdited = match.edited;
  }
  const merged: WebGalEditHunk[] = [];
  for (const hunk of raw.sort(
    (left, right) => left.baselineStart - right.baselineStart || left.editedStart - right.editedStart,
  )) {
    const previous = merged.at(-1);
    if (
      previous &&
      (hunk.baselineStart < previous.baselineEnd ||
        hunk.editedStart < previous.editedEnd ||
        (hunk.baselineStart === previous.baselineStart && hunk.baselineEnd === previous.baselineEnd))
    ) {
      previous.baselineStart = Math.min(previous.baselineStart, hunk.baselineStart);
      previous.baselineEnd = Math.max(previous.baselineEnd, hunk.baselineEnd);
      previous.editedStart = Math.min(previous.editedStart, hunk.editedStart);
      previous.editedEnd = Math.max(previous.editedEnd, hunk.editedEnd);
      previous.ids = [...new Set([...previous.ids, ...hunk.ids])];
    } else merged.push({ ...hunk, ids: [...new Set(hunk.ids)] });
  }
  return merged;
};

const insertionIndexForBaselinePosition = (
  current: readonly StoryProjectCommand[],
  baseline: readonly StoryProjectCommand[],
  baselineLine: number,
  blocks: readonly RangedLosslessBlock[],
): number => {
  const precedingIds = blocks.filter((block) => block.end <= baselineLine).flatMap((block) => block.ids);
  for (const id of precedingIds.reverse()) {
    const index = current.findIndex((command) => command.id === id);
    if (index >= 0) return index + 1;
  }
  const followingIds = blocks.filter((block) => block.start >= baselineLine).flatMap((block) => block.ids);
  for (const id of followingIds) {
    const index = current.findIndex((command) => command.id === id);
    if (index >= 0) return index;
  }
  const baselineIds = new Set(baseline.map((command) => command.id));
  const firstVisualAddition = current.findIndex((command) => !baselineIds.has(command.id));
  return firstVisualAddition >= 0 ? firstVisualAddition : current.length;
};

const mergeLosslessScene = (
  baseProject: StoryProject,
  parsed: ParsedLosslessInput,
  options: ImportWebGalOptions & {
    sceneId: string;
    localeIndex?: number;
    baselineContext?: WebGalSceneEditContext;
  },
): StoryImportResult => {
  if (parsed.invalidLosslessMetadata) {
    throw new Error("Invalid or duplicated Haneoka lossless WebGAL metadata");
  }
  const project = cloneStoryValue(baseProject);
  const scene = project.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new RangeError(`Story scene '${options.sceneId}' does not exist`);
  if (options.baselineContext && options.baselineContext.sceneId !== scene.id) {
    throw new Error("WebGAL edit context belongs to another scene");
  }
  const storedLocaleIndex = options.baselineContext?.localeIndex ?? parsed.envelope?.localeIndex;
  if (
    storedLocaleIndex !== undefined &&
    options.localeIndex !== undefined &&
    storedLocaleIndex !== options.localeIndex
  ) {
    throw new Error("WebGAL edit locale does not match its lossless baseline");
  }
  const localeIndex = storedLocaleIndex ?? options.localeIndex ?? 0;
  const baselineScene = cloneStoryValue(options.baselineContext?.scene || parsed.envelope?.scene || scene);
  const baselineCommandIds = baselineScene.commands.map((command) => command.id);
  const baselineProject = cloneStoryValue(project);
  baselineProject.scenes = baselineProject.scenes.map((item) => (item.id === scene.id ? baselineScene : item));
  const generatedBaseline = serializeWebGal(baselineProject, {
    sceneId: scene.id,
    localeIndex,
    losslessMetadata: options.baselineContext ? false : "scene",
  });
  const generatedParsed = options.baselineContext ? undefined : parseLosslessInput(generatedBaseline.text);
  const baseline = options.baselineContext?.baselineText || generatedParsed?.cleanText || generatedBaseline.text;
  const losslessBlocks =
    options.baselineContext?.blocks || parsed.envelope?.blocks || generatedParsed?.envelope?.blocks || [];
  const blockCommandIds = losslessBlocks.flatMap((block) => block.ids);
  if (
    baselineCommandIds.length !== blockCommandIds.length ||
    baselineCommandIds.some((id) => !blockCommandIds.includes(id))
  ) {
    throw new Error("WebGAL edit context command blocks do not match its scene snapshot");
  }
  const imported = importWebGalPlain(parsed.cleanText, {
    ...options,
    sceneId: scene.id,
    sceneName: scene.name,
  });
  const hasEditedAuthorComments = parseWebGalScene(parsed.cleanText).statements.some(
    (statement) => statement.kind === "comment" && !isGeneratedHaneokaProjectionComment(statement.raw),
  );
  const diagnostics = [...parsed.diagnostics, ...imported.diagnostics];
  if (normalizedWebGalText(parsed.cleanText) === normalizedWebGalText(baseline)) {
    diagnostics.push(
      storyDiagnostic(
        "info",
        "webgal.lossless.unchanged",
        `$.scenes[${project.scenes.indexOf(scene)}]`,
        "Unchanged WebGAL projection restored the original Haneoka scene exactly",
        "exact",
      ),
    );
    return { format: "webgal", project, diagnostics };
  }

  const baselineLines = webGalLines(baseline);
  const editedLines = webGalLines(parsed.cleanText);
  const rangedBlocks = rangeLosslessBlocks(baselineLines, losslessBlocks);
  const exactStructuralPlan = parsed.hasCommandMetadata
    ? undefined
    : exactPlainStructuralPlan(editedLines, rangedBlocks);
  const rawHunks: WebGalEditHunk[] = exactStructuralPlan
    ? exactStructuralPlan.items.flatMap((item) => {
        if (item.kind !== "block" || item.text === undefined) return [];
        const block = rangedBlocks.find((candidate) => blockKey(candidate.ids) === blockKey(item.ids));
        if (!block) throw new Error(`WebGAL structural match has no baseline block: ${blockKey(item.ids)}`);
        return [
          {
            baselineStart: block.start,
            baselineEnd: block.end,
            editedStart: item.start,
            editedEnd: item.end,
            ids: item.ids,
            baselineText: block.projection,
            editedText: item.text,
          },
        ];
      })
    : parsed.hasCommandMetadata
      ? parsed.segments.flatMap((segment) => {
          if (!segment.ids?.length) {
            const addedCommands = importWebGalPlain(segment.text, {
              ...options,
              sceneId: scene.id,
              sceneName: scene.name,
            }).project.scenes[0]?.commands;
            return addedCommands?.length
              ? [
                  {
                    baselineStart: 0,
                    baselineEnd: 0,
                    editedStart: 0,
                    editedEnd: 0,
                    ids: [],
                    baselineText: "",
                    editedText: segment.text,
                  },
                ]
              : [];
          }
          const relevant = rangedBlocks.filter((block) => block.ids.some((id) => segment.ids!.includes(id)));
          if (!relevant.length)
            throw new Error(`WebGAL command anchor does not exist in its baseline: ${segment.ids.join(", ")}`);
          const baselineStart = Math.min(...relevant.map((block) => block.start));
          const baselineEnd = Math.max(...relevant.map((block) => block.end));
          const baselineText = baselineLines.slice(baselineStart, baselineEnd).join("\n");
          if (normalizedWebGalText(segment.text).trim() === normalizedWebGalText(baselineText).trim()) return [];
          return [
            {
              baselineStart,
              baselineEnd,
              editedStart: 0,
              editedEnd: 0,
              ids: segment.ids,
              baselineText,
              editedText: segment.text,
            },
          ];
        })
      : editHunks(baselineLines, editedLines, rangedBlocks);
  const hunks = parsed.hasCommandMetadata
    ? rawHunks
    : recognizeMoveHunks(rawHunks, baselineLines, editedLines, rangedBlocks);
  const baselineById = new Map(baselineScene.commands.map((command) => [command.id, command]));
  let nextCommands = cloneStoryValue(scene.commands);
  const rewritten: StoryProjectCommand[] = [];
  const deleted: StoryProjectCommand[] = [];
  const fieldConflicts: WebGalFieldConflict[] = [];
  const structuralConflicts: JsonObject[] = [];
  let mergedCommandCount = 0;
  let movedCommandCount = 0;
  const baselineIdSet = new Set(baselineScene.commands.map((command) => command.id));
  const baselineOrder = baselineScene.commands.map((command) => command.id);
  const currentBaselineOrder = scene.commands
    .filter((command) => baselineIdSet.has(command.id))
    .map((command) => command.id);
  const currentBaselineIdSet = new Set(currentBaselineOrder);
  const expectedCurrentBaselineOrder = baselineOrder.filter((id) => currentBaselineIdSet.has(id));
  const currentWasReordered = currentBaselineOrder.some((id, index) => id !== expectedCurrentBaselineOrder[index]);
  const anchoredOrder = parsed.hasCommandMetadata
    ? parsed.segments.flatMap((segment) => segment.ids || [])
    : baselineOrder;
  const anchorsWereReordered =
    anchoredOrder.length === baselineOrder.length && anchoredOrder.some((id, index) => id !== baselineOrder[index]);
  if (anchorsWereReordered) {
    if (currentWasReordered) {
      throw new Error("Concurrent WebGAL structural conflict: command anchors and visual commands were both reordered");
    }
    if (currentBaselineOrder.length !== baselineOrder.length) {
      throw new Error("Concurrent WebGAL structural conflict: a command anchor was deleted visually");
    }
    const currentById = new Map(nextCommands.map((command) => [command.id, command]));
    const baselineSlots = nextCommands.flatMap((command, index) => (baselineIdSet.has(command.id) ? [index] : []));
    for (const [slotIndex, commandId] of anchoredOrder.entries()) {
      const command = currentById.get(commandId);
      if (!command) throw new Error(`WebGAL command anchor '${commandId}' is missing from the current scene`);
      nextCommands[baselineSlots[slotIndex]!] = command;
    }
    movedCommandCount += anchoredOrder.filter((id, index) => id !== baselineOrder[index]).length;
  }
  if (exactStructuralPlan) {
    const plannedBaselineOrder = exactStructuralPlan.items.flatMap((item) => (item.kind === "block" ? item.ids : []));
    const survivingBaselineOrder = baselineOrder.filter((id) => plannedBaselineOrder.includes(id));
    const hasDraftAdditions = exactStructuralPlan.items.some((item) => item.kind === "addition");
    const structuralChange =
      hasDraftAdditions ||
      exactStructuralPlan.deletedIds.length > 0 ||
      plannedBaselineOrder.some((id, index) => id !== survivingBaselineOrder[index]);
    if (structuralChange) {
      if (currentWasReordered) {
        throw new Error("Concurrent WebGAL structural conflict: the visual command order also changed");
      }
      const currentById = new Map(nextCommands.map((command) => [command.id, command]));
      for (const id of plannedBaselineOrder) {
        if (!currentById.has(id)) {
          throw new Error(`Concurrent WebGAL structural conflict: command '${id}' was deleted visually`);
        }
      }
      const currentVisualAdditions = scene.commands.filter((command) => !baselineIdSet.has(command.id));
      if (
        hasEditedAuthorComments &&
        (currentVisualAdditions.length > 0 ||
          plannedBaselineOrder.some((id) => currentById.get(id)?.source?.format !== "webgal"))
      ) {
        throw new Error("Ambiguous WebGAL structural edit: author comments cannot be anchored to these commands");
      }
      const usedIds = new Set(nextCommands.map((command) => command.id));
      const planned: StoryProjectCommand[] = [];
      let additionIndex = 0;
      for (const item of exactStructuralPlan.items) {
        if (item.kind === "block") {
          for (const id of item.ids) {
            const command = cloneStoryValue(currentById.get(id)!);
            if (command.source?.format === "webgal") command.source.line = item.start + 1;
            planned.push(command);
          }
          continue;
        }
        const added = importWebGalPlain(item.text || "", {
          ...options,
          sceneId: scene.id,
          sceneName: scene.name,
        }).project.scenes[0]?.commands;
        for (const [commandIndex, command] of (added || []).entries()) {
          let id = importedStoryId("webgal-edit", item.start, `structural-${additionIndex}-${commandIndex}`);
          while (usedIds.has(id)) id = `${id}-copy`;
          usedIds.add(id);
          const addedCommand = { ...cloneStoryValue(command), id };
          if (addedCommand.source?.format === "webgal" && typeof addedCommand.source.line === "number") {
            addedCommand.source.line += item.start;
          }
          planned.push(addedCommand);
        }
        additionIndex += 1;
      }

      const placedVisualAdditionIds = new Set<string>();
      for (const addition of currentVisualAdditions) {
        const currentIndex = scene.commands.findIndex((command) => command.id === addition.id);
        const previousBaselineId = scene.commands
          .slice(0, currentIndex)
          .reverse()
          .find((command) => baselineIdSet.has(command.id))?.id;
        const nextBaselineId = scene.commands
          .slice(currentIndex + 1)
          .find((command) => baselineIdSet.has(command.id))?.id;
        let insertionIndex = previousBaselineId
          ? planned.findIndex((command) => command.id === previousBaselineId) + 1
          : -1;
        if (insertionIndex > 0) {
          while (placedVisualAdditionIds.has(planned[insertionIndex]?.id || "")) insertionIndex += 1;
        } else if (nextBaselineId) {
          insertionIndex = planned.findIndex((command) => command.id === nextBaselineId);
        }
        if (insertionIndex < 0) insertionIndex = planned.length;
        planned.splice(insertionIndex, 0, addition);
        placedVisualAdditionIds.add(addition.id);
      }

      for (const id of exactStructuralPlan.deletedIds) {
        const command = currentById.get(id);
        if (command) deleted.push(command);
      }
      nextCommands = planned;
      movedCommandCount += plannedBaselineOrder.filter((id, index) => id !== survivingBaselineOrder[index]).length;
    }
  }
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const editedText = hunk.editedText ?? editedLines.slice(hunk.editedStart, hunk.editedEnd).join("\n");
    const baselineText = hunk.baselineText ?? baselineLines.slice(hunk.baselineStart, hunk.baselineEnd).join("\n");
    if (hunk.moveIds?.length) {
      if (currentWasReordered) {
        throw new Error("Concurrent WebGAL structural conflict: the visual command order also changed");
      }
      const movingById = new Map(nextCommands.map((command) => [command.id, command]));
      const moving = hunk.moveIds.flatMap((id) => {
        const command = movingById.get(id);
        return command ? [command] : [];
      });
      if (moving.length !== hunk.moveIds.length) {
        throw new Error("Concurrent WebGAL structural conflict: a command being moved was deleted visually");
      }
      const movingIds = new Set(hunk.moveIds);
      nextCommands = nextCommands.filter((command) => !movingIds.has(command.id));
      const insertionIndex = insertionIndexForBaselinePosition(
        nextCommands,
        baselineScene.commands,
        hunk.baselineStart,
        rangedBlocks,
      );
      nextCommands.splice(Math.min(insertionIndex, nextCommands.length), 0, ...moving);
      movedCommandCount += moving.length;
      continue;
    }
    const baselineCommands = hunk.ids.flatMap((id) => {
      const command = baselineById.get(id);
      return command ? [command] : [];
    });
    const editedImport = importWebGalPlain(editedText, {
      ...options,
      sceneId: scene.id,
      sceneName: scene.name,
    });
    const editedCommands = editedImport.project.scenes[0]?.commands || [];
    if (!parsed.hasCommandMetadata && hunk.editedStart > 0) {
      for (const command of editedCommands) {
        if (command.source?.format === "webgal" && typeof command.source.line === "number") {
          command.source.line += hunk.editedStart;
        }
      }
    }
    const baselineProjectedCommands =
      importWebGalPlain(baselineText, {
        ...options,
        sceneId: scene.id,
        sceneName: scene.name,
      }).project.scenes[0]?.commands || [];
    const currentById = new Map(nextCommands.map((command) => [command.id, command]));
    const currentCommands = hunk.ids.flatMap((id) => {
      const command = currentById.get(id);
      return command ? [command] : [];
    });
    const canMerge =
      baselineCommands.length > 0 &&
      currentCommands.length === baselineCommands.length &&
      baselineCommands.length === editedCommands.length &&
      baselineCommands.length === baselineProjectedCommands.length &&
      baselineCommands.every(
        (command, index) =>
          command.command !== null &&
          command.command === currentCommands[index]?.command &&
          command.command === baselineProjectedCommands[index]?.command &&
          command.command === editedCommands[index]?.command,
      );
    if (canMerge) {
      const baselineRequiresExactSource =
        normalizedProjection(
          canonicalProjectionForCommands(baselineCommands, baselineProjectedCommands, localeIndex),
        ) !== normalizedProjection(baselineText);
      const editedRequiresExactSource =
        normalizedProjection(canonicalProjectionForCommands(baselineCommands, editedCommands, localeIndex)) !==
        normalizedProjection(editedText);
      const rawProjectionChanged = normalizedProjection(baselineText) !== normalizedProjection(editedText);
      const preserveEditedRawSource =
        rawProjectionChanged && (baselineRequiresExactSource || editedRequiresExactSource);
      const merged = baselineCommands.map((baselineCommand, commandIndex) => {
        const currentCommand = currentCommands[commandIndex]!;
        const projectedCommand = baselineProjectedCommands[commandIndex]!;
        const editedCommand = editedCommands[commandIndex]!;
        const result = mergeRepresentableFields(
          baselineCommand.fields,
          currentCommand.fields,
          projectionFieldsForCommand(baselineCommand.command, projectedCommand.fields),
          projectionFieldsForCommand(baselineCommand.command, editedCommand.fields),
          localeIndex,
          currentCommand.id,
          editedCommand.source,
        );
        return { currentCommand, result };
      });
      const hasRepresentableOrSourceChange = merged.some((item, commandIndex) => {
        if (item.result.changedFields > 0) return true;
        const edited = editedCommands[commandIndex];
        return baselineProjectedCommands[commandIndex]?.source?.raw !== edited?.source?.raw && preserveEditedRawSource;
      });
      if (hasRepresentableOrSourceChange) {
        for (const { currentCommand, result } of merged) {
          const index = nextCommands.findIndex((command) => command.id === currentCommand.id);
          if (index >= 0) {
            const commandIndex = currentCommands.findIndex((command) => command.id === currentCommand.id);
            const editedCommand = editedCommands[commandIndex];
            const preserveEditedSource = !result.conflicts.length && preserveEditedRawSource;
            const nextCommand: StoryProjectCommand = {
              ...cloneStoryValue(currentCommand),
              fields: result.fields,
            };
            if (preserveEditedSource && editedCommand?.source) {
              rewritten.push(cloneStoryValue(currentCommand));
              nextCommand.source = cloneStoryValue(editedCommand.source);
              nextCommand.extensions = {
                ...nextCommand.extensions,
                webgalOriginalFields: cloneStoryValue(result.fields),
              };
            }
            nextCommands[index] = nextCommand;
          }
          fieldConflicts.push(...result.conflicts);
        }
        mergedCommandCount += merged.length;
        continue;
      }
    }

    const editsKnownHaneokaProjection = baselineCommands.some((command) => command.command !== null);
    if (
      options.baselineContext &&
      editsKnownHaneokaProjection &&
      normalizedProjection(editedText) &&
      sameJson(projectionShape(baselineText), projectionShape(editedText))
    ) {
      throw new Error(
        "This WebGAL projection cannot be decoded back to its Haneoka command without losing native fields",
      );
    }

    if (hunk.ids.length && currentCommands.length !== baselineCommands.length) {
      structuralConflicts.push({
        kind: "concurrent-delete",
        ids: cloneStoryValue(hunk.ids),
        editedText,
      });
      continue;
    }

    const currentIndexes = hunk.ids
      .map((id) => nextCommands.findIndex((command) => command.id === id))
      .filter((index) => index >= 0);
    const insertionIndex = currentIndexes.length
      ? Math.min(...currentIndexes)
      : insertionIndexForBaselinePosition(nextCommands, baselineScene.commands, hunk.baselineStart, rangedBlocks);
    const removed = currentIndexes.map((index) => nextCommands[index]!).filter(Boolean);
    if (removed.length) {
      (editedCommands.length ? rewritten : deleted).push(...removed);
      const removedIds = new Set(removed.map((command) => command.id));
      nextCommands = nextCommands.filter((command) => !removedIds.has(command.id));
    }
    const usedIds = new Set(nextCommands.map((command) => command.id));
    const replacements = editedCommands.map((command, commandIndex) => {
      let id = importedStoryId("webgal-edit", hunk.baselineStart, `${hunkIndex}-${commandIndex}`);
      while (usedIds.has(id)) id = `${id}-copy`;
      usedIds.add(id);
      return { ...cloneStoryValue(command), id };
    });
    nextCommands.splice(Math.min(insertionIndex, nextCommands.length), 0, ...replacements);
  }
  const importedScene = imported.project.scenes[0];
  const originalWebgal = objectValue(scene.extensions.webgal);
  const importedWebgal = objectValue(importedScene?.extensions.webgal);
  scene.commands = nextCommands;
  scene.extensions = {
    ...scene.extensions,
    webgal: { ...originalWebgal, ...cloneStoryValue(importedWebgal) },
  };
  for (const conflict of fieldConflicts) archiveFieldConflict(scene.extensions, conflict);
  if (structuralConflicts.length) {
    const lossless = objectValue(scene.extensions.webgalLossless);
    const conflicts = Array.isArray(lossless.structuralConflicts) ? cloneStoryValue(lossless.structuralConflicts) : [];
    for (const conflict of structuralConflicts) {
      const signature = stringifyStoryJson(conflict, false);
      if (!conflicts.some((item) => stringifyStoryJson(item, false) === signature)) conflicts.push(conflict);
    }
    scene.extensions.webgalLossless = { ...lossless, structuralConflicts: conflicts };
  }
  if (mergedCommandCount) {
    diagnostics.push(
      storyDiagnostic(
        "info",
        "webgal.lossless.fieldsMerged",
        `$.scenes[${project.scenes.indexOf(scene)}].commands`,
        `${mergedCommandCount} command(s) received only the fields changed in the WebGAL draft`,
        "exact",
      ),
    );
  }
  if (movedCommandCount) {
    diagnostics.push(
      storyDiagnostic(
        "info",
        "webgal.lossless.commandsMoved",
        `$.scenes[${project.scenes.indexOf(scene)}].commands`,
        `${movedCommandCount} command(s) were moved without replacing their IDs or opaque fields`,
        "exact",
      ),
    );
  }
  if (fieldConflicts.length) {
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "webgal.lossless.fieldConflicts",
        `$.scenes[${project.scenes.indexOf(scene)}].extensions.webgalLossless.conflicts`,
        `${fieldConflicts.length} concurrent field edit(s) kept the current visual value and archived the WebGAL edit`,
        "unsupported",
      ),
    );
  }
  if (structuralConflicts.length) {
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "webgal.lossless.structuralConflicts",
        `$.scenes[${project.scenes.indexOf(scene)}].extensions.webgalLossless.structuralConflicts`,
        `${structuralConflicts.length} stale structural edit(s) were archived because their visual command was already deleted`,
        "unsupported",
      ),
    );
  }
  const rewrittenIds = new Set(rewritten.map((command) => command.id));
  const deletedIds = new Set(deleted.map((command) => command.id));
  const archivedById = new Map([...rewritten, ...deleted].map((command) => [command.id, command]));
  const archivedInSourceOrder = [
    ...baselineScene.commands.flatMap((command) => {
      const archived = archivedById.get(command.id);
      return archived ? [archived] : [];
    }),
    ...[...archivedById.values()].filter(
      (command) => !baselineScene.commands.some((baselineCommand) => baselineCommand.id === command.id),
    ),
  ];
  for (const command of archivedInSourceOrder) {
    const originalIndex = baselineScene.commands.findIndex((candidate) => candidate.id === command.id);
    const context = {
      sceneId: scene.id,
      originalIndex,
      ...(baselineScene.commands[originalIndex - 1]?.id
        ? { previousCommandId: baselineScene.commands[originalIndex - 1]!.id }
        : {}),
      ...(baselineScene.commands[originalIndex + 1]?.id
        ? { nextCommandId: baselineScene.commands[originalIndex + 1]!.id }
        : {}),
    };
    if (rewrittenIds.has(command.id)) archiveCommand(scene.extensions, command, "rewritten", context);
    else if (deletedIds.has(command.id)) archiveCommand(scene.extensions, command, "deleted", context);
  }
  if (rewritten.length) {
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "webgal.lossless.commandsRewritten",
        `$.scenes[${project.scenes.indexOf(scene)}].extensions.webgalLossless.archivedCommands`,
        `${rewritten.length} command snapshot(s) were archived because the WebGAL rewrite could not be merged safely`,
        "unsupported",
      ),
    );
  }
  if (deleted.length) {
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "webgal.lossless.commandsDeleted",
        `$.scenes[${project.scenes.indexOf(scene)}].extensions.webgalLossless.archivedCommands`,
        `${deleted.length} deleted command snapshot(s) were archived instead of being discarded`,
        "unsupported",
      ),
    );
  }
  assertValidStoryProject(project);
  return { format: "webgal", project, diagnostics };
};

export interface MergeWebGalSceneOptions extends ImportWebGalOptions {
  sceneId?: string;
  localeIndex?: number;
  baselineContext?: WebGalSceneEditContext;
}

/** Apply an editable WebGAL projection without replacing opaque Haneoka data. */
export const mergeWebGalScene = (
  project: StoryProject,
  input: string | Uint8Array,
  options: MergeWebGalSceneOptions = {},
): StoryImportResult => {
  assertValidStoryProject(project);
  const sceneId = options.sceneId ?? project.entrySceneId;
  const parsed = parseLosslessInput(input);
  return mergeLosslessScene(project, parsed, { ...options, sceneId });
};

/** Import plain WebGAL, or restore/merge a Haneoka lossless WebGAL export. */
export const importWebGal = (input: string | Uint8Array, options: ImportWebGalOptions = {}): StoryImportResult => {
  const parsed = parseLosslessInput(input);
  if (parsed.invalidLosslessMetadata || (parsed.sawLosslessMetadata && !parsed.envelope)) {
    throw new Error("Invalid or incomplete Haneoka lossless WebGAL metadata");
  }
  if (!parsed.envelope) {
    const result = importWebGalPlain(parsed.cleanText, options);
    result.diagnostics.unshift(...parsed.diagnostics);
    return result;
  }
  const envelope = parsed.envelope;
  let base: StoryProject;
  if (envelope.scope === "project" && envelope.project) {
    base = cloneStoryValue(envelope.project);
    assertValidStoryProject(base);
  } else if (envelope.scope === "scene" && envelope.scene) {
    const plain = importWebGalPlain(parsed.cleanText, options).project;
    const scene = cloneStoryValue(envelope.scene);
    plain.scenes = [scene];
    plain.entrySceneId = scene.id;
    base = plain;
    assertValidStoryProject(base);
  } else {
    throw new TypeError("Haneoka lossless WebGAL snapshot is missing");
  }
  if (!base.scenes.some((scene) => scene.id === envelope.sceneId)) {
    throw new Error(`Haneoka lossless WebGAL scene '${envelope.sceneId}' is missing from its snapshot`);
  }
  const sceneId = envelope.sceneId;
  return mergeLosslessScene(base, parsed, { ...options, sceneId });
};
