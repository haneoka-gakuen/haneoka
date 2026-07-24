import { commandDescriptor, storyTargetNameFromEditor } from "../commands.js";
import { compileStoryProject } from "../compile.js";
import {
  STORY_PROJECT_VERSION,
  cloneStoryValue,
  findStoryScene,
  importedStoryId,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
} from "../model.js";
import { assertValidStoryProject } from "../validation.js";
import { isJsonObject, jsonClone, jsonInput, stringifyStoryJson, type StoryImportResult } from "./shared.js";
import type { StoryJsonSerializeOptions } from "./project-json.js";

export interface ImportAdvStoryOptions {
  title?: string;
  sceneId?: string;
  sceneName?: string;
  releaseServer?: string;
  provenance?: JsonObject;
}

const asObject = (value: unknown, path: string): JsonObject => {
  if (!isJsonObject(value)) throw new TypeError(`${path} must be a JSON object`);
  return jsonClone(value, path);
};

const EPISODE_ROW_FIELDS = [
  ["_advID", "advId"],
  ["_targetName", "targetName"],
  ["_targetAssetName", "targetAssetName"],
  ["_targetAssetIndex", "targetAssetIndex"],
  ["_targetStatus", "targetStatus"],
  ["_targetTextIDs", "targetTextIds"],
  ["_targetTextColors", "targetTextColors"],
  ["_targetChatID", "targetChatID"],
  ["_cameraDistance", "cameraDistance"],
  ["_positionType", "positionType"],
  ["_motionWait", "motionWait"],
  ["_motionName", "motionName"],
  ["_expressionName", "expressionName"],
  ["_motionFadeIn", "motionFadeIn"],
  ["_advTextID", "advTextId"],
  ["_canvasLayers", "canvasLayers"],
  ["_duration", "duration"],
  ["_delaySeconds", "delaySeconds"],
  ["_isNoWait", "noWait"],
  ["_ignoreLipSync", "ignoreLipSync"],
  ["_voiceIDs", "voiceIds"],
  ["_bgmID", "bgmId"],
  ["_seID", "seId"],
  ["_videoID", "videoId"],
  ["_key", "key"],
  ["_ignoreData", "ignoreData"],
] as const;

const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const commandResourceProjection = (code: number) =>
  commandDescriptor(code)?.fields.find((field) => field.resource !== undefined);

const hasCanonicalParameterFade = (code: number): boolean =>
  commandDescriptor(code)?.fields.some(
    (field) => field.key === "fadeDuration" && field.sourceKey === "params" && field.parameterIndex === 0,
  ) === true;

const hasAuthoredValue = (value: JsonValue | undefined): boolean =>
  value !== undefined && value !== null && value !== "";

const parameterValue = (value: JsonValue): JsonValue =>
  typeof value === "number" || typeof value === "boolean" ? String(value) : cloneStoryValue(value);

/** Convert one external ADV command to the sole authoring schema. */
const canonicalAdvFields = (code: number | null, input: JsonObject): JsonObject => {
  const fields = cloneStoryValue(input);
  if (code === null) return fields;

  const resource = commandResourceProjection(code);
  if (resource) {
    const nativeValue = fields.targetAssetName;
    if (!hasAuthoredValue(fields[resource.key]) && hasAuthoredValue(nativeValue)) {
      fields[resource.key] =
        resource.kind === "resource-list" ? [cloneStoryValue(nativeValue!)] : cloneStoryValue(nativeValue!);
    }
    delete fields.targetAssetName;
  }

  if (hasCanonicalParameterFade(code) && own(fields, "duration")) {
    const params = Array.isArray(fields.params) ? [...fields.params] : [];
    const primary = params[0];
    const primaryNumber = typeof primary === "number" || typeof primary === "string" ? Number(primary) : Number.NaN;
    if (!(Number.isFinite(primaryNumber) && primaryNumber > 0) && fields.duration !== undefined) {
      params[0] = parameterValue(fields.duration);
    }
    while (params.length && params.at(-1) === "") params.pop();
    if (params.length) fields.params = params;
    else delete fields.params;
    delete fields.duration;
  }
  return fields;
};

const canonicalResourceValue = (command: StoryProjectCommand): JsonValue | undefined => {
  if (command.command === null) return undefined;
  const projection = commandResourceProjection(command.command);
  if (!projection) return undefined;
  const value = command.fields[projection.key];
  const current = projection.kind === "resource-list" ? (Array.isArray(value) ? value[0] : undefined) : value;
  const resolution = command.extensions.advResourceProjection;
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) return current;
  if (resolution.field !== projection.key || resolution.nativeReference === undefined) return current;
  if (stringifyStoryJson(current ?? null, false) !== stringifyStoryJson(resolution.resolvedReference ?? null, false)) {
    return current;
  }
  return cloneStoryValue(resolution.nativeReference);
};

const resourceValuePresent = (value: JsonValue | undefined): boolean =>
  Array.isArray(value)
    ? value.some((entry) => entry !== null && entry !== undefined && String(entry).trim() !== "")
    : value !== null && value !== undefined && String(value).trim() !== "";

const projectedResourceValue = (
  value: JsonValue | undefined,
  projection: NonNullable<ReturnType<typeof commandResourceProjection>>,
): JsonValue | undefined => (projection.kind === "resource-list" && Array.isArray(value) ? value[0] : value);

/**
 * Reconcile an exact Episode-table command with the richer command projection
 * emitted by the story catalogue. Episode rows contain native asset paths but
 * not the asset registry identities used by editor validation and playback.
 * Keep the native path in a sidecar for exact export while authoring against
 * the catalogue identity.
 */
export const reconcileAdvEpisodeCommandWithCatalog = (
  command: StoryProjectCommand,
  catalogCommand: StoryProjectCommand,
): StoryProjectCommand => {
  const fields = { ...cloneStoryValue(catalogCommand.fields), ...cloneStoryValue(command.fields) };
  const extensions = cloneStoryValue(command.extensions);
  const projection = command.command === null ? undefined : commandResourceProjection(command.command);
  if (!projection) return { ...cloneStoryValue(command), fields, extensions };

  const nativeValue = command.fields[projection.key];
  const resolvedValue = catalogCommand.fields[projection.key];
  if (!resourceValuePresent(resolvedValue)) return { ...cloneStoryValue(command), fields, extensions };

  fields[projection.key] = cloneStoryValue(resolvedValue!);
  const nativeReference = projectedResourceValue(nativeValue, projection);
  const resolvedReference = projectedResourceValue(resolvedValue, projection);
  if (
    resourceValuePresent(nativeReference) &&
    stringifyStoryJson(nativeReference!, false) !== stringifyStoryJson(resolvedReference!, false)
  ) {
    extensions.advResourceProjection = {
      field: projection.key,
      nativeReference: cloneStoryValue(nativeReference!),
      resolvedReference: cloneStoryValue(resolvedReference!),
    };
  } else {
    delete extensions.advResourceProjection;
  }
  return { ...cloneStoryValue(command), fields, extensions };
};

/**
 * Source identifiers are codec input, not authoring fields.  The normalized
 * catalogue already carries their semantic projections (`text`, resource
 * refs, resolved target names and chat assets).  Keep the identifiers in a
 * private command sidecar so native ADV export remains exact without exposing
 * implementation IDs in the visual or project-JSON editors.
 */
export const ADV_CODEC_FIELD_KEYS = Object.freeze([
  "advId",
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

const splitAdvCodecFields = (value: JsonObject): { fields: JsonObject; codecFields: JsonObject } => {
  const fields = cloneStoryValue(value);
  const codecFields: JsonObject = {};
  for (const key of ADV_CODEC_FIELD_KEYS) {
    if (!own(fields, key)) continue;
    codecFields[key] = cloneStoryValue(fields[key]!);
    delete fields[key];
  }
  return { fields, codecFields };
};

const advCodecFields = (command: StoryProjectCommand): JsonObject => {
  const codec = command.extensions.advCodec;
  if (!codec || typeof codec !== "object" || Array.isArray(codec)) return {};
  const fields = codec.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};
};

const withAdvCodecFields = (extensions: JsonObject, fields: JsonObject): JsonObject => {
  if (!Object.keys(fields).length) return extensions;
  const codec = extensions.advCodec;
  return {
    ...extensions,
    advCodec: {
      ...(codec && typeof codec === "object" && !Array.isArray(codec) ? cloneStoryValue(codec) : {}),
      fields: cloneStoryValue(fields),
    },
  };
};

export const isAdvEpisodeTableJson = (value: unknown): value is JsonObject =>
  isJsonObject(value) && Array.isArray(value._allData) && !Array.isArray(value.commands);

const normalizeEpisodeRow = (row: JsonObject): JsonObject => {
  const command: JsonObject = {};
  if (own(row, "_index")) command.index = cloneStoryValue(row._index!);
  if (own(row, "_command")) command.command = cloneStoryValue(row._command!);
  for (const [rawKey, fieldKey] of EPISODE_ROW_FIELDS) {
    if (own(row, rawKey)) command[fieldKey] = cloneStoryValue(row[rawKey]!);
  }
  if ([1, 2, 3, 4].some((index) => own(row, `_parameter${index}`))) {
    command.params = [1, 2, 3, 4].map((index) => {
      const key = `_parameter${index}`;
      return own(row, key) ? cloneStoryValue(row[key]!) : "";
    });
  }
  return command;
};

const parseNormalizedAdvStoryJson = (root: JsonObject, options: ImportAdvStoryOptions): StoryProject => {
  const rawCommands = root.commands;
  if (!Array.isArray(rawCommands)) throw new TypeError("AdvStory.commands must be an array");
  const commands: StoryProjectCommand[] = rawCommands.map((value, sourceIndex) => {
    if (!isJsonObject(value)) throw new TypeError(`AdvStory.commands[${sourceIndex}] must be a JSON object`);
    const raw = jsonClone(value, `AdvStory.commands[${sourceIndex}]`);
    const rawCommand = raw.command;
    const code =
      typeof rawCommand === "number" && Number.isSafeInteger(rawCommand) && rawCommand >= 0 ? rawCommand : null;
    const commandPresent = Object.prototype.hasOwnProperty.call(raw, "command");
    const indexPresent = Object.prototype.hasOwnProperty.call(raw, "index");
    const { command: _command, index, ...rawFields } = raw;
    const { fields: externalFields, codecFields } = splitAdvCodecFields(rawFields);
    const fields = canonicalAdvFields(code, externalFields);
    let extensions: JsonObject = { advCommandPresent: commandPresent, advIndexPresent: indexPresent };
    if (index !== undefined) extensions.advIndex = index;
    if (commandPresent && code === null && rawCommand !== undefined) extensions.rawCommand = rawCommand;
    extensions = withAdvCodecFields(extensions, codecFields);
    return {
      id: importedStoryId("adv", sourceIndex, typeof index === "number" ? index : sourceIndex),
      command: code,
      fields,
      source: { format: "adv-json" },
      extensions,
    };
  });
  const sceneId = options.sceneId ?? "scene-main";
  const assetsPresent = Object.prototype.hasOwnProperty.call(root, "assets");
  const runtimePresent = Object.prototype.hasOwnProperty.call(root, "runtime");
  const assets = root.assets === undefined ? {} : asObject(root.assets, "AdvStory.assets");
  const runtime = root.runtime === undefined ? {} : asObject(root.runtime, "AdvStory.runtime");
  const { commands: _commands, assets: _assets, runtime: _runtime, ...storyFields } = root;
  const inferredTitle = typeof root.title === "string" ? root.title : "";
  const project: StoryProject = {
    version: STORY_PROJECT_VERSION,
    meta: {
      title: options.title ?? inferredTitle,
      ...(options.releaseServer === undefined ? {} : { releaseServer: options.releaseServer }),
      ...(options.provenance === undefined ? {} : { provenance: cloneStoryValue(options.provenance) }),
    },
    entrySceneId: sceneId,
    scenes: [
      { id: sceneId, name: options.sceneName ?? options.title ?? (inferredTitle || "Main"), commands, extensions: {} },
    ],
    assets,
    runtime,
    storyFields,
    extensions: { source: { format: "adv-json", assetsPresent, runtimePresent } },
  };
  assertValidStoryProject(project);
  return project;
};

const parseAdvEpisodeTableRoot = (root: JsonObject, options: ImportAdvStoryOptions): StoryProject => {
  const rawRows = root._allData;
  if (!Array.isArray(rawRows)) throw new TypeError("Adv Episode table._allData must be an array");
  const rows = rawRows.map((value, index) => asObject(value, `Adv Episode table._allData[${index}]`));
  const project = parseNormalizedAdvStoryJson({ commands: rows.map(normalizeEpisodeRow) }, options);
  const { _header: header, _allData: _rows, ...rootFields } = root;
  project.extensions = {
    ...project.extensions,
    source: {
      format: "adv-json",
      container: "episode-table",
      assetsPresent: false,
      runtimePresent: false,
    },
    advEpisodeTable: {
      headerPresent: own(root, "_header"),
      ...(header === undefined ? {} : { header: cloneStoryValue(header) }),
      rootFields: cloneStoryValue(rootFields),
    },
  };
  for (const [index, command] of project.scenes[0]!.commands.entries()) {
    command.extensions.advEpisodeRow = cloneStoryValue(rows[index]!);
  }
  assertValidStoryProject(project);
  return project;
};

export const parseAdvEpisodeJson = (
  input: string | Uint8Array | unknown,
  options: ImportAdvStoryOptions = {},
): StoryProject => {
  const root = asObject(jsonInput(input, "Adv Episode table"), "Adv Episode table");
  if (!isAdvEpisodeTableJson(root)) throw new TypeError("Adv Episode table._allData must be an array");
  return parseAdvEpisodeTableRoot(root, options);
};

export const parseAdvStoryJson = (
  input: string | Uint8Array | unknown,
  options: ImportAdvStoryOptions = {},
): StoryProject => {
  const root = asObject(jsonInput(input, "AdvStory"), "AdvStory");
  return isAdvEpisodeTableJson(root)
    ? parseAdvEpisodeTableRoot(root, options)
    : parseNormalizedAdvStoryJson(root, options);
};

export const importAdvStoryJson = (
  input: string | Uint8Array | unknown,
  options: ImportAdvStoryOptions = {},
): StoryImportResult => ({ format: "adv-json", project: parseAdvStoryJson(input, options), diagnostics: [] });

export const importAdvEpisodeJson = (
  input: string | Uint8Array | unknown,
  options: ImportAdvStoryOptions = {},
): StoryImportResult => ({ format: "adv-json", project: parseAdvEpisodeJson(input, options), diagnostics: [] });

const episodeTableMetadata = (project: StoryProject): JsonObject | undefined => {
  const source = project.extensions.source;
  const metadata = project.extensions.advEpisodeTable;
  return source &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    source.container === "episode-table" &&
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
    ? metadata
    : undefined;
};

const episodeRowFromCommand = (command: StoryProjectCommand, fallbackIndex: number): JsonObject => {
  const stored = command.extensions.advEpisodeRow;
  const storedRow: JsonObject | undefined =
    stored && typeof stored === "object" && !Array.isArray(stored) ? stored : undefined;
  const row: JsonObject = storedRow ? cloneStoryValue(storedRow) : {};

  const imported = command.source?.format === "adv-json";
  if (!imported || command.extensions.advIndexPresent !== false) {
    row._index =
      imported && command.extensions.advIndex !== undefined
        ? cloneStoryValue(command.extensions.advIndex)
        : fallbackIndex;
  } else {
    delete row._index;
  }

  if (!imported || command.extensions.advCommandPresent !== false) {
    const rawCommand = command.command === null ? command.extensions.rawCommand : command.command;
    if (rawCommand !== undefined) row._command = cloneStoryValue(rawCommand);
    else delete row._command;
  } else {
    delete row._command;
  }

  for (const [rawKey, fieldKey] of EPISODE_ROW_FIELDS) {
    const canonicalValue = fieldKey === "targetAssetName" ? canonicalResourceValue(command) : undefined;
    const value =
      canonicalValue !== undefined
        ? canonicalValue
        : own(command.fields, fieldKey)
          ? command.fields[fieldKey]
          : advCodecFields(command)[fieldKey];
    if (value === undefined) delete row[rawKey];
    else row[rawKey] = fieldKey === "targetName" ? storyTargetNameFromEditor(value) : cloneStoryValue(value);
  }
  const params = command.fields.params;
  for (const index of [1, 2, 3, 4]) {
    const rawKey = `_parameter${index}`;
    const current = Array.isArray(params) && index <= params.length ? params[index - 1] : undefined;
    const originalPresent = storedRow ? own(storedRow, rawKey) : false;
    const original: JsonValue = originalPresent ? storedRow![rawKey]! : "";
    const changed = current !== undefined && stringifyStoryJson(current, false) !== stringifyStoryJson(original, false);
    if (current !== undefined && (!imported || originalPresent || changed)) row[rawKey] = cloneStoryValue(current);
    else delete row[rawKey];
  }
  return row;
};

const episodeFieldKeys = new Set<string>([...EPISODE_ROW_FIELDS.map(([, fieldKey]) => fieldKey), "params"]);

const externalAdvFields = (command: StoryProjectCommand): JsonObject => {
  const fields = { ...cloneStoryValue(advCodecFields(command)), ...cloneStoryValue(command.fields) };
  if (command.command === null) return fields;
  const projection = commandResourceProjection(command.command);
  if (!projection) return fields;
  const nativeValue = canonicalResourceValue(command);
  if (nativeValue !== undefined) fields.targetAssetName = cloneStoryValue(nativeValue);
  else delete fields.targetAssetName;
  delete fields[projection.key];
  return fields;
};

const normalizedCommandValue = (command: StoryProjectCommand): JsonObject => {
  const value: JsonObject = {};
  const imported = command.source?.format === "adv-json";
  if (imported && command.extensions.advIndexPresent !== false && command.extensions.advIndex !== undefined) {
    value.index = cloneStoryValue(command.extensions.advIndex);
  }
  if (!imported || command.extensions.advCommandPresent !== false) {
    value.command =
      imported && command.command === null && own(command.extensions, "rawCommand")
        ? cloneStoryValue(command.extensions.rawCommand!)
        : command.command;
  }
  Object.assign(value, externalAdvFields(command));
  return value;
};

const replaceNormalizedCommandValue = (command: StoryProjectCommand, value: JsonObject): StoryProjectCommand => {
  const imported = command.source?.format === "adv-json";
  const commandPresent = own(value, "command");
  const indexPresent = own(value, "index");
  const rawCommand = value.command;
  const code =
    typeof rawCommand === "number" && Number.isSafeInteger(rawCommand) && rawCommand >= 0 ? rawCommand : null;
  if (!imported && (!commandPresent || code === null)) {
    throw new TypeError("Authored story commands require a non-negative integer command code");
  }
  if (!imported && indexPresent) throw new TypeError("Only imported ADV commands have a source index");
  const { command: _command, index: _index, ...rawFields } = cloneStoryValue(value);
  const { fields: externalFields, codecFields } = splitAdvCodecFields(rawFields);
  const fields = canonicalAdvFields(code, externalFields);
  let extensions = cloneStoryValue(command.extensions);
  if (imported) {
    extensions.advCommandPresent = commandPresent;
    if (commandPresent && code === null) extensions.rawCommand = cloneStoryValue(rawCommand!);
    else delete extensions.rawCommand;
    extensions.advIndexPresent = indexPresent;
    if (indexPresent) extensions.advIndex = cloneStoryValue(value.index!);
    else delete extensions.advIndex;
  }
  delete extensions.advResourceProjection;
  if (Object.keys(codecFields).length) {
    extensions = withAdvCodecFields(extensions, { ...advCodecFields(command), ...codecFields });
  }
  return { ...cloneStoryValue(command), command: code, fields, extensions };
};

/**
 * Exact command object shown by the visual editor's advanced JSON control.
 * Episode imports use their original underscored row so future columns remain
 * visible and editable; normalized ADV imports use `index`/`command`/fields.
 */
export const storyCommandNativeValue = (command: StoryProjectCommand, fallbackIndex = 0): JsonObject => {
  const row = command.extensions.advEpisodeRow;
  return row && typeof row === "object" && !Array.isArray(row)
    ? episodeRowFromCommand(command, fallbackIndex)
    : normalizedCommandValue(command);
};

/** Replace the visual editor's exact native command object without touching editor identity or unrelated metadata. */
export const replaceStoryCommandNativeValue = (
  command: StoryProjectCommand,
  value: JsonObject,
): StoryProjectCommand => {
  const row = command.extensions.advEpisodeRow;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return replaceNormalizedCommandValue(command, value);
  }
  const nativeRow = cloneStoryValue(value);
  const normalized = normalizeEpisodeRow(nativeRow);
  const { command: rawCommand, index, ...rawNormalizedFields } = normalized;
  const { fields: externalFields, codecFields } = splitAdvCodecFields(rawNormalizedFields);
  const normalizedFields = canonicalAdvFields(
    typeof rawCommand === "number" && Number.isSafeInteger(rawCommand) && rawCommand >= 0 ? rawCommand : null,
    externalFields,
  );
  const fields = Object.fromEntries(
    Object.entries(command.fields).filter(([key]) => !episodeFieldKeys.has(key)),
  ) as JsonObject;
  Object.assign(fields, normalizedFields);
  const envelope: JsonObject = {
    ...(own(normalized, "index") ? { index: cloneStoryValue(index!) } : {}),
    ...(own(normalized, "command") ? { command: cloneStoryValue(rawCommand!) } : {}),
    ...fields,
  };
  const replaced = replaceNormalizedCommandValue(command, envelope);
  replaced.extensions.advEpisodeRow = nativeRow;
  if (Object.keys(codecFields).length) {
    replaced.extensions = withAdvCodecFields(replaced.extensions, {
      ...advCodecFields(command),
      ...codecFields,
    });
  }
  return replaced;
};

/** Private identifiers restored only for player/native ADV compilation. */
export const storyCommandAdvCodecFields = (command: StoryProjectCommand): JsonObject =>
  cloneStoryValue(advCodecFields(command));

export interface SerializeAdvStoryOptions extends StoryJsonSerializeOptions {
  sceneId?: string;
  /** Set false to export the normalized player payload instead of an imported Episode table container. */
  preserveSourceContainer?: boolean;
}

export const serializeAdvEpisodeJson = (project: StoryProject, options: SerializeAdvStoryOptions = {}): string => {
  assertValidStoryProject(project);
  const metadata = episodeTableMetadata(project);
  if (!metadata) throw new TypeError("Story project was not imported from an Adv Episode table");
  const sceneId = options.sceneId ?? project.entrySceneId;
  const scene = findStoryScene(project, sceneId);
  if (!scene) throw new RangeError(`Story scene '${sceneId}' does not exist`);
  const storedRoot = metadata.rootFields;
  const root: JsonObject =
    storedRoot && typeof storedRoot === "object" && !Array.isArray(storedRoot) ? cloneStoryValue(storedRoot) : {};
  if (metadata.headerPresent === true && metadata.header !== undefined) {
    root._header = cloneStoryValue(metadata.header);
  } else {
    delete root._header;
  }
  root._allData = scene.commands.map(episodeRowFromCommand);
  return stringifyStoryJson(root, options.pretty !== false);
};

export const serializeAdvStoryJson = (project: StoryProject, options: SerializeAdvStoryOptions = {}): string => {
  if (options.preserveSourceContainer !== false && episodeTableMetadata(project)) {
    return serializeAdvEpisodeJson(project, options);
  }
  return stringifyStoryJson(
    compileStoryProject(project, options.sceneId ?? project.entrySceneId) as JsonValue,
    options.pretty !== false,
  );
};
