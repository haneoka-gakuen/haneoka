import { ADV_COMMAND, commandDescriptor, storyCommandFieldValue } from "./commands.js";
import { STORY_PROJECT_VERSION, type JsonValue, type StoryProject, type StoryProjectCommand } from "./model.js";
import { storyResourceAliases, type StoryResourceKind } from "./resources.js";

export type ValidationSeverity = "error" | "warning";

export interface StoryValidationIssue {
  severity: ValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface StoryProjectValidationResult {
  valid: boolean;
  errors: StoryValidationIssue[];
  warnings: StoryValidationIssue[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const records = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter(record);
  if (record(value)) return Object.values(value).filter(record);
  return [];
};

const registry = (
  value: unknown,
  keysOf: (entry: Record<string, unknown>) => readonly unknown[],
): Map<string, Record<string, unknown>> => {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of records(value)) {
    for (const key of keysOf(entry)) {
      const identity = String(key ?? "").trim();
      if (identity && !result.has(identity)) result.set(identity, entry);
    }
  }
  return result;
};

const resourceRegistry = (value: unknown, kind: StoryResourceKind) =>
  registry(value, (entry) => storyResourceAliases(kind, entry));

const isJsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
};

const hasLocalizedText = (value: unknown): boolean => {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasLocalizedText);
  return record(value) && Object.values(value).some(hasLocalizedText);
};

const isInt32 = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647;

const PRIVATE_ADV_FIELD_KEYS = Object.freeze([
  "advTextId",
  "bgmId",
  "seId",
  "videoId",
  "voiceIds",
  "targetChatID",
  "targetTextIds",
  "targetTextIDs",
  "TargetTextIds",
  "TargetTextIDs",
  "raw",
] as const);

export const validateStoryProject = (value: unknown): StoryProjectValidationResult => {
  const errors: StoryValidationIssue[] = [];
  const warnings: StoryValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    (severity === "error" ? errors : warnings).push({ severity, code, path, message });
  };
  if (!record(value)) {
    add("error", "project.type", "$", "Story project must be an object");
    return { valid: false, errors, warnings };
  }
  if (value.version !== STORY_PROJECT_VERSION) {
    add("error", "project.version", "$.version", `Story project version must be ${STORY_PROJECT_VERSION}`);
  }
  if (!record(value.meta)) {
    add("error", "meta.type", "$.meta", "Project metadata must be an object");
  } else {
    if (typeof value.meta.title !== "string") add("error", "meta.title", "$.meta.title", "Title must be a string");
    if (value.meta.assetServer !== undefined) {
      add(
        "error",
        "meta.assetServer.legacy",
        "$.meta.assetServer",
        "assetServer is not supported by story project version 2; use releaseServer",
      );
    }
    for (const key of ["description", "locale", "releaseServer"] as const) {
      if (value.meta[key] !== undefined && typeof value.meta[key] !== "string") {
        add("error", `meta.${key}`, `$.meta.${key}`, `${key} must be a string`);
      }
    }
    if (
      value.meta.tags !== undefined &&
      (!Array.isArray(value.meta.tags) || value.meta.tags.some((tag) => typeof tag !== "string"))
    ) {
      add("error", "meta.tags", "$.meta.tags", "Tags must be strings");
    }
    for (const key of ["provenance", "extra"] as const) {
      if (value.meta[key] !== undefined && (!record(value.meta[key]) || !isJsonValue(value.meta[key]))) {
        add("error", `meta.${key}`, `$.meta.${key}`, `${key} must be a JSON object`);
      }
    }
  }
  if (typeof value.entrySceneId !== "string" || !value.entrySceneId.trim()) {
    add("error", "scene.entry", "$.entrySceneId", "Entry scene ID must be a non-empty string");
  }
  for (const key of ["assets", "runtime", "storyFields", "extensions"] as const) {
    if (!record(value[key]) || !isJsonValue(value[key])) {
      add("error", `project.${key}`, `$.${key}`, `${key} must be a JSON object`);
    }
  }

  const assets = record(value.assets) ? value.assets : {};
  const resources = {
    backgrounds: resourceRegistry(assets.backgrounds, "background"),
    stills: resourceRegistry(assets.stills, "still"),
    frames: resourceRegistry(assets.frames, "frame"),
    effects: resourceRegistry(assets.effects, "effect"),
    sounds: resourceRegistry(assets.sounds, "sound"),
    videos: resourceRegistry(assets.videos, "video"),
    live2d: resourceRegistry(assets.live2d, "live2d"),
  };

  const checkResource = (
    reference: unknown,
    values: Map<string, Record<string, unknown>> | Record<string, unknown>,
    path: string,
    kind: string,
  ): Record<string, unknown> | undefined => {
    const key = typeof reference === "string" || typeof reference === "number" ? String(reference) : "";
    if (!key) return undefined;
    const candidate = values instanceof Map ? values.get(key) : values[key];
    const entry = record(candidate) ? candidate : undefined;
    if (!entry) add("warning", "resource.missing", path, `${kind} resource '${key}' is not in this project`);
    return entry;
  };

  const soundCategory = (sound: Record<string, unknown>): "Bgm" | "Se" | "Voice" | "" => {
    const name = String(sound.categoryName || "");
    if (name === "Bgm" || name === "Se" || name === "Voice") return name;
    const category = Number(sound.category);
    return category === 0 ? "Bgm" : category === 1 ? "Se" : category === 2 ? "Voice" : "";
  };

  if (!Array.isArray(value.scenes) || !value.scenes.length) {
    add("error", "scene.missing", "$.scenes", "A story project needs at least one scene");
    return { valid: false, errors, warnings };
  }

  const sceneIds = new Set<string>();
  const objectIds = new Map<string, string>();
  const useId = (id: unknown, path: string): void => {
    if (typeof id !== "string" || !id.trim()) {
      add("error", "id.invalid", path, "ID must be a non-empty string");
      return;
    }
    const previous = objectIds.get(id);
    if (previous) add("error", "id.duplicate", path, `ID is already used at ${previous}`);
    else objectIds.set(id, path);
  };

  for (const [sceneIndex, scene] of value.scenes.entries()) {
    const scenePath = `$.scenes[${sceneIndex}]`;
    if (!record(scene)) {
      add("error", "scene.type", scenePath, "Scene must be an object");
      continue;
    }
    useId(scene.id, `${scenePath}.id`);
    if (typeof scene.id === "string") sceneIds.add(scene.id);
    if (typeof scene.name !== "string") add("error", "scene.name", `${scenePath}.name`, "Scene name must be a string");
    if (!record(scene.extensions) || !isJsonValue(scene.extensions)) {
      add("error", "scene.extensions", `${scenePath}.extensions`, "Scene extensions must be a JSON object");
    }
    if (!Array.isArray(scene.commands)) {
      add("error", "commands.type", `${scenePath}.commands`, "Commands must be an array");
      continue;
    }
    const labels = new Set<string>();
    for (const command of scene.commands) {
      if (!record(command) || !record(command.fields)) continue;
      const key = command.fields.key;
      if (typeof key === "string" && key) labels.add(key);
    }
    for (const [commandIndex, command] of scene.commands.entries()) {
      const path = `${scenePath}.commands[${commandIndex}]`;
      if (!record(command)) {
        add("error", "command.type", path, "Command must be an object");
        continue;
      }
      useId(command.id, `${path}.id`);
      if (command.command !== null && (!Number.isSafeInteger(command.command) || (command.command as number) < 0)) {
        add("error", "command.code", `${path}.command`, "Command opcode must be a non-negative integer or null");
      } else if (typeof command.command === "number" && !commandDescriptor(command.command)) {
        add(
          "warning",
          "command.unknown",
          `${path}.command`,
          `Opcode ${command.command} is not in the current command registry`,
        );
      } else if (command.command === null) {
        add(
          "warning",
          "command.unsupportedSource",
          `${path}.command`,
          "Source statement has no Haneoka opcode and is omitted from player compilation",
        );
      }
      if (!record(command.fields) || !isJsonValue(command.fields)) {
        add("error", "command.fields", `${path}.fields`, "Command fields must be a JSON object");
      }
      if (!record(command.extensions) || !isJsonValue(command.extensions)) {
        add("error", "command.extensions", `${path}.extensions`, "Command extensions must be a JSON object");
      }
      if (command.source !== undefined) {
        if (!record(command.source) || !isJsonValue(command.source)) {
          add("error", "command.source", `${path}.source`, "Command source metadata must contain valid JSON data");
        } else if (typeof command.source.format !== "string" || !command.source.format.trim()) {
          add("error", "command.sourceFormat", `${path}.source.format`, "Source format must be a non-empty string");
        } else {
          for (const key of ["compatibility", "fidelity"] as const) {
            if (Object.hasOwn(command.source, key)) {
              add(
                "error",
                "command.sourceDiagnostic",
                `${path}.source.${key}`,
                "Conversion accuracy belongs to import diagnostics, not canonical source metadata",
              );
            }
          }
        }
      }
      if (record(command.fields)) {
        const descriptor = typeof command.command === "number" ? commandDescriptor(command.command) : undefined;
        for (const key of PRIVATE_ADV_FIELD_KEYS) {
          if (Object.hasOwn(command.fields, key)) {
            add(
              "error",
              "command.codecField",
              `${path}.fields.${key}`,
              `${key} is private ADV codec data and is not a canonical command field`,
            );
          }
        }
        if (command.command !== ADV_COMMAND.ChoiceShow && Object.hasOwn(command.fields, "advId")) {
          add(
            "error",
            "command.codecField",
            `${path}.fields.advId`,
            "advId is private ADV codec data for this command",
          );
        }
        const resourceField = descriptor?.fields.find((field) => field.resource !== undefined);
        if (resourceField && Object.hasOwn(command.fields, "targetAssetName")) {
          add(
            "error",
            "command.resourceAlias",
            `${path}.fields.targetAssetName`,
            `Use only the canonical ${resourceField.key} resource field`,
          );
        }
        const hasParameterFade = descriptor?.fields.some(
          (field) => field.key === "fadeDuration" && field.sourceKey === "params" && field.parameterIndex === 0,
        );
        if (hasParameterFade && Object.hasOwn(command.fields, "duration")) {
          add(
            "error",
            "command.fadeDurationAlias",
            `${path}.fields.duration`,
            "Use only params[0] for this command's fade duration",
          );
        }
        for (const field of descriptor?.fields || []) {
          if (!field.required) continue;
          const fieldValue = storyCommandFieldValue(command as unknown as StoryProjectCommand, field);
          const present =
            typeof fieldValue === "string"
              ? Boolean(fieldValue.trim())
              : Array.isArray(fieldValue)
                ? fieldValue.some(
                    (entry) =>
                      entry !== null && entry !== undefined && (typeof entry !== "string" || Boolean(entry.trim())),
                  )
                : fieldValue !== undefined && fieldValue !== null;
          if (!present) {
            add(
              "warning",
              "command.required",
              `${path}.fields.${field.key}`,
              `${field.label} is required before this command can run`,
            );
          }
        }
        const paramsValue = command.fields.params;
        const params = Array.isArray(paramsValue) ? paramsValue : [];
        const branchTarget = command.command === ADV_COMMAND.GoTo ? params[0] : undefined;
        if (typeof branchTarget === "string" && branchTarget && !labels.has(branchTarget)) {
          add(
            "warning",
            "flow.targetMissing",
            `${path}.fields.params`,
            `Branch target '${branchTarget}' is not a command key in this scene`,
          );
        }

        if (command.command === ADV_COMMAND.ChoiceSet) {
          const authoredFields = ["key", "text", "params"].filter((key) =>
            Object.prototype.hasOwnProperty.call(command.fields, key),
          );
          if (authoredFields.length) {
            add(
              "error",
              "flow.choiceSetFields",
              `${path}.fields`,
              `ChoiceSet is a native no-op; remove noncanonical fields: ${authoredFields.join(", ")}`,
            );
          }
        }

        if (command.command === ADV_COMMAND.ChoiceShow) {
          if (!Number.isSafeInteger(command.fields.advId)) {
            add("error", "flow.choiceAdvId", `${path}.fields.advId`, "ChoiceShow Story ID must be an integer");
          }
          const choiceIndex = params[0];
          if (!isInt32(typeof choiceIndex === "string" && choiceIndex.trim() ? Number(choiceIndex) : choiceIndex)) {
            add(
              "error",
              "flow.choiceIndex",
              `${path}.fields.params[0]`,
              "ChoiceShow choice group must be a 32-bit integer",
            );
          }
          const choices = command.fields.choices;
          if (!Array.isArray(choices) || !choices.length) {
            add(
              "error",
              "flow.choicesMissing",
              `${path}.fields.choices`,
              "ChoiceShow requires at least one structured choice",
            );
          } else {
            const choiceValues = new Set<number>();
            for (const [choiceIndexInGroup, choiceValue] of choices.entries()) {
              const choicePath = `${path}.fields.choices[${choiceIndexInGroup}]`;
              if (!record(choiceValue)) {
                add("error", "flow.choiceType", choicePath, "Choice must be an object");
                continue;
              }
              if (Object.hasOwn(choiceValue, "goTo") || Object.hasOwn(choiceValue, "destination")) {
                add("error", "flow.choiceAlias", choicePath, "Choice entries use only the canonical nextKey field");
              }
              if (!isInt32(choiceValue.choiceValue)) {
                add("error", "flow.choiceValue", `${choicePath}.choiceValue`, "choiceValue must be a 32-bit integer");
              } else if (choiceValues.has(choiceValue.choiceValue)) {
                add(
                  "error",
                  "flow.choiceValueDuplicate",
                  `${choicePath}.choiceValue`,
                  `choiceValue ${choiceValue.choiceValue} is duplicated in this group`,
                );
              } else {
                choiceValues.add(choiceValue.choiceValue);
              }
              if (!hasLocalizedText(choiceValue.text)) {
                add("error", "flow.choiceText", `${choicePath}.text`, "Choice text must not be empty");
              }
              if (choiceValue.textId !== undefined && typeof choiceValue.textId !== "string") {
                add("error", "flow.choiceTextId", `${choicePath}.textId`, "textId must be a string when present");
              }
              const nextKey = choiceValue.nextKey;
              if (typeof nextKey !== "string" || !nextKey) {
                add("error", "flow.choiceTarget", `${choicePath}.nextKey`, "Choice nextKey must be non-empty");
              } else if (!labels.has(nextKey)) {
                add(
                  "warning",
                  "flow.targetMissing",
                  `${choicePath}.nextKey`,
                  `Branch target '${nextKey}' is not a command key in this scene`,
                );
              }
            }
          }
        }

        const resourceChecks: Array<
          [unknown, Map<string, Record<string, unknown>> | Record<string, unknown>, string, string]
        > = [
          [command.fields.backgroundRef, resources.backgrounds, "backgroundRef", "Background"],
          [command.fields.stillRef, resources.stills, "stillRef", "Still"],
          [command.fields.frameRef, resources.frames, "frameRef", "Frame"],
          [command.fields.effectRef, resources.effects, "effectRef", "Effect"],
          [command.fields.videoRef, resources.videos, "videoRef", "Video"],
          [command.fields.live2dKey, resources.live2d, "live2dKey", "Character model"],
        ];
        for (const [reference, values, field, kind] of resourceChecks) {
          checkResource(reference, values, `${path}.fields.${field}`, kind);
        }

        const soundReferences =
          command.command === ADV_COMMAND.Bgm
            ? ([[command.fields.bgmRef, "Bgm"]] as const)
            : command.command === ADV_COMMAND.Se
              ? ([[command.fields.seRef, "Se"]] as const)
              : command.command === ADV_COMMAND.Voice
                ? (Array.isArray(command.fields.voiceRefs) ? command.fields.voiceRefs : []).map(
                    (reference) => [reference, "Voice"] as const,
                  )
                : [];
        for (const [reference, expected] of soundReferences) {
          const sound = checkResource(reference, resources.sounds, `${path}.fields`, `${expected} sound`);
          const actual = sound ? soundCategory(sound) : "";
          if (actual && actual !== expected) {
            add(
              "warning",
              "audio.roleMismatch",
              `${path}.fields`,
              `${expected} command references a ${actual} sound; playback volume would use the wrong channel`,
            );
          }
        }
      }
    }
  }
  if (typeof value.entrySceneId === "string" && !sceneIds.has(value.entrySceneId)) {
    add("error", "scene.entryMissing", "$.entrySceneId", "Entry scene does not exist");
  }
  return { valid: errors.length === 0, errors, warnings };
};

export class StoryProjectValidationError extends TypeError {
  readonly issues: StoryValidationIssue[];
  constructor(issues: StoryValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") || "Invalid story project");
    this.name = "StoryProjectValidationError";
    this.issues = issues;
  }
}

export function assertValidStoryProject(value: unknown): asserts value is StoryProject {
  const result = validateStoryProject(value);
  if (!result.valid) throw new StoryProjectValidationError(result.errors);
}
