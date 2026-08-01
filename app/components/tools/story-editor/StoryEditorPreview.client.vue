<script setup lang="ts">
import type { JsonObject, JsonValue, StoryProjectPlugin } from "@haneoka/altair";
import type { AltairPreviewSession } from "@haneoka/altair/plugins";
import type { AltairAdvService } from "@haneoka/altair-plugin-adv";
import type { AltairVegaPreviewService } from "@haneoka/altair-plugin-vega-preview";
import type {
  VegaPreviewBreakpoint,
  VegaPreviewIdentity,
  VegaPreviewReferenceFrameResult,
  VegaPreviewStageSnapshot,
  VegaPreviewTransform,
  VegaPreviewTransformResult,
} from "@haneoka/vega-protocol";
import type { AdvStory, StoryUiSprites } from "@haneoka/vega";
import type { AltairAuthoringHostPort } from "~/features/story/altairAuthoring";
import { createHaneokaStoryPlugins } from "~/features/story/haneokaStoryRenderer";
import { hydrateStoryPayload } from "~/features/story/hydrate";
import { mergeStoryRuntime } from "~/features/story/runtime";
import { createStoryEditorPreviewStartupLifecycle } from "~/features/story/storyEditorPreviewLifecycle";
import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";

interface StoryEditorPreviewDebugState {
  readonly ready: boolean;
  readonly snapshot?: VegaPreviewStageSnapshot;
  readonly stopped?: {
    readonly reason: "pause" | "breakpoint" | "step" | "end";
    readonly sceneId: string;
    readonly commandIndex: number;
  };
  readonly error?: string;
}

const props = withDefaults(
  defineProps<{
    story: Record<string, unknown>;
    releaseServer: string;
    revision: number;
    sceneId?: string;
    compact?: boolean;
    plugins?: readonly StoryProjectPlugin[];
    authoringHost: AltairAuthoringHostPort;
    adv: Pick<AltairAdvService, "storyResourceAliases">;
  }>(),
  { sceneId: "scene", compact: false },
);

const emit = defineEmits<{
  playbackAvailability: [available: boolean];
  debugState: [state: StoryEditorPreviewDebugState];
}>();

const runtimeRequest = useCatalogDocument<Record<string, unknown>>("story-runtime", () =>
  ourNotesReleaseOrigin(props.releaseServer),
);
const mode = defineModel<"text" | "play">("mode", { default: "play" });
const protocolMount = ref<HTMLElement>();
const hydrated = shallowRef<AdvStory>();
const hydrateError = shallowRef<unknown>();
const protocolReady = ref(false);
const debugSnapshot = shallowRef<VegaPreviewStageSnapshot>();
const debugStopped = shallowRef<StoryEditorPreviewDebugState["stopped"]>();
const debugError = ref("");
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let previewSession: AltairPreviewSession | undefined;
let syncController: AbortController | undefined;
const previewStartup = createStoryEditorPreviewStartupLifecycle();

interface PreviewRuntimeResources {
  readonly controller: AbortController;
  mountRegistration?: { dispose(): void };
  profileRegistration?: { dispose(): void };
  session?: AltairPreviewSession;
  stopEvents?: () => void;
}

let activePreviewResources: PreviewRuntimeResources | undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const mergedRuntime = computed<Record<string, unknown>>(() =>
  mergeStoryRuntime(runtimeRequest.data.value, props.story.runtime),
);

const uiSprites = computed<StoryUiSprites | undefined>(() => {
  const value = record(mergedRuntime.value.uiSprites);
  const prefix = `${runtimeRootForRelease(props.releaseServer)}/`;
  const keys = ["tapNext", "tapNextGlow", "next", "psychEdge", "psychLine", "choice", "choiceActive"];
  if (!keys.every((key) => typeof value[key] === "string" && String(value[key]).startsWith(prefix))) return undefined;
  return value as unknown as StoryUiSprites;
});

watch([hydrated, protocolReady], ([story, ready]) => emit("playbackAvailability", Boolean(story && ready)), {
  immediate: true,
});

const emitDebugState = () => {
  emit("debugState", {
    ready: protocolReady.value,
    ...(debugSnapshot.value ? { snapshot: debugSnapshot.value } : {}),
    ...(debugStopped.value ? { stopped: debugStopped.value } : {}),
    ...(debugError.value ? { error: debugError.value } : {}),
  });
};

const asStageSnapshot = (value: unknown): VegaPreviewStageSnapshot | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<VegaPreviewStageSnapshot>;
  return typeof snapshot.sceneId === "string" &&
    Number.isSafeInteger(snapshot.commandIndex) &&
    Number.isSafeInteger(snapshot.commandCount)
    ? (snapshot as VegaPreviewStageSnapshot)
    : undefined;
};

const onPreviewEvent = (value: JsonValue) => {
  const event = record(value);
  if (event.event === "runtime.state") {
    const snapshot = asStageSnapshot(event.snapshot);
    if (snapshot) debugSnapshot.value = snapshot;
  } else if (event.event === "runtime.stopped") {
    const reason = event.reason;
    if (
      (reason === "pause" || reason === "breakpoint" || reason === "step" || reason === "end") &&
      typeof event.sceneId === "string" &&
      Number.isSafeInteger(event.commandIndex)
    ) {
      debugStopped.value = {
        reason,
        sceneId: event.sceneId,
        commandIndex: Number(event.commandIndex),
      };
    }
  } else if (event.event === "runtime.diagnostic" && typeof event.code === "string") {
    debugError.value = `${event.code}: ${event.message}`;
  }
  emitDebugState();
};

const protocolIdentity = (): VegaPreviewIdentity => {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    workspaceId: "haneoka",
    projectId: "story-editor",
    editorSessionId: `editor-${suffix}`,
    runtimeInstanceId: `runtime-${suffix}`,
  };
};

const disposePreviewResources = async (resources: PreviewRuntimeResources, reason?: unknown): Promise<void> => {
  if (!resources.controller.signal.aborted) {
    resources.controller.abort(reason ?? new DOMException("Story preview runtime released", "AbortError"));
  }
  resources.stopEvents?.();
  resources.stopEvents = undefined;
  await Promise.resolve(resources.session?.dispose()).catch(() => undefined);
  if (previewSession === resources.session) previewSession = undefined;
  resources.session = undefined;
  resources.mountRegistration?.dispose();
  resources.mountRegistration = undefined;
  resources.profileRegistration?.dispose();
  resources.profileRegistration = undefined;
  if (activePreviewResources === resources) activePreviewResources = undefined;
};

const startProtocolRuntime = async (): Promise<void> => {
  if (previewSession && protocolReady.value) return;
  return previewStartup.start(async (attempt) => {
    const mount = protocolMount.value;
    if (!mount) throw new ReferenceError("Preview runtime mount is unavailable");
    const service = props.authoringHost.service<AltairVegaPreviewService>({
      id: "haneoka.altair.services.vega-preview",
    });
    if (!service) throw new ReferenceError("Altair Vega preview service is unavailable");
    const identity = protocolIdentity();
    const mountId = `haneoka-${identity.runtimeInstanceId}`;
    const profileId = `haneoka-${identity.editorSessionId}`;
    const resources: PreviewRuntimeResources = {
      controller: new AbortController(),
    };
    activePreviewResources = resources;
    try {
      resources.mountRegistration = service.registerMount(mountId, mount);
      resources.profileRegistration = service.registerRuntimeProfile(profileId, {
        officialPlugins: createHaneokaStoryPlugins(props.plugins, { inputScope: mount }),
        renderBackend: "vega-three-webgl2",
      });
      const session = await props.authoringHost.createPreview("vega", {
        identity: identity as unknown as JsonObject,
        signal: resources.controller.signal,
        options: {
          mountId,
          runtimeProfileId: profileId,
          autoSync: false,
        },
      });
      resources.session = session;
      if (!attempt.isCurrent()) {
        await disposePreviewResources(resources);
        return;
      }
      resources.stopEvents = session.onEvent?.(onPreviewEvent);
      if (!attempt.isCurrent()) {
        await disposePreviewResources(resources);
        return;
      }
      previewSession = session;
      protocolReady.value = true;
      debugError.value = "";
      emitDebugState();
      await syncProtocolScene();
    } catch (error) {
      await disposePreviewResources(resources, error);
      if (attempt.isCurrent()) {
        protocolReady.value = false;
        debugError.value = error instanceof Error ? error.message : String(error);
        emitDebugState();
      }
      throw error;
    }
  });
};

const syncProtocolScene = async (commandIndex?: number): Promise<boolean> => {
  const session = previewSession;
  const story = hydrated.value;
  if (!session || !protocolReady.value || !story) return false;
  syncController?.abort();
  const controller = new AbortController();
  syncController = controller;
  try {
    const response = record(
      await session.request(
        {
          name: "editor.sync-scene",
          sceneId: props.sceneId,
          sceneRevision: String(props.revision),
          story: story as unknown as JsonValue,
          ...(commandIndex === undefined ? {} : { commandIndex }),
        },
        { signal: controller.signal },
      ),
    );
    if (controller.signal.aborted || response.status === "superseded") return false;
    if (response.status === "rejected") {
      throw new Error(String(record(response.error).message || "Preview scene sync was rejected"));
    }
    debugStopped.value = undefined;
    debugError.value = "";
    await refreshDebug();
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    debugError.value = error instanceof Error ? error.message : String(error);
    emitDebugState();
    return false;
  } finally {
    if (syncController === controller) syncController = undefined;
  }
};

const rebuild = () => {
  hydrateError.value = undefined;
  try {
    hydrated.value = hydrateStoryPayload(
      { ...props.story, runtime: mergedRuntime.value },
      {
        missingResource: "omit",
        resourceAliases: props.adv.storyResourceAliases,
      },
    ) as AdvStory;
  } catch (error) {
    hydrated.value = {
      ...props.story,
      runtime: mergedRuntime.value,
      commands: Array.isArray(props.story.commands) ? props.story.commands : [],
    } as AdvStory;
    hydrateError.value = error;
    mode.value = "text";
  }
  if (protocolReady.value) void syncProtocolScene();
  else if (protocolMount.value) void startProtocolRuntime().catch(() => undefined);
};

const scheduleRebuild = () => {
  if (!hydrated.value) {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = undefined;
    rebuild();
    return;
  }
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    rebuild();
  }, 180);
};

const flushRebuild = () => {
  if (!rebuildTimer) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = undefined;
  rebuild();
};

watch(
  [() => props.story, () => props.revision, () => runtimeRequest.data.value, () => props.releaseServer],
  scheduleRebuild,
  { immediate: true },
);

const requireProtocolSession = async (): Promise<AltairPreviewSession> => {
  await startProtocolRuntime();
  if (!previewSession) throw new ReferenceError("Vega preview session is unavailable");
  return previewSession;
};

const runScene = async (commandIndex = 0): Promise<boolean> => {
  flushRebuild();
  const session = await requireProtocolSession();
  if (!(await syncProtocolScene(commandIndex))) return false;
  const response = record(await session.request({ name: "editor.run-scene", commandIndex }));
  if (response.status !== "executed") return false;
  mode.value = "play";
  return true;
};

const runFrom = async (commandIndex: number): Promise<boolean> => {
  flushRebuild();
  const session = await requireProtocolSession();
  if (!(await syncProtocolScene(commandIndex))) return false;
  const response = record(await session.request({ name: "editor.run-from", commandIndex }));
  if (response.status !== "executed") return false;
  mode.value = "play";
  return true;
};

const executeTo = runFrom;

const runSnippet = async (commands: readonly Record<string, unknown>[], label?: string): Promise<boolean> => {
  const session = await requireProtocolSession();
  if (!(await syncProtocolScene())) return false;
  const response = record(
    await session.request({
      name: "editor.run-snippet",
      commands: commands as unknown as JsonValue,
      ...(label ? { label } : {}),
    }),
  );
  await refreshDebug();
  return response.status === "executed";
};

const setBreakpoints = async (breakpoints: readonly VegaPreviewBreakpoint[]): Promise<boolean> => {
  const session = await requireProtocolSession();
  const response = record(
    await session.request({
      name: "debug.breakpoints.set",
      breakpoints: breakpoints as unknown as JsonValue,
    }),
  );
  await refreshDebug();
  return response.status === "executed";
};

const pause = async (): Promise<boolean> => {
  const response = record(await (await requireProtocolSession()).request({ name: "runtime.pause" }));
  return response.status === "executed";
};

const continueDebug = async (): Promise<boolean> => {
  const response = record(await (await requireProtocolSession()).request({ name: "debug.continue" }));
  return response.status === "executed";
};

const step = async (): Promise<boolean> => {
  const response = record(await (await requireProtocolSession()).request({ name: "debug.step" }));
  return response.status === "executed";
};

const refreshDebug = async (): Promise<VegaPreviewStageSnapshot | undefined> => {
  const session = previewSession;
  if (!session || !protocolReady.value) return undefined;
  const response = record(await session.request({ name: "stage.snapshot" }));
  const snapshot = asStageSnapshot(response.result);
  if (snapshot) {
    debugSnapshot.value = snapshot;
    emitDebugState();
  }
  return snapshot;
};

const inspectReferenceFrame = async (target: string): Promise<VegaPreviewReferenceFrameResult | undefined> => {
  const response = record(
    await (
      await requireProtocolSession()
    ).request({
      name: "stage.reference-frame",
      target,
    }),
  );
  return response.status === "executed" ? (response.result as unknown as VegaPreviewReferenceFrameResult) : undefined;
};

const setStageTransform = async (
  target: string,
  transform: VegaPreviewTransform,
  phase: "preview" | "commit" = "commit",
): Promise<VegaPreviewTransformResult | undefined> => {
  const response = record(
    await (
      await requireProtocolSession()
    ).request({
      name: "stage.transform.set",
      target,
      transform: transform as unknown as JsonObject,
      phase,
    }),
  );
  await refreshDebug();
  return response.status === "executed" ? (response.result as unknown as VegaPreviewTransformResult) : undefined;
};

const focusProtocolRuntime = (event: PointerEvent) => {
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
};

onMounted(() => {
  void startProtocolRuntime().catch(() => undefined);
});

onBeforeUnmount(() => {
  previewStartup.invalidate();
  syncController?.abort();
  if (rebuildTimer) clearTimeout(rebuildTimer);
  protocolReady.value = false;
  const resources = activePreviewResources;
  if (resources) void disposePreviewResources(resources, new DOMException("Story preview unmounted", "AbortError"));
});

defineExpose({
  executeTo,
  runScene,
  runFrom,
  runSnippet,
  setBreakpoints,
  pause,
  continueDebug,
  step,
  refreshDebug,
  inspectReferenceFrame,
  setStageTransform,
});
</script>

<template>
  <div
    class="story-editor-preview"
    :class="{ 'is-compact': compact, 'is-degraded': Boolean(hydrateError || runtimeRequest.error.value) }"
  >
    <div
      ref="protocolMount"
      class="story-editor-preview__protocol-runtime"
      :class="{ 'is-hidden': mode !== 'play' }"
      :aria-hidden="mode !== 'play'"
      :tabindex="mode === 'play' ? 0 : -1"
      data-story-preview-input-scope
      @pointerdown.capture="focusProtocolRuntime"
    />
    <LoadingState v-if="!hydrated || (mode === 'play' && !protocolReady)" />
    <StoryRuntime
      v-else-if="mode === 'text'"
      mode="text"
      :story="hydrated"
      :ui-sprites="uiSprites"
      :release-server="releaseServer"
      :show-mode-control="false"
      :show-rotation-controls="false"
    />
  </div>
</template>

<style scoped>
.story-editor-preview {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #060a16;
}

.story-editor-preview__protocol-runtime {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  outline: none;
}

.story-editor-preview__protocol-runtime.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

.story-editor-preview :deep(.story-runtime),
.story-editor-preview :deep(.loading-state),
.story-editor-preview :deep(.error-state) {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.story-editor-preview.is-compact :deep(.story-runtime__dock) {
  padding-inline: 6px;
}

.story-editor-preview.is-compact :deep(.story-runtime__settings) {
  width: min(300px, calc(100% - 20px));
}
</style>
