import {
  ADV_COMMAND,
  ProjectHistory,
  cloneStoryValue,
  compileStoryProjectWithDiagnostics,
  createEmptyStoryProject,
  createStoryCommand,
  createStoryId,
  createWebGalSceneDraft,
  importAdvStoryJson,
  importStoryProjectJson,
  importWebGal,
  mergeWebGalScene,
  reconcileAdvEpisodeCommandWithCatalog,
  reconcileStorySceneCodeDraft,
  serializeStoryProjectJson,
  stringifyStoryJson,
  storyResourceAliases,
  storyTargetNameFromEditor,
  storyTargetNames,
  storyJsonDraftBaseForValue,
  storyJsonDraftConflict,
  validateStoryProject,
  type CommandResourceKind,
  type JsonObject,
  type JsonValue,
  type StoryDiagnostic,
  type StoryJsonDraftBase,
  type StoryProject,
  type StoryProjectCommand,
  type StoryResourceKind,
  type StoryScene,
  type StoryValidationIssue,
  type WebGalSceneEditContext,
} from "@haneoka/story-editor";
import { clearStoryEditorDraft, loadStoryEditorDraft, saveStoryEditorDraft } from "~/utils/storyEditorStorage.client";
import type { StoryEditorResourceInsert } from "~/components/tools/story-editor/StoryEditorResourceLibrary.vue";
import { importRegisteredStoryFile } from "~/features/story/importers";
import { mergeStoryRuntime } from "~/features/story/runtime";

export type StoryEditorView = "visual" | "graph" | "webgal" | "project";
export type StoryEditorStatus =
  "ready" | "autosaved" | "restored" | "imported" | "draftConflict" | "importFailed" | "saveFailed";

const safeFileStem = (value: string): string =>
  value
    .replace(/\.(?:haneoka-story\.)?(?:json|txt)$/i, "")
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ") || "story";

const jsonObjects = (value: JsonValue | undefined): JsonObject[] => {
  if (Array.isArray(value))
    return value.filter((entry): entry is JsonObject =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    );
  if (value && typeof value === "object")
    return Object.values(value).filter((entry): entry is JsonObject =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    );
  return [];
};

const replaceResource = (
  items: JsonObject[],
  value: JsonObject,
  kind: StoryResourceKind,
  authoredReference: string,
) => {
  const identities = new Set([...storyResourceAliases(kind, value), authoredReference].filter(Boolean));
  const index = items.findIndex((item) => storyResourceAliases(kind, item).some((alias) => identities.has(alias)));
  if (index < 0) items.push(cloneStoryValue(value));
  else items[index] = cloneStoryValue(value);
};

const normalizeIssue = (issue: StoryDiagnostic): StoryValidationIssue => ({
  severity: issue.severity === "error" ? "error" : "warning",
  code: issue.code,
  path: issue.path,
  message: issue.message,
});

type InsertableStoryResource = Exclude<StoryEditorResourceInsert, { kind: "story" }>;

const commandForResource = (resource: InsertableStoryResource): StoryProjectCommand => {
  if (resource.kind === "live2d") {
    return createStoryCommand(ADV_COMMAND.Character, {
      targetName: String(resource.value.characterKey || resource.value.live2dKey || resource.key),
      live2dKey: resource.key,
      targetAssetIndex: 0,
      positionType: 5,
    });
  }
  if (resource.kind === "background") {
    return createStoryCommand(ADV_COMMAND.Stage, {
      backgroundRef: resource.key,
      duration: 0.3,
    });
  }
  if (resource.kind === "still") {
    return createStoryCommand(ADV_COMMAND.Still, {
      stillRef: resource.key,
      duration: 0.3,
    });
  }
  if (resource.kind === "frame") {
    return createStoryCommand(ADV_COMMAND.Frame, {
      frameName: String(resource.value.name || resource.key),
      frameRef: resource.key,
    });
  }
  if (resource.kind === "effect") {
    return createStoryCommand(ADV_COMMAND.Effect, {
      targetName: resource.key,
      effectRef: resource.key,
    });
  }
  if (resource.kind === "post-effect") {
    return createStoryCommand(ADV_COMMAND.PostEffect, {
      postEffectRef: resource.key,
    });
  }
  if (resource.kind === "video") {
    return createStoryCommand(ADV_COMMAND.Movie, {
      videoRef: resource.key,
    });
  }
  if (resource.kind !== "audio") throw new TypeError(`Unsupported story resource: ${resource.kind}`);
  return createStoryCommand(
    resource.usage === "bgm" ? ADV_COMMAND.Bgm : resource.usage === "voice" ? ADV_COMMAND.Voice : ADV_COMMAND.Se,
    {
      ...(resource.usage === "bgm"
        ? { bgmRef: resource.key }
        : resource.usage === "voice"
          ? { voiceRefs: [resource.key] }
          : { seRef: resource.key }),
    },
  );
};

const recordValue = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const registerStoryResource = (draft: StoryProject, resource: InsertableStoryResource) => {
  const importedValue = resource.value as unknown as JsonObject;
  const resourceValue: JsonObject =
    resource.kind === "post-effect" || importedValue.resourceRef
      ? importedValue
      : { ...importedValue, resourceRef: resource.key };
  if (resource.kind === "effect" && resourceValue.runtimeAvailable === false) {
    throw new TypeError(`Effect resource is unavailable: ${resource.key}`);
  }
  if (resource.kind === "live2d") {
    const list = jsonObjects(draft.assets.live2d);
    replaceResource(list, resourceValue, "live2d", resource.key);
    draft.assets.live2d = list;
    return;
  }
  if (resource.kind === "background") {
    const { stage, postEffects, ...background } = resourceValue;
    const list = jsonObjects(draft.assets.backgrounds);
    replaceResource(list, background, "background", resource.key);
    draft.assets.backgrounds = list;
    if (stage && typeof stage === "object" && !Array.isArray(stage)) {
      draft.runtime.stages = {
        ...recordValue(draft.runtime.stages),
        [resource.key]: cloneStoryValue(stage as JsonObject),
      };
    }
    if (postEffects && typeof postEffects === "object" && !Array.isArray(postEffects)) {
      draft.runtime.postEffects = {
        ...recordValue(draft.runtime.postEffects),
        ...cloneStoryValue(postEffects as JsonObject),
      };
    }
    return;
  }
  if (resource.kind === "still") {
    const list = jsonObjects(draft.assets.stills);
    replaceResource(list, resourceValue, "still", resource.key);
    draft.assets.stills = list;
    return;
  }
  if (resource.kind === "frame") {
    const list = jsonObjects(draft.assets.frames);
    replaceResource(list, resourceValue, "frame", resource.key);
    draft.assets.frames = list;
    return;
  }
  if (resource.kind === "effect") {
    const list = jsonObjects(draft.assets.effects);
    replaceResource(list, resourceValue, "effect", resource.key);
    draft.assets.effects = list;
    return;
  }
  if (resource.kind === "post-effect") {
    const profile = resourceValue.profile;
    draft.runtime.postEffects = {
      ...recordValue(draft.runtime.postEffects),
      [resource.key]:
        profile && typeof profile === "object" && !Array.isArray(profile)
          ? cloneStoryValue(profile as JsonObject)
          : cloneStoryValue(resourceValue),
    };
    return;
  }
  if (resource.kind === "video") {
    const list = jsonObjects(draft.assets.videos);
    replaceResource(list, resourceValue, "video", resource.key);
    draft.assets.videos = list;
    return;
  }
  const list = jsonObjects(draft.assets.sounds);
  replaceResource(list, resourceValue, "sound", resource.key);
  draft.assets.sounds = list;
};

const resourceFieldPatch = (resource: InsertableStoryResource): JsonObject => {
  if (resource.kind === "live2d") return { live2dKey: resource.key };
  if (resource.kind === "background") return { backgroundRef: resource.key };
  if (resource.kind === "still") return { stillRef: resource.key };
  if (resource.kind === "frame") return { frameRef: resource.key };
  if (resource.kind === "effect") return { effectRef: resource.key, targetName: resource.key };
  if (resource.kind === "post-effect") return { postEffectRef: resource.key };
  if (resource.kind === "video") return { videoRef: resource.key };
  if (resource.kind !== "audio") throw new TypeError(`Unsupported story resource: ${resource.kind}`);
  if (resource.usage === "bgm") return { bgmRef: resource.key };
  if (resource.usage === "voice") return { voiceRefs: [resource.key] };
  return { seRef: resource.key };
};

const advSourceIndex = (command: StoryProjectCommand): string => {
  const value = command.extensions.advIndex;
  return value === undefined ? "" : `${typeof value}:${String(value)}`;
};

const reconcileEpisodeCommands = (
  sourceCommands: StoryProjectCommand[],
  catalogCommands: readonly StoryProjectCommand[],
) => {
  const catalogByIndex = new Map<string, StoryProjectCommand>();
  for (const command of catalogCommands) {
    const key = advSourceIndex(command);
    if (key && !catalogByIndex.has(key)) catalogByIndex.set(key, command);
  }
  for (const [sourceIndex, command] of sourceCommands.entries()) {
    const key = advSourceIndex(command);
    const indexedCandidate = key ? catalogByIndex.get(key) : undefined;
    const indexed = indexedCandidate?.command === command.command ? indexedCandidate : undefined;
    const positional = catalogCommands[sourceIndex];
    const catalogCommand = indexed || (positional?.command === command.command ? positional : undefined);
    if (!catalogCommand) continue;
    const reconciled = reconcileAdvEpisodeCommandWithCatalog(command, catalogCommand);
    command.fields = reconciled.fields;
    command.extensions = reconciled.extensions;
  }
};

export const useStoryEditorWorkspace = () => {
  const { releaseServer } = useReleaseServer();
  const copy = useLocale().messages("storyEditorPage");
  const initial = createEmptyStoryProject({ releaseServer: releaseServer.value });
  let history = new ProjectHistory<StoryProject>(initial, 200);
  const project = shallowRef<StoryProject>(history.value);
  const currentSceneId = ref(project.value.entrySceneId);
  const selectedCommandId = ref("");
  const revision = ref(0);
  const savedRevision = ref(0);
  const canUndo = ref(false);
  const canRedo = ref(false);
  const saving = ref(false);
  const restored = ref(false);
  const status = ref<StoryEditorStatus>("ready");
  const statusDetail = ref("");
  const formatDiagnostics = shallowRef<StoryDiagnostic[]>([]);
  const codeValue = ref(serializeStoryProjectJson(project.value));
  const codeBaseline = ref(codeValue.value);
  const codeDraftBase = shallowRef<StoryJsonDraftBase>();
  const codeError = ref("");
  const initialSceneCode = createWebGalSceneDraft(project.value, { sceneId: currentSceneId.value });
  const sceneCodeValue = ref(initialSceneCode.text);
  const sceneCodeBaseline = ref(sceneCodeValue.value);
  const sceneCodeContext = shallowRef<WebGalSceneEditContext>(initialSceneCode.context);
  const sceneCodeError = ref("");
  const sceneCodeDrafts = ref<Record<string, string>>({});
  const sceneCodeContexts = shallowRef<Record<string, WebGalSceneEditContext>>({});
  let autosaveTimer: number | undefined;
  let compileTimer: number | undefined;
  let compileGeneration = 0;
  let compiledSceneId = "";
  let generation = 0;
  let disposed = false;

  const refreshHistory = () => {
    canUndo.value = history.canUndo;
    canRedo.value = history.canRedo;
  };

  const syncCode = (preserveDraft = false) => {
    const draft = codeValue.value;
    const hadDraft = codeDirty.value || Boolean(codeDraftBase.value);
    const value = serializeStoryProjectJson(project.value);
    codeBaseline.value = value;
    if (preserveDraft && hadDraft) {
      codeValue.value = draft;
      if (draft === value) codeDraftBase.value = undefined;
    } else {
      codeValue.value = value;
      codeDraftBase.value = undefined;
    }
    codeError.value = "";
  };

  const syncSceneCode = () => {
    const sceneId = currentSceneId.value;
    const baseline = createWebGalSceneDraft(project.value, { sceneId });
    const reconciled = reconcileStorySceneCodeDraft({
      sceneId,
      baseline: baseline.text,
      drafts: sceneCodeDrafts.value,
      contexts: sceneCodeContexts.value,
    });
    sceneCodeDrafts.value = reconciled.drafts;
    sceneCodeContexts.value = reconciled.contexts;
    sceneCodeBaseline.value = baseline.text;
    sceneCodeContext.value = sceneCodeContexts.value[sceneId] ?? baseline.context;
    sceneCodeValue.value = reconciled.value;
    sceneCodeError.value = "";
  };

  const codeDirty = computed(() => codeValue.value !== codeBaseline.value);
  const sceneCodeDirty = computed(() => sceneCodeValue.value !== sceneCodeBaseline.value);
  const sceneCodeDraftIds = computed(() => Object.keys(sceneCodeDrafts.value));
  const hasSceneCodeDrafts = computed(() => Object.keys(sceneCodeDrafts.value).length > 0);
  const dirty = computed(() => revision.value !== savedRevision.value || codeDirty.value || hasSceneCodeDrafts.value);
  const currentScene = computed<StoryScene | undefined>(() =>
    project.value.scenes.find((scene) => scene.id === currentSceneId.value),
  );
  const selectedCommand = computed<StoryProjectCommand | undefined>(() =>
    currentScene.value?.commands.find((command) => command.id === selectedCommandId.value),
  );
  const validation = computed(() => validateStoryProject(project.value));
  type StoryCompilation = ReturnType<typeof compileStoryProjectWithDiagnostics>;
  const compiled = shallowRef<StoryCompilation>();
  const rebuildCompilation = (): StoryCompilation | undefined => {
    if (!validation.value.valid || !currentScene.value) {
      compiled.value = undefined;
      compiledSceneId = currentScene.value?.id || "";
      return undefined;
    }
    try {
      const result = compileStoryProjectWithDiagnostics(project.value, currentScene.value.id);
      compiled.value = result;
      compiledSceneId = currentScene.value.id;
      return result;
    } catch {
      compiled.value = undefined;
      compiledSceneId = currentScene.value?.id || "";
      return undefined;
    }
  };
  const cancelScheduledCompilation = () => {
    compileGeneration += 1;
    if (compileTimer !== undefined && import.meta.client) window.clearTimeout(compileTimer);
    compileTimer = undefined;
  };
  const scheduleCompilation = () => {
    cancelScheduledCompilation();
    if (compiledSceneId && compiledSceneId !== currentSceneId.value) compiled.value = undefined;
    const targetGeneration = compileGeneration;
    if (!import.meta.client) {
      rebuildCompilation();
      return;
    }
    // Compilation is intentionally queued after the current render. Restoring a
    // large Episode can therefore paint its command list before the preview
    // pipeline performs a second full-project traversal.
    compileTimer = window.setTimeout(() => {
      compileTimer = undefined;
      if (disposed || targetGeneration !== compileGeneration) return;
      rebuildCompilation();
    }, 80);
  };
  const compileNow = () => {
    cancelScheduledCompilation();
    return rebuildCompilation();
  };
  const issues = computed<StoryValidationIssue[]>(() => [
    ...validation.value.errors,
    ...validation.value.warnings,
    ...formatDiagnostics.value.map(normalizeIssue),
    ...(compiled.value?.diagnostics || []).map(normalizeIssue),
  ]);
  const commandCount = computed(() => project.value.scenes.reduce((count, scene) => count + scene.commands.length, 0));
  const replaceVisible = (next: StoryProject, changed = true) => {
    project.value = next;
    refreshHistory();
    if (changed) revision.value += 1;
    syncCode(true);
    if (!project.value.scenes.some((scene) => scene.id === currentSceneId.value)) {
      currentSceneId.value = project.value.entrySceneId;
    }
    if (!currentScene.value?.commands.some((command) => command.id === selectedCommandId.value)) {
      selectedCommandId.value = "";
    }
    const sceneIds = new Set(project.value.scenes.map((scene) => scene.id));
    sceneCodeDrafts.value = Object.fromEntries(
      Object.entries(sceneCodeDrafts.value).filter(([sceneId]) => sceneIds.has(sceneId)),
    );
    sceneCodeContexts.value = Object.fromEntries(
      Object.entries(sceneCodeContexts.value).filter(([sceneId]) => sceneIds.has(sceneId)),
    );
    syncSceneCode();
  };

  const updateProject = (
    updater: (draft: StoryProject) => StoryProject | void,
    options: { mergeKey?: string; select?: string } = {},
  ) => {
    const previousRevision = history.revision;
    const next = history.update(updater, options.mergeKey ? { mergeKey: options.mergeKey } : {});
    if (history.revision === previousRevision) return false;
    generation += 1;
    formatDiagnostics.value = [];
    replaceVisible(next);
    if (options.select !== undefined) selectedCommandId.value = options.select;
    return true;
  };

  const resetProject = (
    next: StoryProject,
    changed = true,
    invalidateRestore = true,
    options: { preserveSceneDrafts?: boolean } = {},
  ) => {
    if (invalidateRestore) generation += 1;
    history = new ProjectHistory(next, 200);
    currentSceneId.value = next.entrySceneId;
    selectedCommandId.value = "";
    if (!options.preserveSceneDrafts) {
      sceneCodeDrafts.value = {};
      sceneCodeContexts.value = {};
    }
    formatDiagnostics.value = [];
    replaceVisible(history.value, changed);
    syncCode();
    syncSceneCode();
  };

  const undo = () => {
    if (!history.canUndo) return;
    generation += 1;
    replaceVisible(history.undo());
  };

  const redo = () => {
    if (!history.canRedo) return;
    generation += 1;
    replaceVisible(history.redo());
  };

  const setCurrentScene = (id: string) => {
    if (!project.value.scenes.some((scene) => scene.id === id)) return false;
    if (id === currentSceneId.value) return true;
    currentSceneId.value = id;
    selectedCommandId.value = "";
    syncSceneCode();
    return true;
  };

  const normalizeSceneFolder = (path: readonly string[]) =>
    path.map((segment) => String(segment).normalize("NFKC").trim().replaceAll(/[\\/]/g, "-")).filter(Boolean);

  const addScene = (folder: readonly string[] = []) => {
    const id = createStoryId("scene");
    const editorPath = normalizeSceneFolder(folder);
    updateProject((draft) => {
      draft.scenes.push({
        id,
        name: `Scene ${draft.scenes.length + 1}`,
        commands: [],
        extensions: editorPath.length ? { editorPath } : {},
      });
    });
    setCurrentScene(id);
  };

  const addSceneFolder = (path: readonly string[]) => {
    const normalized = normalizeSceneFolder(path);
    if (!normalized.length) return false;
    const key = normalized.join("/");
    return updateProject((draft) => {
      const current = Array.isArray(draft.extensions.sceneFolders)
        ? draft.extensions.sceneFolders.map(String).filter(Boolean)
        : [];
      if (!current.includes(key)) draft.extensions.sceneFolders = [...current, key];
    });
  };

  const renameScene = (id: string, name: string) => {
    updateProject((draft) => {
      const scene = draft.scenes.find((item) => item.id === id);
      if (scene) scene.name = name.trim() || scene.name;
    });
  };

  const deleteScene = (id: string) => {
    if (project.value.scenes.length <= 1) return false;
    if (sceneCodeDrafts.value[id] !== undefined) {
      status.value = "draftConflict";
      statusDetail.value = copy.value.sceneDraftDeleteBlocked;
      return false;
    }
    return updateProject((draft) => {
      draft.scenes = draft.scenes.filter((scene) => scene.id !== id);
      if (draft.entrySceneId === id) draft.entrySceneId = draft.scenes[0]?.id || "";
    });
  };

  const setEntryScene = (id: string) => {
    updateProject((draft) => {
      if (draft.scenes.some((scene) => scene.id === id)) draft.entrySceneId = id;
    });
  };

  const addCommand = (code: number, index?: number, fields: JsonObject = {}) => {
    const command = createStoryCommand(code, fields);
    updateProject(
      (draft) => {
        const scene = draft.scenes.find((item) => item.id === currentSceneId.value);
        if (!scene) return;
        const target =
          index === undefined ? scene.commands.length : Math.max(0, Math.min(scene.commands.length, index));
        scene.commands.splice(target, 0, command);
      },
      { select: command.id },
    );
  };

  const duplicateCommand = (id: string) => {
    const source = currentScene.value?.commands.find((command) => command.id === id);
    if (!source) return;
    const duplicate = { ...cloneStoryValue(source), id: createStoryId("command") };
    updateProject(
      (draft) => {
        const scene = draft.scenes.find((item) => item.id === currentSceneId.value);
        const index = scene?.commands.findIndex((command) => command.id === id) ?? -1;
        if (scene && index >= 0) scene.commands.splice(index + 1, 0, duplicate);
      },
      { select: duplicate.id },
    );
  };

  const deleteCommand = (id: string) => {
    updateProject((draft) => {
      const scene = draft.scenes.find((item) => item.id === currentSceneId.value);
      if (scene) scene.commands = scene.commands.filter((command) => command.id !== id);
    });
  };

  const moveCommand = (id: string, index: number) => {
    updateProject((draft) => {
      const commands = draft.scenes.find((scene) => scene.id === currentSceneId.value)?.commands;
      if (!commands) return;
      const previous = commands.findIndex((command) => command.id === id);
      if (previous < 0) return;
      const [command] = commands.splice(previous, 1);
      if (!command) return;
      commands.splice(Math.max(0, Math.min(commands.length, index)), 0, command);
    });
  };

  const patchCommand = (id: string, key: string, value?: JsonValue) => {
    if (!id) return;
    updateProject(
      (draft) => {
        const command = draft.scenes
          .find((scene) => scene.id === currentSceneId.value)
          ?.commands.find((item) => item.id === id);
        if (!command) return;
        if (value === undefined) {
          delete command.fields[key];
          if (key === "targetName" && command.command === ADV_COMMAND.Talk) delete command.fields.targets;
        } else if (key === "targetName" && command.command === ADV_COMMAND.Talk && typeof value === "string") {
          const names = storyTargetNames(value);
          const currentTargets = Array.isArray(command.fields.targets)
            ? command.fields.targets.filter((target): target is JsonObject =>
                Boolean(target && typeof target === "object" && !Array.isArray(target)),
              )
            : [];
          command.fields.targetName = storyTargetNameFromEditor(value);
          command.fields.targets = names.map((target, index) => {
            const matched =
              currentTargets.find((entry) => String(entry.target || "") === target) || currentTargets[index] || {};
            return { ...cloneStoryValue(matched), target };
          });
        } else {
          command.fields[key] = cloneStoryValue(value);
        }
      },
      { mergeKey: `field:${id}:${key}` },
    );
  };

  const patchCommandField = (key: string, value?: JsonValue) => {
    patchCommand(selectedCommandId.value, key, value);
  };

  const replaceCommand = (id: string, fields: JsonObject) => {
    if (!id) return;
    history.endMerge();
    updateProject((draft) => {
      const command = draft.scenes
        .find((scene) => scene.id === currentSceneId.value)
        ?.commands.find((item) => item.id === id);
      if (command) command.fields = cloneStoryValue(fields);
    });
  };

  const replaceCommandFields = (fields: JsonObject) => {
    replaceCommand(selectedCommandId.value, fields);
  };

  const replaceNativeCommand = (id: string, command: StoryProjectCommand) => {
    if (!id) return;
    history.endMerge();
    updateProject((draft) => {
      const commands = draft.scenes.find((scene) => scene.id === currentSceneId.value)?.commands;
      const index = commands?.findIndex((item) => item.id === id) ?? -1;
      if (!commands || index < 0) return;
      commands[index] = { ...cloneStoryValue(command), id };
    });
  };

  const patchMeta = (patch: Partial<StoryProject["meta"]>) => {
    updateProject(
      (draft) => {
        Object.assign(draft.meta, cloneStoryValue(patch));
      },
      { mergeKey: "project-meta" },
    );
  };

  const insertResource = (resource: StoryEditorResourceInsert) => {
    if (resource.kind === "story") return;
    const command = commandForResource(resource);

    updateProject(
      (draft) => {
        const scene = draft.scenes.find((item) => item.id === currentSceneId.value);
        if (!scene) return;
        registerStoryResource(draft, resource);
        scene.commands.push(command);
      },
      { select: command.id },
    );
  };

  const assignResource = (
    resource: StoryEditorResourceInsert,
    target: {
      commandId: string;
      fieldKey: string;
      resource?: CommandResourceKind;
      audioUsage?: "bgm" | "se" | "voice";
    },
  ) => {
    if (resource.kind === "story") return;
    if (target.resource && resource.kind !== target.resource) return;
    if (resource.kind === "audio" && target.audioUsage && resource.usage !== target.audioUsage) return;
    updateProject(
      (draft) => {
        const command = draft.scenes
          .find((scene) => scene.id === currentSceneId.value)
          ?.commands.find((item) => item.id === target.commandId);
        if (!command) return;
        registerStoryResource(draft, resource);
        command.fields[target.fieldKey] = resource.key;
        Object.assign(command.fields, resourceFieldPatch(resource));
      },
      { select: target.commandId },
    );
  };

  const importStoryResource = (resource: Extract<StoryEditorResourceInsert, { kind: "story" }>, title = "") => {
    try {
      const importOptions = {
        title: title || String(resource.value.storyKey || resource.key),
        releaseServer: project.value.meta.releaseServer || releaseServer.value,
        provenance: { resource: "stories", id: resource.key },
      };
      const catalogResult = importAdvStoryJson(resource.value, importOptions);
      const episode = resource.sourceSnapshot?.episode;
      const episodeContent =
        episode && typeof episode === "object" && !Array.isArray(episode)
          ? (episode as Record<string, unknown>).content
          : undefined;
      const hasEpisodeSource =
        (typeof episodeContent === "string" && Boolean(episodeContent.trim())) ||
        (episodeContent !== null && typeof episodeContent === "object");
      const result = hasEpisodeSource ? importAdvStoryJson(episodeContent, importOptions) : catalogResult;

      if (result !== catalogResult) {
        const sourceCommands = result.project.scenes[0]?.commands || [];
        const catalogCommands = catalogResult.project.scenes[0]?.commands || [];
        reconcileEpisodeCommands(sourceCommands, catalogCommands);
        result.project.assets = cloneStoryValue(catalogResult.project.assets);
        result.project.runtime = mergeStoryRuntime(catalogResult.project.runtime, result.project.runtime) as JsonObject;
        result.project.storyFields = cloneStoryValue(catalogResult.project.storyFields);
      }
      if (resource.sourceSnapshot) {
        result.project.extensions = {
          ...result.project.extensions,
          archiveSource: {
            resource: "stories",
            id: resource.key,
            snapshot: cloneStoryValue(resource.sourceSnapshot as unknown as JsonObject),
          },
        };
      }
      resetProject(result.project);
      formatDiagnostics.value = result.diagnostics;
      status.value = "imported";
      statusDetail.value = "ADV JSON";
      void saveNow({ announce: false });
    } catch (error) {
      status.value = "importFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    }
  };

  const importFile = async (file: File) => {
    try {
      const source = await file.text();
      const trimmed = source.trimStart();
      const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
      const result = !isJson
        ? importWebGal(source, {
            title: safeFileStem(file.name),
            releaseServer: project.value.meta.releaseServer || releaseServer.value,
          })
        : (() => {
            const parsed = JSON.parse(source) as unknown;
            const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
            const projectShaped = Boolean(
              object && ("version" in object || "scenes" in object || "entrySceneId" in object),
            );
            if (/\.haneoka-story\.json$/i.test(file.name) || projectShaped) return importStoryProjectJson(source);
            const sourceResult = importRegisteredStoryFile({
              fileName: file.name,
              parsed,
              title: safeFileStem(file.name),
              releaseServer: project.value.meta.releaseServer || releaseServer.value,
            });
            if (sourceResult) return sourceResult;
            return importAdvStoryJson(parsed, {
              title: safeFileStem(file.name),
              releaseServer: project.value.meta.releaseServer || releaseServer.value,
            });
          })();
      resetProject(result.project);
      formatDiagnostics.value = result.diagnostics;
      status.value = "imported";
      statusDetail.value = result.format.toUpperCase();
      await saveNow({ announce: false });
    } catch (error) {
      status.value = "importFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const setCodeValue = (value: string) => {
    codeDraftBase.value = storyJsonDraftBaseForValue(codeDraftBase.value, codeBaseline.value, value, revision.value);
    codeValue.value = value;
    codeError.value = "";
  };

  const applyCode = () => {
    if (!codeDirty.value) return true;
    try {
      const result = importStoryProjectJson(codeValue.value);
      const conflict = storyJsonDraftConflict({
        base: codeDraftBase.value,
        currentSnapshot: codeBaseline.value,
        currentRevision: revision.value,
        nextSceneIds: result.project.scenes.map((scene) => scene.id),
        sceneDraftIds: sceneCodeDraftIds.value,
      });
      if (conflict) {
        const message =
          conflict === "scene-draft-orphaned" ? copy.value.projectCodeSceneConflict : copy.value.projectCodeConflict;
        codeError.value = message;
        status.value = "draftConflict";
        statusDetail.value = message;
        return false;
      }
      resetProject(result.project, true, true, { preserveSceneDrafts: true });
      status.value = "ready";
      statusDetail.value = "";
      return true;
    } catch (error) {
      codeError.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const formatCode = () => {
    try {
      setCodeValue(stringifyStoryJson(JSON.parse(codeValue.value) as JsonValue));
      codeError.value = "";
    } catch (error) {
      codeError.value = error instanceof Error ? error.message : String(error);
    }
  };

  const setSceneCodeValue = (value: string) => {
    sceneCodeValue.value = value;
    sceneCodeError.value = "";
    const sceneId = currentSceneId.value;
    if (value === sceneCodeBaseline.value) {
      const { [sceneId]: _discarded, ...rest } = sceneCodeDrafts.value;
      sceneCodeDrafts.value = rest;
      const { [sceneId]: _discardedContext, ...contextRest } = sceneCodeContexts.value;
      sceneCodeContexts.value = contextRest;
    } else {
      if (sceneCodeDrafts.value[sceneId] === undefined) {
        sceneCodeContexts.value = {
          ...sceneCodeContexts.value,
          [sceneId]: cloneStoryValue(sceneCodeContext.value),
        };
      }
      sceneCodeDrafts.value = { ...sceneCodeDrafts.value, [sceneId]: value };
    }
  };

  const discardCodeDraft = () => {
    syncCode();
    status.value = "ready";
    statusDetail.value = "";
  };

  const hasSceneCodeDraft = (sceneId: string) => sceneCodeDrafts.value[sceneId] !== undefined;

  const discardSceneCodeDraft = (sceneId = currentSceneId.value) => {
    if (!hasSceneCodeDraft(sceneId)) return false;
    const { [sceneId]: _discarded, ...rest } = sceneCodeDrafts.value;
    sceneCodeDrafts.value = rest;
    const { [sceneId]: _discardedContext, ...contextRest } = sceneCodeContexts.value;
    sceneCodeContexts.value = contextRest;
    if (sceneId === currentSceneId.value) syncSceneCode();
    status.value = "ready";
    statusDetail.value = "";
    return true;
  };

  const applySceneCode = () => {
    try {
      const result = mergeWebGalScene(project.value, sceneCodeValue.value, {
        sceneId: currentSceneId.value,
        title: currentScene.value?.name || project.value.meta.title || "Scene",
        releaseServer: project.value.meta.releaseServer || releaseServer.value,
        ...(sceneCodeContexts.value[currentSceneId.value]
          ? { baselineContext: sceneCodeContexts.value[currentSceneId.value] }
          : {}),
      });
      updateProject(() => result.project);
      formatDiagnostics.value = result.diagnostics;
      selectedCommandId.value = "";
      const sceneId = currentSceneId.value;
      const { [sceneId]: _discarded, ...rest } = sceneCodeDrafts.value;
      sceneCodeDrafts.value = rest;
      const { [sceneId]: _discardedContext, ...contextRest } = sceneCodeContexts.value;
      sceneCodeContexts.value = contextRest;
      syncSceneCode();
      status.value = "ready";
      statusDetail.value = "";
      return true;
    } catch (error) {
      sceneCodeError.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const saveNow = async (options: { announce?: boolean } = {}) => {
    if (!import.meta.client || disposed) return;
    const result = validateStoryProject(project.value);
    if (!result.valid) {
      status.value = "saveFailed";
      statusDetail.value = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      return;
    }
    saving.value = true;
    const targetRevision = revision.value;
    try {
      // `ref()`/computed values can still contain Vue proxy wrappers even when
      // the project root itself is held in a shallow ref. IndexedDB uses the
      // platform structured-clone algorithm and rejects those wrappers, so
      // snapshot the complete record into plain authoring data before put().
      await saveStoryEditorDraft(
        cloneStoryValue({
          project: project.value,
          currentSceneId: currentSceneId.value,
          projectRevision: revision.value,
          projectCode: codeValue.value,
          ...(codeDraftBase.value ? { projectCodeBase: { ...codeDraftBase.value } } : {}),
          sceneCode: sceneCodeValue.value,
          sceneCodes: cloneStoryValue(sceneCodeDrafts.value),
          sceneCodeContexts: cloneStoryValue(sceneCodeContexts.value),
          updatedAt: Date.now(),
        }),
      );
      if (disposed) return;
      if (revision.value === targetRevision) savedRevision.value = targetRevision;
      if (options.announce !== false) {
        status.value = "autosaved";
        statusDetail.value = "";
      }
    } catch (error) {
      if (disposed) return;
      status.value = "saveFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed) saving.value = false;
    }
  };

  const scheduleAutosave = () => {
    if (!import.meta.client || disposed || !restored.value) return;
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = undefined;
      void saveNow();
    }, 800);
  };

  const newProject = async () => {
    resetProject(createEmptyStoryProject({ releaseServer: releaseServer.value }));
    status.value = "ready";
    statusDetail.value = "";
    try {
      await clearStoryEditorDraft();
      savedRevision.value = revision.value;
    } catch (error) {
      status.value = "saveFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    }
  };

  const restoreDraft = async () => {
    const targetGeneration = generation;
    try {
      const draft = await loadStoryEditorDraft<StoryProject>();
      if (disposed || generation !== targetGeneration || !draft) return;
      const restoredProject = draft.project;
      const result = validateStoryProject(restoredProject);
      if (!result.valid) throw new Error(result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
      resetProject(restoredProject, false, false);
      if (typeof draft.projectRevision === "number" && Number.isSafeInteger(draft.projectRevision)) {
        revision.value = Math.max(0, draft.projectRevision);
      }
      if (draft.currentSceneId && project.value.scenes.some((scene) => scene.id === draft.currentSceneId)) {
        currentSceneId.value = draft.currentSceneId;
      }
      if (typeof draft.projectCode === "string") {
        const base = draft.projectCodeBase;
        const restoredBase =
          draft.projectCode !== codeBaseline.value &&
          base &&
          typeof base.snapshot === "string" &&
          typeof base.revision === "number" &&
          Number.isSafeInteger(base.revision)
            ? { snapshot: base.snapshot, revision: base.revision }
            : undefined;
        // `projectCode` without a base is the last generated cache, not a user edit.
        if (restoredBase) {
          codeValue.value = draft.projectCode;
          codeDraftBase.value = restoredBase;
        }
      }
      const sceneIds = new Set(project.value.scenes.map((scene) => scene.id));
      const restoredSceneCodes = Object.fromEntries(
        Object.entries(draft.sceneCodes || {}).filter(
          (entry): entry is [string, string] => sceneIds.has(entry[0]) && typeof entry[1] === "string",
        ),
      );
      sceneCodeDrafts.value = restoredSceneCodes;
      sceneCodeContexts.value = Object.fromEntries(
        Object.entries(draft.sceneCodeContexts || {}).filter(
          (entry): entry is [string, WebGalSceneEditContext] =>
            sceneIds.has(entry[0]) &&
            entry[1]?.version === 1 &&
            entry[1].sceneId === entry[0] &&
            typeof entry[1].baselineText === "string" &&
            (entry[1].localeIndex === undefined ||
              (Number.isSafeInteger(entry[1].localeIndex) && entry[1].localeIndex >= 0)) &&
            entry[1].scene?.id === entry[0] &&
            typeof entry[1].scene.name === "string" &&
            Array.isArray(entry[1].scene.commands) &&
            Array.isArray(entry[1].blocks) &&
            entry[1].blocks.every(
              (block) =>
                Array.isArray(block.ids) &&
                block.ids.length > 0 &&
                block.ids.every((id) => typeof id === "string" && Boolean(id)) &&
                typeof block.projection === "string",
            ),
        ),
      );
      for (const sceneId of Object.keys(restoredSceneCodes)) {
        if (!sceneCodeContexts.value[sceneId] && !restoredSceneCodes[sceneId]!.includes("@haneoka-lossless")) {
          const fallback = createWebGalSceneDraft(project.value, { sceneId });
          sceneCodeContexts.value = { ...sceneCodeContexts.value, [sceneId]: fallback.context };
        }
      }
      syncSceneCode();
      if (
        typeof draft.sceneCode === "string" &&
        sceneCodeDrafts.value[currentSceneId.value] === undefined &&
        draft.sceneCode !== sceneCodeBaseline.value
      ) {
        sceneCodeDrafts.value = { ...sceneCodeDrafts.value, [currentSceneId.value]: draft.sceneCode };
        if (!draft.sceneCode.includes("@haneoka-lossless")) {
          sceneCodeContexts.value = {
            ...sceneCodeContexts.value,
            [currentSceneId.value]: cloneStoryValue(sceneCodeContext.value),
          };
        }
        sceneCodeValue.value = draft.sceneCode;
      }
      status.value = "restored";
      savedRevision.value = revision.value;
    } catch (error) {
      if (disposed) return;
      status.value = "importFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    } finally {
      restored.value = true;
      if (dirty.value) scheduleAutosave();
    }
  };

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value || saving.value) return;
    event.preventDefault();
    event.returnValue = "";
  };

  watch([project, currentSceneId], scheduleCompilation, { immediate: true, flush: "post" });
  watch([project, codeValue, codeDraftBase, sceneCodeValue, sceneCodeDrafts, sceneCodeContexts], scheduleAutosave);

  onMounted(() => {
    window.addEventListener("beforeunload", onBeforeUnload);
    void restoreDraft();
  });

  onBeforeUnmount(() => {
    if (dirty.value || autosaveTimer) void saveNow({ announce: false });
    disposed = true;
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    cancelScheduledCompilation();
    window.removeEventListener("beforeunload", onBeforeUnload);
  });

  return {
    project,
    currentSceneId,
    currentScene,
    selectedCommandId,
    selectedCommand,
    revision,
    validation,
    issues,
    compiled,
    compileNow,
    commandCount,
    canUndo,
    canRedo,
    dirty,
    saving,
    status,
    statusDetail,
    formatDiagnostics,
    codeValue,
    codeDirty,
    codeError,
    sceneCodeValue,
    sceneCodeDirty,
    sceneCodeDraftIds,
    sceneCodeError,
    restored,
    setCurrentScene,
    addScene,
    addSceneFolder,
    renameScene,
    deleteScene,
    setEntryScene,
    addCommand,
    duplicateCommand,
    deleteCommand,
    moveCommand,
    patchCommand,
    patchCommandField,
    replaceCommand,
    replaceCommandFields,
    replaceNativeCommand,
    patchMeta,
    insertResource,
    assignResource,
    importStoryResource,
    importFile,
    setCodeValue,
    applyCode,
    formatCode,
    discardCodeDraft,
    setSceneCodeValue,
    applySceneCode,
    hasSceneCodeDraft,
    discardSceneCodeDraft,
    saveNow,
    newProject,
    undo,
    redo,
  };
};
