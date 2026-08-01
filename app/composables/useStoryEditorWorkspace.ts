import {
  assertStoryProjectProtocol,
  cloneStoryValue,
  createEmptyStoryProject,
  createStoryId,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
  type StoryProjectPlugin,
  type StoryScene,
} from "@haneoka/altair";
import type {
  AltairAdvResourceInsert,
  CommandResourceKind,
  StoryDiagnostic,
  StoryProjectValidationResult,
  StoryValidationIssue,
} from "@haneoka/altair-plugin-adv";
import type { ResourceBrowserInsert, ResourceBrowserProvider } from "@haneoka/altair/resource-browser";
import type { AltairDraftService, AltairDraftSession, StoryJsonDraftBase } from "@haneoka/altair-plugin-drafts";
import type { AltairHistory, AltairHistoryService } from "@haneoka/altair-plugin-history";
import type { AltairBestdoriAssetService } from "@haneoka/altair-plugin-bestdori";
import type {
  AltairWebGalService,
  WebGalBrowserWorkspaceFile,
  WebGalSceneEditContext,
} from "@haneoka/altair-plugin-webgal";
import type {
  AltairBrowserWorkspaceService,
  AltairBrowserWorkspaceSnapshot,
  BrowserWorkspaceDirectoryHandle,
} from "@haneoka/altair-plugin-workspace-browser";
import { isBestdoriServer, type BestdoriServer } from "@haneoka/bestdori";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { bestdoriCatalogOrigin, catalogApiUrl } from "~/composables/useCatalogApi";
import { assetRootForRelease } from "~/composables/useReleaseServer";
import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import { bestdoriRawResourceUrl } from "~/features/community/bestdori/resources";
import type { ArchiveLocale } from "~/i18n/locales";
import {
  createDefaultHaneokaAltairAuthoringRegistry,
  createHaneokaAltairAuthoringHost,
  storyProjectPluginTargetsAltairAuthoring,
  type AltairAuthoringHostPort,
  type HaneokaAltairAuthoringHost,
} from "~/features/story/altairAuthoring";
import { HANEOKA_AUTHORING_PLUGIN_IDS, HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS } from "~/features/story/pluginSelection";

export interface HaneokaAdvAuthoringService {
  readonly commands: typeof import("@haneoka/altair-plugin-adv").COMMAND_DESCRIPTORS;
  readonly opcodes: typeof import("@haneoka/altair-plugin-adv").ADV_COMMAND;
  readonly compile: typeof import("@haneoka/altair-plugin-adv").compileStoryProjectWithDiagnostics;
  readonly commandDescriptor: typeof import("@haneoka/altair-plugin-adv").commandDescriptor;
  readonly commandFieldDescriptors: typeof import("@haneoka/altair-plugin-adv").commandFieldDescriptors;
  readonly createAdvResourceCommand: typeof import("@haneoka/altair-plugin-adv").createAdvResourceCommand;
  readonly createStoryCommand: typeof import("@haneoka/altair-plugin-adv").createStoryCommand;
  readonly registerAdvResource: typeof import("@haneoka/altair-plugin-adv").registerAdvResource;
  readonly advResourceFieldPatch: typeof import("@haneoka/altair-plugin-adv").advResourceFieldPatch;
  readonly importAdvStoryJson: typeof import("@haneoka/altair-plugin-adv").importAdvStoryJson;
  readonly importStoryProjectJson: typeof import("@haneoka/altair-plugin-adv").importStoryProjectJson;
  readonly replaceStoryLocalizedTextForEditor: typeof import("@haneoka/altair-plugin-adv").replaceStoryLocalizedTextForEditor;
  readonly serializeStoryProjectJson: typeof import("@haneoka/altair-plugin-adv").serializeStoryProjectJson;
  readonly stringifyStoryJson: typeof import("@haneoka/altair-plugin-adv").stringifyStoryJson;
  readonly storyCommandFieldValue: typeof import("@haneoka/altair-plugin-adv").storyCommandFieldValue;
  readonly storyLocalizedTextForEditor: typeof import("@haneoka/altair-plugin-adv").storyLocalizedTextForEditor;
  readonly storyNumberFromInput: typeof import("@haneoka/altair-plugin-adv").storyNumberFromInput;
  readonly storyNumberInputValue: typeof import("@haneoka/altair-plugin-adv").storyNumberInputValue;
  readonly storyResourceAliases: typeof import("@haneoka/altair-plugin-adv").storyResourceAliases;
  readonly storyTargetNameForEditor: typeof import("@haneoka/altair-plugin-adv").storyTargetNameForEditor;
  readonly storyTargetNameFromEditor: typeof import("@haneoka/altair-plugin-adv").storyTargetNameFromEditor;
  readonly storyTargetNames: typeof import("@haneoka/altair-plugin-adv").storyTargetNames;
  readonly validateStoryProject: typeof import("@haneoka/altair-plugin-adv").validateStoryProject;
}

export type HaneokaDraftAuthoringService = AltairDraftService;

export type HaneokaWebGalAuthoringService = AltairWebGalService;
export type HaneokaBestdoriAuthoringService = AltairBestdoriAssetService;

export type StoryEditorView = "visual" | "graph" | "webgal" | "project";
export type StoryEditorResourceInsert = ResourceBrowserInsert<unknown>;
export type StoryEditorStatus =
  "ready" | "autosaved" | "restored" | "imported" | "draftConflict" | "importFailed" | "saveFailed";

export const storyEditorProjectFromInsert = (resource: StoryEditorResourceInsert): StoryProject | undefined => {
  if (resource.kind !== "project") return undefined;
  assertStoryProjectProtocol(resource.value);
  return cloneStoryValue(resource.value);
};

interface StoryEditorDraftState {
  project: StoryProject;
  updatedAt: number;
  currentSceneId?: string;
  projectRevision?: number;
  projectCode?: string;
  projectCodeBase?: StoryJsonDraftBase;
  sceneCode?: string;
  sceneCodes?: Record<string, string>;
  sceneCodeContexts?: Record<string, WebGalSceneEditContext>;
}

export const STORY_EDITOR_AUTHORING_PLUGIN = Object.freeze({
  adv: "haneoka.altair-adv",
  bestdori: "haneoka.altair-bestdori",
  drafts: "haneoka.altair-drafts",
  flow: "haneoka.altair-flow",
  history: "haneoka.altair-history",
  webgal: "haneoka.altair-webgal",
  vegaPreview: "haneoka.altair-vega-preview",
  workspace: "haneoka.altair-workspace-browser",
} as const);

export interface StoryEditorAuthoringCapabilities {
  readonly adv: boolean;
  readonly bestdori: boolean;
  readonly drafts: boolean;
  readonly flow: boolean;
  readonly history: boolean;
  readonly webgal: boolean;
  readonly vegaPreview: boolean;
  readonly workspace: boolean;
}

export const resolveStoryEditorAuthoringCapabilities = (
  installedPluginIds: Iterable<string>,
  ready = true,
): StoryEditorAuthoringCapabilities => {
  const installed = ready ? new Set(installedPluginIds) : new Set<string>();
  return Object.freeze({
    adv: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.adv),
    bestdori: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.bestdori),
    drafts: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.drafts),
    flow: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.flow),
    history: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.history),
    webgal: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.webgal),
    vegaPreview: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.vegaPreview),
    workspace: installed.has(STORY_EDITOR_AUTHORING_PLUGIN.workspace),
  });
};

export const storyEditorRuntimePlugins = (
  plugins: readonly StoryProjectPlugin[] | undefined,
): readonly StoryProjectPlugin[] =>
  (plugins ?? []).filter(
    (selection) =>
      !HANEOKA_AUTHORING_PLUGIN_IDS.has(selection.id) && !storyProjectPluginTargetsAltairAuthoring(selection),
  );

export const storyEditorAuthoringPlugins = (
  plugins: readonly StoryProjectPlugin[] | undefined,
): readonly StoryProjectPlugin[] =>
  (plugins ?? []).filter(
    (selection) =>
      HANEOKA_AUTHORING_PLUGIN_IDS.has(selection.id) || storyProjectPluginTargetsAltairAuthoring(selection),
  );

const jsonObjectValue = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

export const storyEditorBestdoriSourceServer = (project: StoryProject): BestdoriServer | undefined => {
  const provenance = project.meta.provenance;
  const source = jsonObjectValue(project.extensions.source);
  const candidates = [provenance?.sourceServer, source?.sourceServer];
  return candidates.find(isBestdoriServer);
};

export const storyEditorBestdoriRequestContext = (
  project: StoryProject,
  locale: unknown,
): Readonly<Record<string, unknown>> => {
  const server = storyEditorBestdoriSourceServer(project);
  return Object.freeze({
    locale,
    ...(server ? { bestdoriServer: server } : {}),
  });
};

export type StoryEditorDirectoryPermission = "none" | "prompt" | "granted" | "denied" | "read-only";
export type StoryEditorDirectorySource = "none" | "handle" | "input";

const STORY_EDITOR_LOCALE_INDEX: Record<ArchiveLocale, number> = {
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
};

const safeFileStem = (value: string): string =>
  value
    .replace(/\.(?:haneoka-story\.)?(?:json|txt)$/i, "")
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ") || "story";

const normalizeIssue = (issue: StoryDiagnostic): StoryValidationIssue => ({
  severity: issue.severity === "error" ? "error" : "warning",
  code: issue.code,
  path: issue.path,
  message: issue.message,
});

const createHaneokaStoryEditorProject = (releaseServer: string): StoryProject => ({
  ...createEmptyStoryProject({ releaseServer }),
  plugins: cloneStoryValue([...HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS]),
});

export const withHaneokaStoryEditorPlugins = (project: StoryProject): StoryProject => {
  if (project.plugins === undefined) {
    return {
      ...project,
      plugins: cloneStoryValue([...HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS]),
    };
  }
  const selected = (project.plugins ?? []).map((plugin) =>
    HANEOKA_AUTHORING_PLUGIN_IDS.has(plugin.id) && plugin.targets?.runtimes === undefined
      ? {
          ...plugin,
          targets: {
            ...plugin.targets,
            runtimes: ["altair"],
          },
        }
      : plugin,
  );
  const selectedIds = new Set(selected.map(({ id }) => id));
  const missing = HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS.filter(({ id, required }) => required && !selectedIds.has(id));
  const changedTargets = selected.some((plugin, index) => plugin !== project.plugins?.[index]);
  if (!missing.length && project.plugins && !changedTargets) return project;
  return {
    ...project,
    plugins: cloneStoryValue([...missing, ...selected]),
  };
};

export const settleStoryEditorAuthoringDisposal = async (
  pending: PromiseLike<unknown>,
  dispose: () => Promise<void> | void,
  reportError: (error: unknown) => void,
): Promise<void> => {
  try {
    await pending;
    await dispose();
  } catch (error) {
    reportError(error);
  }
};

export const useStoryEditorWorkspace = () => {
  const config = useRuntimeConfig();
  const { releaseServer } = useReleaseServer();
  const { locale, localize, messages } = useLocale();
  const copy = messages("storyEditorPage");
  const activeLocaleIndex = () => STORY_EDITOR_LOCALE_INDEX[locale.value];
  const initial = createHaneokaStoryEditorProject(releaseServer.value);
  const mutableHistoryProject = (value: AltairHistory<StoryProject>["value"]): StoryProject =>
    cloneStoryValue(value as unknown as StoryProject);
  const project = shallowRef<StoryProject>(cloneStoryValue(initial));
  const activeProjectRelease = (): string => {
    const value = project.value.meta.releaseServer;
    return typeof value === "string" && value.trim() ? value.trim() : releaseServer.value;
  };
  const currentSceneId = ref(project.value.entrySceneId);
  const selectedCommandId = ref("");
  const revision = ref(0);
  const savedRevision = ref(0);
  const canUndo = ref(false);
  const canRedo = ref(false);
  const saving = ref(false);
  const restored = ref(false);
  const authoringReady = ref(false);
  const authoringError = ref("");
  const authoringOperations = shallowRef<AltairAuthoringHostPort>();
  const resourceBrowserProviders = shallowRef<readonly ResourceBrowserProvider[]>([]);
  const authoringRevision = ref(0);
  const advAuthoring = shallowRef<HaneokaAdvAuthoringService>();
  const bestdoriAuthoring = shallowRef<HaneokaBestdoriAuthoringService>();
  const draftAuthoring = shallowRef<HaneokaDraftAuthoringService>();
  const webGalAuthoring = shallowRef<HaneokaWebGalAuthoringService>();
  const workspaceAuthoring = shallowRef<AltairBrowserWorkspaceService>();
  const installedAuthoringPluginIds = shallowRef<ReadonlySet<string>>(new Set());
  const authoringCapabilities = computed(() =>
    resolveStoryEditorAuthoringCapabilities(installedAuthoringPluginIds.value, authoringReady.value),
  );
  const runtimePlugins = computed(() => storyEditorRuntimePlugins(project.value.plugins));
  const status = ref<StoryEditorStatus>("ready");
  const statusDetail = ref("");
  const formatDiagnostics = shallowRef<readonly StoryDiagnostic[]>([]);
  const codeValue = ref("");
  const codeBaseline = ref(codeValue.value);
  const codeDraftBase = shallowRef<StoryJsonDraftBase>();
  const codeError = ref("");
  const sceneCodeValue = ref("");
  const sceneCodeBaseline = ref(sceneCodeValue.value);
  const sceneCodeContext = shallowRef<WebGalSceneEditContext>();
  const sceneCodeError = ref("");
  const sceneCodeDrafts = ref<Record<string, string>>({});
  const sceneCodeContexts = shallowRef<Record<string, WebGalSceneEditContext>>({});
  const workspaceName = ref("");
  const workspaceSource = ref<StoryEditorDirectorySource>("none");
  const workspacePermission = ref<StoryEditorDirectoryPermission>("none");
  const workspaceLoading = ref(false);
  const workspaceFiles = shallowRef<WebGalBrowserWorkspaceFile[]>([]);
  const workspaceRevision = ref(0);
  let autosaveTimer: number | undefined;
  let compileTimer: number | undefined;
  let compileGeneration = 0;
  let compiledSceneId = "";
  let workspaceViewGeneration = 0;
  let workspaceRestoreHandle: BrowserWorkspaceDirectoryHandle | undefined;
  let generation = 0;
  let disposed = false;
  const authoringAbort = new AbortController();
  const bestdoriCatalogUrl = (server: string, path: string): string => {
    const source = bestdoriCatalogOrigin(locale.value, isBestdoriServer(server) ? server : undefined);
    const base = catalogApiUrl(config.public.apiBase, source, path);
    return `${base}?lang=${encodeURIComponent(locale.value)}&v=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}`;
  };
  const authoringRegistry = createDefaultHaneokaAltairAuthoringRegistry({
    "haneoka.altair-haneoka": async () => {
      const module = await import("@haneoka/altair-plugin-haneoka");
      return module.createAltairHaneokaPlugin({
        defaultRelease: releaseServer.value,
        adapter: {
          fetchCatalog: ({ release, resource, kind, view, signal }) => {
            const path = kind === "view" && view ? `${resource}/views/${view}` : resource;
            return $fetch(catalogApiUrl(config.public.apiBase, ourNotesReleaseOrigin(release), path), { signal });
          },
          fetchAsset: ({ release, path, signal }) => {
            const normalizedPath = path
              .replace(/^\/+|\/+$/g, "")
              .split("/")
              .filter(Boolean)
              .map(encodeURIComponent)
              .join("/");
            return $fetch(`${assetRootForRelease(release)}/${normalizedPath}`, { signal });
          },
          localize: (value) => localize(value as Parameters<typeof localize>[0]),
        },
      });
    },
    "haneoka.altair-bestdori": async () => {
      const module = await import("@haneoka/altair-plugin-bestdori");
      return module.createAltairBestdoriPlugin({
        resources: {
          locale: locale.value,
          adapter: {
            fetchIndex: ({ server, signal }) => $fetch(bestdoriCatalogUrl(server, "editor-assets"), { signal }),
            fetchBundle: ({ server, path, signal }) =>
              $fetch(
                bestdoriCatalogUrl(
                  server,
                  `editor-assets/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
                ),
                { signal },
              ),
            resolveRawUrl: (path, server) => {
              const source = bestdoriCatalogOrigin(locale.value, isBestdoriServer(server) ? server : undefined);
              return bestdoriRawResourceUrl(path, source.region);
            },
            fetchLive2d: async ({ server, costumeId, signal }) => {
              const separator = bestdoriCatalogUrl(server, "live2d").includes("?") ? "&" : "?";
              const response = await $fetch<{ items?: Record<string, Record<string, unknown>> }>(
                `${bestdoriCatalogUrl(server, "live2d")}${separator}id=${encodeURIComponent(costumeId)}`,
                { signal },
              );
              return response.items?.[costumeId];
            },
          },
        },
      });
    },
    "haneoka.altair-webgal": async () => {
      const module = await import("@haneoka/altair-plugin-webgal");
      return module.createAltairWebGalPlugin({
        resourceFiles: () => workspaceFiles.value,
      });
    },
  });
  let authoringHost: HaneokaAltairAuthoringHost | undefined;
  let historyService: AltairHistoryService | undefined;
  let history: AltairHistory<StoryProject> | undefined;
  let draftSession: AltairDraftSession | undefined;
  let authoringTail = Promise.resolve();
  let authoringGeneration = 0;
  const bestdoriRequestContext = computed(() => storyEditorBestdoriRequestContext(project.value, locale.value));

  const requireAdvAuthoring = (): HaneokaAdvAuthoringService => {
    if (!advAuthoring.value) throw new ReferenceError("Altair ADV authoring service is unavailable");
    return advAuthoring.value;
  };
  const requireDraftAuthoring = (): HaneokaDraftAuthoringService => {
    if (!draftAuthoring.value) throw new ReferenceError("Altair draft authoring service is unavailable");
    return draftAuthoring.value;
  };
  const requireWebGalAuthoring = (): HaneokaWebGalAuthoringService => {
    if (!webGalAuthoring.value) throw new ReferenceError("Altair WebGAL authoring service is unavailable");
    return webGalAuthoring.value;
  };
  const requireWorkspaceAuthoring = (): AltairBrowserWorkspaceService => {
    if (!workspaceAuthoring.value) throw new ReferenceError("Altair browser workspace service is unavailable");
    return workspaceAuthoring.value;
  };

  const reconcileAuthoringHost = () => {
    const targetGeneration = ++authoringGeneration;
    authoringReady.value = false;
    installedAuthoringPluginIds.value = new Set();
    const snapshot = {
      plugins: cloneStoryValue(project.value.plugins ?? []),
    };
    authoringTail = authoringTail
      .then(async () => {
        if (disposed || authoringAbort.signal.aborted) return;
        if (authoringHost) {
          await authoringHost.reconcile(snapshot, {
            signal: authoringAbort.signal,
          });
        } else {
          authoringHost = await createHaneokaAltairAuthoringHost(snapshot, {
            registry: authoringRegistry,
            signal: authoringAbort.signal,
          });
        }
        if (disposed) {
          await authoringHost.dispose();
          authoringHost = undefined;
          return;
        }
        if (targetGeneration !== authoringGeneration) return;
        const operations = authoringHost.host;
        const nextAdv = operations.service<HaneokaAdvAuthoringService>({ id: "haneoka.altair.adv" });
        const nextBestdori = operations.service<HaneokaBestdoriAuthoringService>({
          id: "haneoka.altair.bestdori.assets",
        });
        const nextDraft = operations.service<HaneokaDraftAuthoringService>({ id: "haneoka.altair.drafts" });
        const nextHistory = operations.service<AltairHistoryService>({ id: "haneoka.altair.history" });
        const nextWebGal = operations.service<HaneokaWebGalAuthoringService>({ id: "haneoka.altair.webgal" });
        const nextWorkspace = operations.service<AltairBrowserWorkspaceService>({
          id: "haneoka.altair.workspace.browser",
        });
        const nextResourceBrowsers = operations.contributions<ResourceBrowserProvider>("resource-browser");
        const installed = new Set(authoringHost.installedPluginIds);
        const requiredServices = [
          [STORY_EDITOR_AUTHORING_PLUGIN.adv, nextAdv],
          [STORY_EDITOR_AUTHORING_PLUGIN.bestdori, nextBestdori],
          [STORY_EDITOR_AUTHORING_PLUGIN.drafts, nextDraft],
          [STORY_EDITOR_AUTHORING_PLUGIN.history, nextHistory],
          [STORY_EDITOR_AUTHORING_PLUGIN.webgal, nextWebGal],
          [STORY_EDITOR_AUTHORING_PLUGIN.workspace, nextWorkspace],
        ] as const;
        const missingService = requiredServices.find(([id, service]) => installed.has(id) && !service);
        if (missingService) {
          throw new ReferenceError(`Altair authoring plugin ${missingService[0]} did not provide its declared service`);
        }
        if (nextHistory && (historyService !== nextHistory || !history || history.disposed)) {
          historyService = nextHistory;
          history = nextHistory.create("haneoka.story.project", project.value, {
            capacity: 200,
          });
        } else if (!nextHistory) {
          historyService = undefined;
          history = undefined;
        }
        draftSession = nextDraft
          ? (nextDraft.get("haneoka.story.editor") ?? (await nextDraft.open("haneoka.story.editor")))
          : undefined;
        if (workspaceAuthoring.value && workspaceAuthoring.value !== nextWorkspace) {
          clearWorkspaceView();
        }
        advAuthoring.value = nextAdv;
        bestdoriAuthoring.value = nextBestdori;
        draftAuthoring.value = nextDraft;
        webGalAuthoring.value = nextWebGal;
        workspaceAuthoring.value = nextWorkspace;
        authoringOperations.value = operations;
        resourceBrowserProviders.value = Object.freeze([...nextResourceBrowsers]);
        authoringRevision.value += 1;
        installedAuthoringPluginIds.value = installed;
        authoringReady.value = true;
        authoringError.value = "";
        refreshHistory();
        syncCode(true);
        syncSceneCode();
        scheduleCompilation();
      })
      .catch((error: unknown) => {
        if (disposed || authoringAbort.signal.aborted || targetGeneration !== authoringGeneration) return;
        authoringOperations.value = undefined;
        resourceBrowserProviders.value = [];
        advAuthoring.value = undefined;
        bestdoriAuthoring.value = undefined;
        draftAuthoring.value = undefined;
        webGalAuthoring.value = undefined;
        workspaceAuthoring.value = undefined;
        draftSession = undefined;
        installedAuthoringPluginIds.value = new Set();
        authoringReady.value = false;
        authoringError.value = error instanceof Error ? error.message : String(error);
      });
  };

  const refreshHistory = () => {
    canUndo.value = Boolean(authoringCapabilities.value.history && history?.canUndo);
    canRedo.value = Boolean(authoringCapabilities.value.history && history?.canRedo);
  };

  const syncCode = (preserveDraft = false) => {
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.drafts) return;
    const adv = requireAdvAuthoring();
    const draft = codeValue.value;
    const hadDraft = codeDirty.value || Boolean(codeDraftBase.value);
    const value = adv.serializeStoryProjectJson(project.value);
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
    if (!authoringCapabilities.value.webgal || !authoringCapabilities.value.drafts) return;
    const webgal = requireWebGalAuthoring();
    const drafts = requireDraftAuthoring();
    const sceneId = currentSceneId.value;
    const baseline = webgal.createWebGalSceneDraft(project.value, {
      sceneId,
      localeIndex: activeLocaleIndex(),
    });
    const reconciled = drafts.reconcileStorySceneCodeDraft({
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
  const hydrateWorkspaceUrls = <Value>(value: Value): Value => {
    if (!authoringCapabilities.value.webgal || !webGalAuthoring.value) return value;
    return webGalAuthoring.value.hydrateAssetUrls(value, workspaceFiles.value);
  };
  const validation = computed<StoryProjectValidationResult>(() =>
    authoringCapabilities.value.adv && advAuthoring.value
      ? advAuthoring.value.validateStoryProject(project.value)
      : {
          valid: false,
          errors: [],
          warnings: [],
        },
  );
  type StoryCompilation = ReturnType<HaneokaAdvAuthoringService["compile"]>;
  const compiled = shallowRef<StoryCompilation>();
  const rebuildCompilation = (): StoryCompilation | undefined => {
    if (
      !authoringCapabilities.value.adv ||
      !authoringCapabilities.value.vegaPreview ||
      !validation.value.valid ||
      !currentScene.value
    ) {
      compiled.value = undefined;
      compiledSceneId = currentScene.value?.id || "";
      return undefined;
    }
    try {
      const result = hydrateWorkspaceUrls(requireAdvAuthoring().compile(project.value, currentScene.value.id));
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
    const activeHistory = history;
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !activeHistory) return false;
    const previousRevision = activeHistory.revision;
    const next = activeHistory.update(
      (draft) => updater(draft as unknown as StoryProject),
      options.mergeKey ? { mergeKey: options.mergeKey } : {},
    );
    if (activeHistory.revision === previousRevision) return false;
    generation += 1;
    formatDiagnostics.value = [];
    replaceVisible(mutableHistoryProject(next));
    if (options.select !== undefined) selectedCommandId.value = options.select;
    return true;
  };

  const resetProject = (
    source: StoryProject,
    changed = true,
    invalidateRestore = true,
    options: { preserveSceneDrafts?: boolean } = {},
  ) => {
    const activeHistory = history;
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !activeHistory) return false;
    const next = withHaneokaStoryEditorPlugins(source);
    if (invalidateRestore) generation += 1;
    activeHistory.reset(next);
    currentSceneId.value = next.entrySceneId;
    selectedCommandId.value = "";
    if (!options.preserveSceneDrafts) {
      sceneCodeDrafts.value = {};
      sceneCodeContexts.value = {};
    }
    formatDiagnostics.value = [];
    replaceVisible(mutableHistoryProject(activeHistory.value), changed);
    syncCode();
    syncSceneCode();
  };

  const clearWorkspaceView = () => {
    workspaceViewGeneration += 1;
    workspaceFiles.value = [];
    workspaceName.value = "";
    workspaceSource.value = "none";
    workspacePermission.value = "none";
    workspaceRevision.value += 1;
    scheduleCompilation();
  };

  const resolveWorkspacePermission = async (
    service: AltairBrowserWorkspaceService,
    request = false,
  ): Promise<StoryEditorDirectoryPermission> => {
    if (service.current.source !== "directory-handle") return "read-only";
    const readwrite = await service.permission("readwrite", { request });
    if (readwrite === "granted") return "granted";
    const read = await service.permission("read", { request });
    if (read === "granted") return "read-only";
    return readwrite === "denied" || read === "denied" ? "denied" : "prompt";
  };

  const syncWorkspaceSnapshot = async (
    snapshot: AltairBrowserWorkspaceSnapshot,
    permission?: StoryEditorDirectoryPermission,
  ) => {
    const service = requireWorkspaceAuthoring();
    const webgal = requireWebGalAuthoring();
    const targetGeneration = ++workspaceViewGeneration;
    const files = await Promise.all(
      snapshot.files.map(async (info) => {
        const normalizedPath = info.path;
        const classified = webgal.classifyWorkspacePath(normalizedPath);
        const file = await service.file(info.path);
        const media = ["background", "figure", "image", "audio", "video"].includes(classified.kind);
        let url = "";
        if (media && service.capabilities.objectUrls) {
          try {
            url = await service.url(info.path);
          } catch {
            url = "";
          }
        }
        return {
          ...classified,
          file,
          path: normalizedPath,
          name: info.name,
          size: info.size,
          lastModified: info.lastModified,
          mediaType: info.type,
          ...(url ? { url } : {}),
        } satisfies WebGalBrowserWorkspaceFile;
      }),
    );
    const resolvedPermission = permission ?? (await resolveWorkspacePermission(service));
    if (
      disposed ||
      targetGeneration !== workspaceViewGeneration ||
      workspaceAuthoring.value !== service ||
      service.current.id !== snapshot.id
    ) {
      return false;
    }
    workspaceFiles.value = files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    workspaceName.value = snapshot.name;
    workspaceSource.value = snapshot.source === "directory-handle" ? "handle" : "input";
    workspacePermission.value = resolvedPermission;
    workspaceRevision.value += 1;
    scheduleCompilation();
    return true;
  };

  const importWorkspaceProject = async (name: string) => {
    if (!authoringCapabilities.value.webgal || !authoringCapabilities.value.history) {
      throw new ReferenceError("WebGAL authoring plugins are unavailable");
    }
    const operations = authoringOperations.value;
    if (!operations) throw new ReferenceError("Altair authoring host is unavailable");
    const result = await requireWebGalAuthoring().importBrowserWorkspace(operations, workspaceFiles.value, {
      title: name,
      releaseServer: activeProjectRelease(),
    });
    resetProject(result.project);
    formatDiagnostics.value = result.diagnostics;
    status.value = "imported";
    statusDetail.value = `WebGAL · ${result.project.scenes.length} scenes`;
    await saveNow({ announce: false });
  };

  const loadWorkspaceDirectory = async (
    handle: BrowserWorkspaceDirectoryHandle,
    options: { importProject?: boolean; requestPermission?: boolean; persist?: boolean } = {},
  ) => {
    if (!authoringCapabilities.value.workspace) return false;
    const service = requireWorkspaceAuthoring();
    workspaceLoading.value = true;
    workspaceRestoreHandle = handle;
    workspaceName.value = handle.name;
    workspaceSource.value = "handle";
    try {
      const snapshot = await service.connectDirectory(handle, {
        requestPermission: options.requestPermission === true,
      });
      const permission = await resolveWorkspacePermission(service);
      await syncWorkspaceSnapshot(snapshot, permission);
      if (options.persist !== false) {
        await service.rememberDirectory(handle, handle.name);
      }
      if (options.importProject) await importWorkspaceProject(handle.name);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        workspacePermission.value = options.requestPermission ? "denied" : "prompt";
        return false;
      }
      throw error;
    } finally {
      workspaceLoading.value = false;
    }
  };

  const canOpenProjectDirectory = computed(
    () =>
      authoringCapabilities.value.webgal &&
      authoringCapabilities.value.history &&
      authoringCapabilities.value.workspace &&
      import.meta.client &&
      Boolean(workspaceAuthoring.value?.capabilities.directoryPicker),
  );
  const openProjectDirectory = async () => {
    if (
      !authoringCapabilities.value.webgal ||
      !authoringCapabilities.value.history ||
      !authoringCapabilities.value.workspace ||
      !import.meta.client
    ) {
      return false;
    }
    const service = requireWorkspaceAuthoring();
    workspaceLoading.value = true;
    try {
      const snapshot = await service.pickDirectory({
        pickerOptions: { id: "haneoka-story-project", mode: "readwrite" },
      });
      const handle = service.directory;
      workspaceRestoreHandle = handle;
      await syncWorkspaceSnapshot(snapshot);
      if (handle) {
        await service.rememberDirectory(handle, snapshot.name);
      }
      await importWorkspaceProject(snapshot.name);
      return true;
    } finally {
      workspaceLoading.value = false;
    }
  };

  const importProjectDirectoryFiles = async (files: Iterable<File>) => {
    if (
      !authoringCapabilities.value.webgal ||
      !authoringCapabilities.value.history ||
      !authoringCapabilities.value.workspace
    ) {
      return false;
    }
    const inputFiles = [...files];
    if (!inputFiles.length) return false;
    const service = requireWorkspaceAuthoring();
    const snapshot = await service.ingestFiles(inputFiles);
    workspaceRestoreHandle = undefined;
    await syncWorkspaceSnapshot(snapshot, "read-only");
    await service.forgetDirectory();
    await importWorkspaceProject(snapshot.name);
    return true;
  };

  const refreshProjectDirectory = async (options: { importProject?: boolean } = {}) => {
    if (!authoringCapabilities.value.workspace || (options.importProject && !authoringCapabilities.value.webgal)) {
      return false;
    }
    const service = requireWorkspaceAuthoring();
    if (service.current.source !== "directory-handle") return false;
    workspaceLoading.value = true;
    try {
      const snapshot = await service.refresh();
      await syncWorkspaceSnapshot(snapshot);
      if (options.importProject) await importWorkspaceProject(snapshot.name);
      return true;
    } finally {
      workspaceLoading.value = false;
    }
  };

  const reauthorizeProjectDirectory = async () => {
    if (!authoringCapabilities.value.workspace) return false;
    const handle = requireWorkspaceAuthoring().directory ?? workspaceRestoreHandle;
    if (!handle) return false;
    return loadWorkspaceDirectory(handle, {
      requestPermission: true,
      persist: true,
    });
  };

  const disconnectProjectDirectory = async () => {
    workspaceRestoreHandle = undefined;
    workspaceAuthoring.value?.clear();
    clearWorkspaceView();
    await workspaceAuthoring.value?.forgetDirectory();
  };

  const undo = () => {
    const activeHistory = history;
    if (!authoringCapabilities.value.history || !activeHistory?.canUndo) return;
    generation += 1;
    replaceVisible(mutableHistoryProject(activeHistory.undo()));
  };

  const redo = () => {
    const activeHistory = history;
    if (!authoringCapabilities.value.history || !activeHistory?.canRedo) return;
    generation += 1;
    replaceVisible(mutableHistoryProject(activeHistory.redo()));
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history) return false;
    const command = requireAdvAuthoring().createStoryCommand(code, fields);
    return updateProject(
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
    const adv = requireAdvAuthoring();
    updateProject(
      (draft) => {
        const command = draft.scenes
          .find((scene) => scene.id === currentSceneId.value)
          ?.commands.find((item) => item.id === id);
        if (!command) return;
        if (value === undefined) {
          delete command.fields[key];
          if (key === "targetName" && command.command === adv.opcodes.Talk) delete command.fields.targets;
        } else if (key === "targetName" && command.command === adv.opcodes.Talk && typeof value === "string") {
          const names = adv.storyTargetNames(value);
          const currentTargets = Array.isArray(command.fields.targets)
            ? command.fields.targets.filter((target): target is JsonObject =>
                Boolean(target && typeof target === "object" && !Array.isArray(target)),
              )
            : [];
          command.fields.targetName = adv.storyTargetNameFromEditor(value);
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !id) return;
    history?.endMerge();
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !id) return;
    history?.endMerge();
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

  const isAdvResourceInsert = (resource: StoryEditorResourceInsert): resource is AltairAdvResourceInsert => {
    if (
      resource.kind !== "live2d" &&
      resource.kind !== "background" &&
      resource.kind !== "still" &&
      resource.kind !== "frame" &&
      resource.kind !== "effect" &&
      resource.kind !== "post-effect" &&
      resource.kind !== "video" &&
      resource.kind !== "audio"
    ) {
      return false;
    }
    return (
      resource.kind !== "audio" || resource.usage === "bgm" || resource.usage === "se" || resource.usage === "voice"
    );
  };

  const insertResource = (resource: StoryEditorResourceInsert) => {
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !isAdvResourceInsert(resource)) {
      return false;
    }
    const adv = requireAdvAuthoring();
    const command = adv.createAdvResourceCommand(resource);

    return updateProject(
      (draft) => {
        const scene = draft.scenes.find((item) => item.id === currentSceneId.value);
        if (!scene) return;
        adv.registerAdvResource(draft, resource);
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history || !isAdvResourceInsert(resource)) {
      return false;
    }
    if (target.resource && resource.kind !== target.resource) return false;
    if (resource.kind === "audio" && target.audioUsage && resource.usage !== target.audioUsage) return false;
    const adv = requireAdvAuthoring();
    return updateProject(
      (draft) => {
        const command = draft.scenes
          .find((scene) => scene.id === currentSceneId.value)
          ?.commands.find((item) => item.id === target.commandId);
        if (!command) return;
        adv.registerAdvResource(draft, resource);
        command.fields[target.fieldKey] = resource.key;
        Object.assign(command.fields, adv.advResourceFieldPatch(resource));
      },
      { select: target.commandId },
    );
  };

  const importStoryResource = (resource: StoryEditorResourceInsert) => {
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history) {
      return false;
    }
    try {
      const next = storyEditorProjectFromInsert(resource);
      if (!next) return false;
      resetProject(next);
      status.value = "imported";
      statusDetail.value = "Altair project";
      void saveNow({ announce: false });
    } catch (error) {
      status.value = "importFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const importFile = async (file: File) => {
    try {
      if (!authoringCapabilities.value.history) {
        throw new ReferenceError("History authoring plugin is unavailable");
      }
      const operations = authoringOperations.value;
      if (!operations) throw new ReferenceError("Altair authoring host is unavailable");
      const sourceServer = storyEditorBestdoriSourceServer(project.value);
      const result = await operations.importFormat({
        files: [
          {
            path: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            ...(file.type ? { mediaType: file.type } : {}),
          },
        ],
        entryPath: file.name,
        options: {
          title: safeFileStem(file.name),
          releaseServer: activeProjectRelease(),
          locale: locale.value,
          ...(sourceServer ? { server: sourceServer } : {}),
        },
      });
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.drafts) return;
    codeDraftBase.value = requireDraftAuthoring().storyJsonDraftBaseForValue(
      codeDraftBase.value,
      codeBaseline.value,
      value,
      revision.value,
    );
    codeValue.value = value;
    codeError.value = "";
  };

  const applyCode = () => {
    if (
      !authoringCapabilities.value.adv ||
      !authoringCapabilities.value.drafts ||
      !authoringCapabilities.value.history
    ) {
      return false;
    }
    if (!codeDirty.value) return true;
    try {
      const adv = requireAdvAuthoring();
      const drafts = requireDraftAuthoring();
      const result = adv.importStoryProjectJson(codeValue.value);
      const conflict = drafts.storyJsonDraftConflict({
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.drafts) return false;
    try {
      setCodeValue(requireAdvAuthoring().stringifyStoryJson(JSON.parse(codeValue.value) as JsonValue));
      codeError.value = "";
    } catch (error) {
      codeError.value = error instanceof Error ? error.message : String(error);
    }
  };

  const setSceneCodeValue = (value: string) => {
    if (!authoringCapabilities.value.webgal || !authoringCapabilities.value.drafts) return;
    sceneCodeValue.value = value;
    sceneCodeError.value = "";
    const sceneId = currentSceneId.value;
    if (value === sceneCodeBaseline.value) {
      const { [sceneId]: _discarded, ...rest } = sceneCodeDrafts.value;
      sceneCodeDrafts.value = rest;
      const { [sceneId]: _discardedContext, ...contextRest } = sceneCodeContexts.value;
      sceneCodeContexts.value = contextRest;
    } else {
      if (sceneCodeDrafts.value[sceneId] === undefined && sceneCodeContext.value) {
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
    if (!authoringCapabilities.value.webgal || !authoringCapabilities.value.drafts) return false;
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
    if (
      !authoringCapabilities.value.webgal ||
      !authoringCapabilities.value.adv ||
      !authoringCapabilities.value.drafts ||
      !authoringCapabilities.value.history
    ) {
      return false;
    }
    try {
      const webgal = requireWebGalAuthoring();
      const baselineContext = sceneCodeContexts.value[currentSceneId.value];
      const result = webgal.mergeWebGalScene(project.value, sceneCodeValue.value, {
        sceneId: currentSceneId.value,
        localeIndex: baselineContext?.localeIndex ?? activeLocaleIndex(),
        title: currentScene.value?.name || project.value.meta.title || "Scene",
        releaseServer: activeProjectRelease(),
        ...(baselineContext ? { baselineContext } : {}),
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

  const writeWorkspaceScenes = async () => {
    if (!authoringCapabilities.value.webgal || !authoringCapabilities.value.workspace) return false;
    const operations = authoringOperations.value;
    if (!operations) throw new ReferenceError("Altair authoring host is unavailable");
    const workspace = requireWorkspaceAuthoring();
    if (workspace.current.source !== "directory-handle") return false;
    workspacePermission.value = await resolveWorkspacePermission(workspace, true);
    if (workspacePermission.value !== "granted") {
      throw new DOMException("The project folder is not writable", "NotAllowedError");
    }
    const exported = await requireWebGalAuthoring().exportBrowserWorkspace(operations, project.value, {
      localeIndex: activeLocaleIndex(),
    });
    for (const artifact of exported.artifacts) {
      await workspace.write(artifact.path, artifact.bytes, { create: true });
    }
    formatDiagnostics.value = exported.diagnostics;
    await syncWorkspaceSnapshot(workspace.current, "granted");
    return true;
  };

  const saveNow = async (options: { announce?: boolean; writeProject?: boolean } = {}) => {
    if (!authoringCapabilities.value.adv || !import.meta.client || disposed) return;
    const result = requireAdvAuthoring().validateStoryProject(project.value);
    if (!result.valid) {
      status.value = "saveFailed";
      statusDetail.value = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      return;
    }
    saving.value = true;
    const targetRevision = revision.value;
    try {
      const activeDraftSession = draftSession;
      if (activeDraftSession && authoringCapabilities.value.drafts) {
        const value = JSON.stringify(
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
          } satisfies StoryEditorDraftState),
        );
        await activeDraftSession.updateProject({
          baseline: "",
          value,
          revision: revision.value,
        });
      }
      if (options.writeProject && workspaceSource.value === "handle") await writeWorkspaceScenes();
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
    if (!authoringCapabilities.value.adv || !authoringCapabilities.value.history) return false;
    await disconnectProjectDirectory();
    resetProject(createHaneokaStoryEditorProject(releaseServer.value));
    status.value = "ready";
    statusDetail.value = "";
    try {
      await draftSession?.clearProject();
      savedRevision.value = revision.value;
    } catch (error) {
      status.value = "saveFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    }
  };

  const restoreDraft = async () => {
    if (
      !authoringCapabilities.value.adv ||
      !authoringCapabilities.value.history ||
      !authoringCapabilities.value.drafts
    ) {
      restored.value = true;
      return false;
    }
    const targetGeneration = generation;
    try {
      const encoded = draftSession?.snapshot().project?.value;
      const draft = encoded ? (JSON.parse(encoded) as StoryEditorDraftState) : undefined;
      if (disposed || generation !== targetGeneration || !draft) return;
      const restoredProject = draft.project;
      const result = requireAdvAuthoring().validateStoryProject(restoredProject);
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
          const fallback = requireWebGalAuthoring().createWebGalSceneDraft(project.value, {
            sceneId,
            localeIndex: activeLocaleIndex(),
          });
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
        if (!draft.sceneCode.includes("@haneoka-lossless") && sceneCodeContext.value) {
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
      void (async () => {
        try {
          const stored = await workspaceAuthoring.value?.persistedDirectory();
          if (!stored?.handle || disposed) return;
          workspaceName.value = stored.name;
          workspaceSource.value = "handle";
          workspaceRestoreHandle = stored.handle as unknown as BrowserWorkspaceDirectoryHandle;
          await loadWorkspaceDirectory(workspaceRestoreHandle, { persist: false });
        } catch {
          workspacePermission.value = "denied";
        }
      })();
    }
  };

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value || saving.value) return;
    event.preventDefault();
    event.returnValue = "";
  };

  const authoringSelectionSignature = computed(() =>
    JSON.stringify(storyEditorAuthoringPlugins(project.value.plugins)),
  );

  watch([project, currentSceneId], scheduleCompilation, { immediate: true, flush: "post" });
  watch([project, codeValue, codeDraftBase, sceneCodeValue, sceneCodeDrafts, sceneCodeContexts], scheduleAutosave);
  watch(authoringSelectionSignature, reconcileAuthoringHost);
  watch(locale, () => syncSceneCode());

  onMounted(() => {
    window.addEventListener("beforeunload", onBeforeUnload);
    reconcileAuthoringHost();
    void authoringTail.then(() => {
      if (!disposed && authoringReady.value) return restoreDraft();
      restored.value = true;
    });
  });

  onBeforeUnmount(() => {
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    const finalSave = dirty.value ? saveNow({ announce: false }) : Promise.resolve();
    disposed = true;
    authoringAbort.abort(new DOMException("Story editor unmounted", "AbortError"));
    installedAuthoringPluginIds.value = new Set();
    authoringOperations.value = undefined;
    resourceBrowserProviders.value = [];
    authoringReady.value = false;
    void settleStoryEditorAuthoringDisposal(
      Promise.all([authoringTail, finalSave]),
      () => authoringHost?.dispose(),
      (error) => console.error("Failed to dispose the Altair authoring host", error),
    );
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
    authoringReady,
    authoringError,
    advAuthoring,
    bestdoriAuthoring,
    webGalAuthoring,
    workspaceAuthoring,
    authoringOperations,
    resourceBrowserProviders,
    bestdoriRequestContext,
    authoringRevision,
    installedAuthoringPluginIds,
    authoringCapabilities,
    runtimePlugins,
    formatDiagnostics,
    codeValue,
    codeDirty,
    codeError,
    sceneCodeValue,
    sceneCodeDirty,
    sceneCodeDraftIds,
    sceneCodeError,
    restored,
    workspaceName,
    workspaceSource,
    workspacePermission,
    workspaceLoading,
    workspaceFiles,
    workspaceRevision,
    canOpenProjectDirectory,
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
    openProjectDirectory,
    importProjectDirectoryFiles,
    refreshProjectDirectory,
    reauthorizeProjectDirectory,
    disconnectProjectDirectory,
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
