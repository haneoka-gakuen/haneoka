import { ADV_COMMAND, commandDescriptor, storyTargetNameFromEditor, storyTargetNames } from "./commands.js";
import { storyDiagnostic, type StoryDiagnostic } from "./diagnostics.js";
import { cloneStoryValue, findStoryScene, type JsonObject, type StoryProject } from "./model.js";
import { assertValidStoryProject } from "./validation.js";

const commandCodecFields = (command: StoryProject["scenes"][number]["commands"][number]): JsonObject => {
  const codec = command.extensions.advCodec;
  if (!codec || typeof codec !== "object" || Array.isArray(codec)) return {};
  const fields = codec.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? cloneStoryValue(fields) : {};
};

export interface CompiledAdvStory extends JsonObject {
  commands: JsonObject[];
}

export interface CompileStoryResult {
  story: CompiledAdvStory;
  diagnostics: StoryDiagnostic[];
  sceneId: string;
  /** Source-scene index for every command retained in `story.commands`. */
  commandSourceIndexes: number[];
}

const hasAuthoredText = (value: unknown): boolean => {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && Boolean(entry.trim()));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => typeof entry === "string" && Boolean(entry.trim()));
};

const compileCommandFields = (command: StoryProject["scenes"][number]["commands"][number]): JsonObject => {
  const fields = { ...commandCodecFields(command), ...cloneStoryValue(command.fields) };
  if (command.command === ADV_COMMAND.Talk && typeof fields.targetName === "string") {
    const names = storyTargetNames(fields.targetName);
    fields.targetName = storyTargetNameFromEditor(fields.targetName);
    const currentTargets = Array.isArray(fields.targets)
      ? fields.targets.filter((target): target is JsonObject =>
          Boolean(target && typeof target === "object" && !Array.isArray(target)),
        )
      : [];
    fields.targets = names.map((target, index) => {
      const matched =
        currentTargets.find((entry) => String(entry.target || "") === target) || currentTargets[index] || {};
      return { ...cloneStoryValue(matched), target };
    });
  }
  const authored = command.source?.format !== "adv-json";
  // Imported Adv commands are already in the player's native shape. Applying
  // authoring conveniences here would mutate untouched source data on export.
  if (!authored) return fields;
  if (
    (command.command === ADV_COMMAND.Talk ||
      command.command === ADV_COMMAND.Location ||
      command.command === ADV_COMMAND.Subtitles) &&
    hasAuthoredText(fields.text) &&
    !String(fields.advTextId ?? "").trim()
  ) {
    fields.advTextId = "haneoka-editor";
  }
  if (
    command.command === ADV_COMMAND.Delay &&
    typeof fields.duration !== "number" &&
    typeof fields.delaySeconds === "number"
  ) {
    fields.duration = fields.delaySeconds;
  }
  if (command.command === ADV_COMMAND.Still && typeof fields.duration === "number") {
    const params = Array.isArray(fields.params) ? [...fields.params] : [];
    params[0] = fields.duration;
    fields.params = params;
  }
  if (
    command.command === ADV_COMMAND.Effect &&
    !String(fields.targetName ?? "").trim() &&
    String(fields.targetAssetName ?? "").trim()
  ) {
    fields.targetName = String(fields.targetAssetName);
  }
  return fields;
};

const compileCommandIndex = (command: StoryProject["scenes"][number]["commands"][number], fallback: number) =>
  command.source?.format === "adv-json" && command.extensions.advIndex !== undefined
    ? cloneStoryValue(command.extensions.advIndex)
    : fallback;

const importedAdvSource = (project: StoryProject): JsonObject | undefined => {
  const source = project.extensions.source;
  return source && typeof source === "object" && !Array.isArray(source) && source.format === "adv-json"
    ? source
    : undefined;
};

const nonEmpty = (value: JsonObject): boolean => Object.keys(value).length > 0;

/** Compile one scene into the same open JSON shape consumed by `@haneoka/story`. */
export const compileStoryProjectWithDiagnostics = (
  project: StoryProject,
  sceneId = project.entrySceneId,
): CompileStoryResult => {
  assertValidStoryProject(project);
  const scene = findStoryScene(project, sceneId);
  if (!scene) throw new RangeError(`Story scene '${sceneId}' does not exist`);
  const diagnostics: StoryDiagnostic[] = [];
  const commands: JsonObject[] = [];
  const commandSourceIndexes: number[] = [];
  for (const [sourceIndex, command] of scene.commands.entries()) {
    if (command.command === null) {
      const rawAdvCommand = command.source?.format === "adv-json" ? command.extensions.rawCommand : undefined;
      const commandPresent = command.extensions.advCommandPresent !== false;
      if (rawAdvCommand !== undefined || (command.source?.format === "adv-json" && !commandPresent)) {
        const compiledCommand: JsonObject = {
          ...commandCodecFields(command),
          ...cloneStoryValue(command.fields),
        };
        if (commandPresent && rawAdvCommand !== undefined) {
          compiledCommand.command = cloneStoryValue(rawAdvCommand);
        }
        if (command.extensions.advIndexPresent !== false) {
          compiledCommand.index = compileCommandIndex(command, commands.length);
        }
        commands.push(compiledCommand);
        commandSourceIndexes.push(sourceIndex);
        diagnostics.push(
          storyDiagnostic(
            "warning",
            "compile.rawAdvOpcode",
            `$.scenes[${project.scenes.indexOf(scene)}].commands[${sourceIndex}].extensions.rawCommand`,
            "Non-numeric AdvStory command value was retained verbatim for exact source round trips",
            "unsupported",
          ),
        );
        continue;
      }
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "compile.unsupportedSource",
          `$.scenes[${project.scenes.indexOf(scene)}].commands[${sourceIndex}]`,
          `The ${command.source?.command || "source"} statement cannot run in the Haneoka player`,
          "unsupported",
          command.source?.line,
        ),
      );
      continue;
    }
    if (!commandDescriptor(command.command)) {
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "compile.unknownOpcode",
          `$.scenes[${project.scenes.indexOf(scene)}].commands[${sourceIndex}].command`,
          `Unknown opcode ${command.command} is retained but may be ignored by this player`,
          "unsupported",
        ),
      );
    }
    const compiledCommand: JsonObject = {
      ...compileCommandFields(command),
      command: command.command,
    };
    if (command.source?.format !== "adv-json" || command.extensions.advIndexPresent !== false) {
      compiledCommand.index = compileCommandIndex(command, commands.length);
    }
    commands.push(compiledCommand);
    commandSourceIndexes.push(sourceIndex);
  }
  const source = importedAdvSource(project);
  const story: CompiledAdvStory = {
    ...cloneStoryValue(project.storyFields),
    commands,
  };
  if (!source || source.assetsPresent !== false || nonEmpty(project.assets)) {
    story.assets = cloneStoryValue(project.assets);
  }
  if (!source || source.runtimePresent !== false || nonEmpty(project.runtime)) {
    story.runtime = cloneStoryValue(project.runtime);
  }
  return {
    story,
    diagnostics,
    sceneId: scene.id,
    commandSourceIndexes,
  };
};

export const compileStoryProject = (project: StoryProject, sceneId = project.entrySceneId): CompiledAdvStory =>
  compileStoryProjectWithDiagnostics(project, sceneId).story;
