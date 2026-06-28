<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's Editor, EditorSidebar,
  MainArea, TagsManager, and Topbar components at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import {
  MaterialIcon,
  UiButton,
  UiDialog,
  UiIconButton,
  UiList,
  UiListItem,
  UiSelect,
  UiTextField,
  type UiFieldValue,
} from "@haneoka/ui";

import type { CompileStoryResult, StoryValidationIssue } from "@haneoka/story-editor";
import type { StoryEditorResourceTarget } from "~/components/tools/story-editor/StoryEditorSentenceCard.vue";
import type {
  StoryEditorProjectSceneFile,
  StoryEditorResourceInsert,
} from "~/components/tools/story-editor/StoryEditorResourceLibrary.vue";

const { t, localize, messages } = useLocale();
const copy = messages("storyEditorPage");
const view = ref<StoryEditorView>("visual");
interface StoryEditorPendingAction {
  title: string;
  confirmLabel: string;
  description?: string;
  icon?: string;
  destructive?: boolean;
  inputLabel?: string;
  initialValue?: string;
  run(value: string): Promise<void> | void;
}

const sidebarTab = ref<"resources" | "scenes">("resources");
const openedSceneIds = ref<string[]>([]);
const settingsOpen = ref(false);
const diagnosticsOpen = ref(false);
const commandPickerOpen = ref(false);
const pendingAction = shallowRef<StoryEditorPendingAction>();
const commandInsertIndex = ref<number>();
const resourceTarget = shallowRef<StoryEditorResourceTarget>();
const projectInput = ref<HTMLInputElement>();
const previewFrame = ref<HTMLElement>();
const previewPlayer = ref<{ executeTo(commandIndex: number): Promise<boolean> }>();
const editorBody = ref<HTMLElement>();
const previewCompilation = shallowRef<CompileStoryResult>();
const previewRevision = ref(0);
const previewServer = ref("");
const previewMounted = ref(false);
const previewMode = ref<"text" | "play">("play");
const previewCanPlay = ref(false);
const sidebarWidth = ref(430);
const editor = useStoryEditorWorkspace();
let previewMountFrame: number | undefined;
let previewMountTimer: number | undefined;
let previewApplyGeneration = 0;
let previewAppliedSceneId = "";
const {
  project,
  currentSceneId,
  currentScene,
  selectedCommandId,
  issues,
  compiled,
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
  sceneCodeError,
  restored,
} = editor;
openedSceneIds.value = [currentSceneId.value || project.value.entrySceneId].filter(Boolean);
const sceneEditorPath = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map(String)
        .map((segment) => segment.normalize("NFKC").trim())
        .filter(Boolean)
    : [];
const projectSceneFiles = computed<StoryEditorProjectSceneFile[]>(() =>
  project.value.scenes.map((scene) => ({
    id: scene.id,
    name: scene.name,
    path: sceneEditorPath(scene.extensions.editorPath),
    commandCount: scene.commands.length,
    isEntry: scene.id === project.value.entrySceneId,
    canDelete: project.value.scenes.length > 1,
  })),
);
const projectSceneFolders = computed(() => {
  const folders = new Map<string, string[]>();
  const addPath = (path: readonly string[]) => {
    for (let length = 1; length <= path.length; length += 1) {
      const folder = path.slice(0, length);
      folders.set(folder.join("/"), folder);
    }
  };
  const stored = project.value.extensions.sceneFolders;
  if (Array.isArray(stored)) {
    for (const value of stored) addPath(String(value).split("/").filter(Boolean));
  }
  for (const scene of projectSceneFiles.value) addPath(scene.path);
  return [...folders.values()];
});
const entrySceneOptions = computed(() => project.value.scenes.map((scene) => ({ label: scene.name, value: scene.id })));

const statusText = computed(() => {
  if (saving.value) return copy.value.saving;
  if (status.value === "imported") return t("storyEditorPage.imported", { format: statusDetail.value });
  const labels: Record<StoryEditorStatus, string> = {
    ready: copy.value.ready,
    autosaved: copy.value.autosaved,
    restored: copy.value.restored,
    imported: copy.value.ready,
    draftConflict: copy.value.draftConflict,
    importFailed: copy.value.importFailed,
    saveFailed: copy.value.saveFailed,
  };
  return labels[status.value];
});
const statusError = computed(() => ["draftConflict", "importFailed", "saveFailed"].includes(status.value));
const projectServer = computed(() => normalizeAssetServer(project.value.meta.assetServer));
const currentSceneIndex = computed(() =>
  Math.max(
    0,
    project.value.scenes.findIndex((scene) => scene.id === currentSceneId.value),
  ),
);
const executableSourceIndexes = computed<ReadonlySet<number>>(
  () => new Set(compiled.value?.commandSourceIndexes || []),
);
const editorBodyStyle = computed(() => ({ "--story-sidebar-width": `${sidebarWidth.value}px` }));
const fidelity = computed(() => {
  const result = { exact: 0, approximate: 0, unsupported: 0 };
  for (const diagnostic of formatDiagnostics.value) {
    if (diagnostic.fidelity) result[diagnostic.fidelity] += 1;
  }
  return result;
});
const requestAction = (action: StoryEditorPendingAction) => {
  pendingAction.value = action;
};

const cancelPendingAction = () => {
  pendingAction.value = undefined;
};

const confirmPendingAction = async (value: string) => {
  const action = pendingAction.value;
  if (!action) return;
  pendingAction.value = undefined;
  await action.run(value);
};

const refreshPreview = (): CompileStoryResult | undefined => {
  previewApplyGeneration += 1;
  const result = editor.compileNow();
  previewCompilation.value = result;
  previewServer.value = projectServer.value;
  previewAppliedSceneId = currentSceneId.value;
  previewRevision.value += 1;
  return result;
};

const importProjectFile = async (file: File) => {
  try {
    await editor.importFile(file);
    view.value = "visual";
    resourceTarget.value = undefined;
    refreshPreview();
  } catch {
    // Import diagnostics remain visible in the status bar.
  }
};

const onProjectInput = async (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (dirty.value) {
    requestAction({
      title: copy.value.importProject,
      description: copy.value.newProjectConfirm,
      confirmLabel: copy.value.importProject,
      icon: "upload_file",
      run: () => importProjectFile(file),
    });
    return;
  }
  await importProjectFile(file);
};

const resetProject = async () => {
  await editor.newProject();
  view.value = "visual";
  sidebarTab.value = "resources";
  resourceTarget.value = undefined;
  refreshPreview();
};

const newProject = async () => {
  if (dirty.value) {
    requestAction({
      title: copy.value.newProject,
      description: copy.value.newProjectConfirm,
      confirmLabel: copy.value.newProject,
      icon: "note_add",
      run: resetProject,
    });
    return;
  }
  await resetProject();
};

const selectScene = (id: string) => {
  if (!editor.setCurrentScene(id)) return;
  if (!openedSceneIds.value.includes(id)) openedSceneIds.value = [...openedSceneIds.value, id];
  resourceTarget.value = undefined;
};

const addSceneFromBrowser = (path: string[]) => {
  editor.addScene(path);
  const id = currentSceneId.value;
  if (id && !openedSceneIds.value.includes(id)) openedSceneIds.value = [...openedSceneIds.value, id];
};

const addFolderFromBrowser = (path: string[]) => {
  requestAction({
    title: copy.value.addFolder,
    confirmLabel: copy.value.addFolder,
    inputLabel: copy.value.addFolder,
    icon: "create_new_folder",
    run: (name) => {
      if (name.trim()) editor.addSceneFolder([...path, name]);
    },
  });
};

const renameScene = (id: string, current: string) => {
  requestAction({
    title: copy.value.renameScene,
    confirmLabel: copy.value.renameScene,
    inputLabel: copy.value.renameScene,
    initialValue: current,
    icon: "drive_file_rename_outline",
    run: (name) => editor.renameScene(id, name),
  });
};

const deleteScene = (id: string) => {
  const hasDraft = editor.hasSceneCodeDraft(id);
  requestAction({
    title: copy.value.deleteScene,
    description: hasDraft ? copy.value.deleteSceneDraftConfirm : copy.value.deleteSceneConfirm,
    confirmLabel: copy.value.deleteScene,
    icon: "delete",
    destructive: true,
    run: () => {
      if (hasDraft) editor.discardSceneCodeDraft(id);
      editor.deleteScene(id);
    },
  });
};

const openCommandPicker = (index = currentScene.value?.commands.length || 0) => {
  commandInsertIndex.value = index;
  commandPickerOpen.value = true;
};

const pickCommand = (code: number) => {
  editor.addCommand(code, commandInsertIndex.value);
  commandInsertIndex.value = undefined;
  view.value = "visual";
};

const setSidebarTab = (value: UiFieldValue) => {
  if (value === "resources" || value === "scenes") sidebarTab.value = value;
};

const setProjectTitle = (value: UiFieldValue) => editor.patchMeta({ title: String(value) });
const setEntryScene = (value: UiFieldValue) => editor.setEntryScene(String(value));

const switchView = (next: StoryEditorView) => {
  if (next === view.value) return;
  view.value = next;
};

const saveWorkspace = async () => {
  await editor.saveNow();
};

const beginResourcePick = (target: StoryEditorResourceTarget) => {
  resourceTarget.value = target;
  sidebarTab.value = "resources";
};

const onResourceInsert = (resource: StoryEditorResourceInsert) => {
  if (resource.kind === "story") {
    const importStory = () => {
      const rawTitle = resource.value.title;
      const title =
        localize(rawTitle as Parameters<typeof localize>[0]) || String(resource.value.storyKey || resource.key);
      editor.importStoryResource(resource, title);
      resourceTarget.value = undefined;
      refreshPreview();
    };
    if (dirty.value) {
      requestAction({
        title: copy.value.importStory,
        description: copy.value.newProjectConfirm,
        confirmLabel: copy.value.importStory,
        icon: "auto_stories",
        run: importStory,
      });
      return;
    }
    importStory();
    return;
  }
  if (resourceTarget.value) {
    editor.assignResource(resource, resourceTarget.value);
    resourceTarget.value = undefined;
    return;
  }
  editor.insertResource(resource);
};

const onIssueSelect = (issue: StoryValidationIssue) => {
  const match = issue.path.match(/\.scenes\[(\d+)](?:\.commands\[(\d+)])?/);
  if (!match) return;
  const scene = project.value.scenes[Number(match[1])];
  if (!scene) return;
  selectScene(scene.id);
  const command = match[2] === undefined ? undefined : scene.commands[Number(match[2])];
  selectedCommandId.value = command?.id || "";
  view.value = "visual";
  diagnosticsOpen.value = false;
};

const fullscreenPreview = async () => {
  if (!previewFrame.value || document.fullscreenElement) return;
  await previewFrame.value.requestFullscreen();
};

const executeToCommand = async ({ id, sourceIndex }: { id: string; sourceIndex: number }) => {
  selectedCommandId.value = id;
  const result = refreshPreview();
  const commandIndex = result?.commandSourceIndexes.indexOf(sourceIndex) ?? -1;
  if (commandIndex < 0) return;
  await nextTick();
  await previewPlayer.value?.executeTo(commandIndex);
};

let stopResize: (() => void) | undefined;
const beginResize = (event: PointerEvent) => {
  if (!editorBody.value) return;
  event.preventDefault();
  const rect = editorBody.value.getBoundingClientRect();
  const onMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = Math.round(Math.min(rect.width * 0.52, Math.max(300, moveEvent.clientX - rect.left)));
  };
  const onEnd = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    localStorage.setItem("story-editor-sidebar-width", String(sidebarWidth.value));
    stopResize = undefined;
  };
  stopResize?.();
  stopResize = onEnd;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd, { once: true });
};

const interactiveTarget = (target: EventTarget | null) => {
  const element = target instanceof Element ? target : undefined;
  return Boolean(element?.closest("input, select, textarea, button, a, [contenteditable='true']"));
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.composedPath().some((target) => target instanceof Element && target.matches("md-dialog"))) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveWorkspace();
    return;
  }
  if (command && event.key.toLowerCase() === "z" && !interactiveTarget(event.target)) {
    event.preventDefault();
    if (event.shiftKey) editor.redo();
    else editor.undo();
    return;
  }
  if (command && event.key.toLowerCase() === "d" && selectedCommandId.value && !interactiveTarget(event.target)) {
    event.preventDefault();
    editor.duplicateCommand(selectedCommandId.value);
    return;
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    selectedCommandId.value &&
    !interactiveTarget(event.target)
  ) {
    event.preventDefault();
    editor.deleteCommand(selectedCommandId.value);
    return;
  }
  if (event.key === "Escape") {
    pendingAction.value = undefined;
    settingsOpen.value = false;
    diagnosticsOpen.value = false;
    commandPickerOpen.value = false;
    resourceTarget.value = undefined;
  }
};

onMounted(() => {
  const storedWidth = Number(localStorage.getItem("story-editor-sidebar-width"));
  if (Number.isFinite(storedWidth) && storedWidth >= 300) sidebarWidth.value = storedWidth;
  window.addEventListener("keydown", onKeydown);
});
watch(
  () => `${currentSceneId.value}:${currentScene.value?.commands.map((command) => command.id).join(",") || ""}`,
  () => {
    if (
      resourceTarget.value &&
      !currentScene.value?.commands.some((command) => command.id === resourceTarget.value?.commandId)
    ) {
      resourceTarget.value = undefined;
    }
  },
);
watch(currentSceneId, (sceneId, previousSceneId) => {
  if (!restored.value || !sceneId || sceneId === previousSceneId || previewAppliedSceneId === sceneId) return;
  void nextTick().then(() => {
    if (restored.value && currentSceneId.value === sceneId && previewAppliedSceneId !== sceneId) refreshPreview();
  });
});
watch(restored, (ready) => {
  if (!ready) return;
  if (codeDirty.value) view.value = "project";
  else if (sceneCodeDirty.value) view.value = "webgal";
  if (previewMounted.value || previewMountFrame !== undefined || previewMountTimer !== undefined) return;
  const generation = previewApplyGeneration;
  // Give the restored command list a frame to paint before mounting WebGL and
  // hydrating the full runtime payload. The timeout also lets the deferred
  // compilation finish first in the common path.
  previewMountFrame = window.requestAnimationFrame(() => {
    previewMountFrame = undefined;
    previewMountTimer = window.setTimeout(() => {
      previewMountTimer = undefined;
      if (previewApplyGeneration === generation) refreshPreview();
      previewMounted.value = true;
    }, 100);
  });
});
onBeforeUnmount(() => {
  stopResize?.();
  if (previewMountFrame !== undefined) window.cancelAnimationFrame(previewMountFrame);
  if (previewMountTimer !== undefined) window.clearTimeout(previewMountTimer);
  window.removeEventListener("keydown", onKeydown);
});

useSeoMeta({
  title: () => `${t("storyEditor")} · haneoka`,
  description: () => t("storyEditor"),
});
</script>

<template>
  <WorkspaceScreen domain="tools" :title="t('storyEditor')" :count="commandCount" :detail-available="false">
    <template #heading-actions>
      <UiButton
        v-if="view === 'visual'"
        class="story-editor-add-command"
        tone="accent"
        aria-haspopup="dialog"
        :aria-expanded="commandPickerOpen"
        :title="copy.addCommand"
        @click="openCommandPicker()"
      >
        <template #icon><MaterialIcon name="add" :size="18" /></template>
        <span>{{ copy.addCommand }}</span>
      </UiButton>
    </template>

    <template #actions>
      <div class="story-editor-page__title-actions" role="toolbar" :aria-label="t('storyEditor')">
        <UiIconButton size="compact" :label="copy.newProject" @click="newProject">
          <MaterialIcon name="note_add" :size="16" />
        </UiIconButton>
        <UiIconButton size="compact" :label="copy.importProject" @click="projectInput?.click()">
          <MaterialIcon name="upload" :size="16" />
        </UiIconButton>
        <UiIconButton size="compact" :label="copy.save" @click="saveWorkspace">
          <MaterialIcon name="save" :size="16" />
        </UiIconButton>
        <UiIconButton size="compact" :label="copy.projectSettings" @click="settingsOpen = true">
          <MaterialIcon name="settings" :size="16" />
        </UiIconButton>
        <span class="story-editor-page__title-divider" />
        <UiIconButton size="compact" :disabled="!canUndo" :label="copy.undo" @click="editor.undo">
          <MaterialIcon name="undo" :size="16" />
        </UiIconButton>
        <UiIconButton size="compact" :disabled="!canRedo" :label="copy.redo" @click="editor.redo">
          <MaterialIcon name="redo" :size="16" />
        </UiIconButton>
      </div>
    </template>

    <div class="story-editor-workbench" :class="{ 'is-code-view': view !== 'visual' }">
      <div class="story-editor-body-scroll" data-scroll-key="story-editor-workbench-horizontal">
        <main ref="editorBody" class="story-editor-body" :style="editorBodyStyle">
          <aside class="story-editor-sidebar">
            <section class="story-editor-preview-pane">
              <header>
                <strong>{{ currentScene?.name || copy.noScene }}</strong>
                <UiIconButton size="compact" :label="t('refresh')" @click="refreshPreview">
                  <MaterialIcon name="refresh" :size="18" />
                </UiIconButton>
                <UiIconButton size="compact" :label="copy.fullscreenPreview" @click="fullscreenPreview">
                  <MaterialIcon name="fullscreen" :size="18" />
                </UiIconButton>
                <div class="story-editor-preview-pane__mode" role="group" :aria-label="t('view')">
                  <UiIconButton
                    size="compact"
                    :label="t('storyText')"
                    :pressed="previewMode === 'text'"
                    @click="previewMode = 'text'"
                  >
                    <MaterialIcon name="chat" :size="17" />
                  </UiIconButton>
                  <UiIconButton
                    size="compact"
                    :label="copy.fullPreview"
                    :pressed="previewMode === 'play'"
                    :disabled="!previewCanPlay"
                    @click="previewMode = 'play'"
                  >
                    <MaterialIcon name="movie" :size="17" />
                  </UiIconButton>
                </div>
              </header>
              <div ref="previewFrame" class="story-editor-preview-pane__frame">
                <ClientOnly v-if="previewMounted && previewCompilation">
                  <StoryEditorPreview
                    ref="previewPlayer"
                    :key="currentSceneId"
                    v-model:mode="previewMode"
                    :story="previewCompilation.story"
                    :server="previewServer"
                    :revision="previewRevision"
                    compact
                    @playback-availability="previewCanPlay = $event"
                  />
                  <template #fallback><LoadingState /></template>
                </ClientOnly>
                <LoadingState v-else-if="!previewMounted" />
                <ErrorState v-else :label="copy.previewUnavailable" />
              </div>
            </section>

            <section class="story-editor-browser">
              <div v-if="sidebarTab === 'resources'" class="story-editor-browser__resources">
                <StoryEditorResourceLibrary
                  :project-server="projectServer"
                  :preferred-kind="resourceTarget?.resource"
                  :preferred-audio-usage="resourceTarget?.audioUsage"
                  @insert="onResourceInsert"
                >
                  <template #leading>
                    <SegmentedControl
                      class="story-editor-browser__tabs"
                      :model-value="sidebarTab"
                      :options="[
                        { value: 'resources', label: copy.resources, icon: 'folder_open' },
                        { value: 'scenes', label: copy.scenes, icon: 'movie' },
                      ]"
                      :label="copy.resources"
                      @update:model-value="setSidebarTab"
                    />
                  </template>
                  <template v-if="resourceTarget" #notice>
                    <div class="story-editor-resource-target">
                      <span>{{ copy.selectResource }}</span>
                      <code>{{ resourceTarget.resource }}</code>
                      <UiIconButton size="compact" :label="t('close')" @click="resourceTarget = undefined">
                        <MaterialIcon name="close" :size="18" />
                      </UiIconButton>
                    </div>
                  </template>
                </StoryEditorResourceLibrary>
              </div>

              <div v-else class="story-editor-browser__resources">
                <StoryEditorResourceLibrary
                  :project-server="projectServer"
                  :project-scenes="projectSceneFiles"
                  :project-scene-folders="projectSceneFolders"
                  :active-scene-id="currentSceneId"
                  @select-scene="selectScene"
                  @add-scene="addSceneFromBrowser"
                  @add-folder="addFolderFromBrowser"
                  @rename-scene="renameScene"
                  @delete-scene="deleteScene"
                >
                  <template #leading>
                    <SegmentedControl
                      class="story-editor-browser__tabs"
                      :model-value="sidebarTab"
                      :options="[
                        { value: 'resources', label: copy.resources, icon: 'folder_open' },
                        { value: 'scenes', label: copy.scenes, icon: 'movie' },
                      ]"
                      :label="copy.resources"
                      @update:model-value="setSidebarTab"
                    />
                  </template>
                </StoryEditorResourceLibrary>
              </div>
            </section>

            <div
              class="story-editor-sidebar__divider"
              role="separator"
              aria-orientation="vertical"
              @pointerdown="beginResize"
            />
          </aside>

          <section class="story-editor-mainarea">
            <StoryEditorSceneTabs
              v-model="openedSceneIds"
              :scenes="project.scenes"
              :current-id="currentSceneId"
              :entry-id="project.entrySceneId"
              @select="selectScene"
              @add="editor.addScene"
            />

            <StoryEditorSentenceList
              v-if="view === 'visual'"
              :commands="currentScene?.commands || []"
              :selected-id="selectedCommandId"
              :issues="issues"
              :scene-index="currentSceneIndex"
              :executable-source-indexes="executableSourceIndexes"
              @select="selectedCommandId = $event"
              @patch="editor.patchCommand($event.id, $event.key, $event.value)"
              @replace="editor.replaceCommand($event.id, $event.fields)"
              @duplicate="editor.duplicateCommand"
              @remove="editor.deleteCommand"
              @move="editor.moveCommand($event.id, $event.index)"
              @request-add="openCommandPicker"
              @pick-resource="beginResourcePick"
              @execute-to="executeToCommand"
            />

            <ClientOnly v-else-if="view === 'graph'">
              <LazyStoryEditorGraph
                :commands="currentScene?.commands || []"
                :selected-id="selectedCommandId"
                @select="selectedCommandId = $event"
                @move="editor.moveCommand($event.id, $event.index)"
              />
              <template #fallback><LoadingState /></template>
            </ClientOnly>

            <StoryEditorCode
              v-else-if="view === 'webgal'"
              :model-value="sceneCodeValue"
              :label="copy.webgalCode"
              language="WebGAL"
              :dirty="sceneCodeDirty"
              :error="sceneCodeError"
              :can-format="false"
              @update:model-value="editor.setSceneCodeValue"
              @apply="editor.applySceneCode"
              @discard="editor.discardSceneCodeDraft()"
            />

            <StoryEditorCode
              v-else
              :model-value="codeValue"
              :label="copy.projectCode"
              language="JSON"
              :dirty="codeDirty"
              :error="codeError"
              @update:model-value="editor.setCodeValue"
              @apply="editor.applyCode"
              @discard="editor.discardCodeDraft"
              @format="editor.formatCode"
            />

            <section v-if="diagnosticsOpen" class="story-editor-diagnostics" :aria-label="copy.diagnostics">
              <header>
                <strong>{{ copy.diagnostics }}</strong>
                <span class="display-number">{{ issues.length }}</span>
                <UiIconButton size="compact" :label="t('close')" @click="diagnosticsOpen = false">
                  <MaterialIcon name="close" :size="18" />
                </UiIconButton>
              </header>
              <UiList class="story-editor-diagnostics__list">
                <UiListItem
                  v-for="issue in issues"
                  :key="`${issue.code}:${issue.path}`"
                  type="button"
                  @click="onIssueSelect(issue)"
                >
                  <template #headline>
                    <strong>{{ issue.code }}</strong>
                  </template>
                  <template #supporting>{{ issue.message }}</template>
                </UiListItem>
              </UiList>
            </section>
          </section>
        </main>
      </div>

      <footer class="story-editor-statusbar">
        <span class="story-editor-statusbar__message" :class="{ 'is-error': statusError }">{{ statusText }}</span>
        <span v-if="statusDetail && status !== 'imported'" class="story-editor-statusbar__detail">
          {{ statusDetail }}
        </span>
        <span class="story-editor-statusbar__spacer" />
        <UiButton
          v-if="issues.length"
          class="story-editor-statusbar__issues"
          tone="text"
          @click="diagnosticsOpen = !diagnosticsOpen"
        >
          {{ copy.diagnostics }} {{ issues.length }}
        </UiButton>
        <span class="story-editor-statusbar__metric">
          {{ t("storyEditorPage.sceneCount", { count: project.scenes.length }) }}
        </span>
        <span class="story-editor-statusbar__metric">
          {{ t("storyEditorPage.commandCount", { count: commandCount }) }}
        </span>
        <span v-if="fidelity.approximate" class="story-editor-statusbar__metric">≈ {{ fidelity.approximate }}</span>
        <span v-if="fidelity.unsupported" class="story-editor-statusbar__metric is-error">
          × {{ fidelity.unsupported }}
        </span>
        <span v-if="dirty" class="story-editor-statusbar__dirty" aria-hidden="true">●</span>
        <span class="story-editor-statusbar__mode-separator" aria-hidden="true" />
        <StoryEditorModeSwitch :model-value="view" @update:model-value="switchView" />
      </footer>
    </div>

    <StoryEditorCommandPicker v-model="commandPickerOpen" @pick="pickCommand" />

    <EditorActionDialog
      :open="Boolean(pendingAction)"
      :title="pendingAction?.title || ''"
      :description="pendingAction?.description"
      :confirm-label="pendingAction?.confirmLabel || ''"
      :cancel-label="t('cancel')"
      :icon="pendingAction?.icon"
      :destructive="pendingAction?.destructive"
      :input-label="pendingAction?.inputLabel"
      :initial-value="pendingAction?.initialValue"
      @cancel="cancelPendingAction"
      @confirm="confirmPendingAction"
    />

    <UiDialog class="story-editor-dialog" :open="settingsOpen" @cancel="settingsOpen = false">
      <template #headline>
        <span class="story-editor-dialog__headline">
          <MaterialIcon name="settings" :size="24" />
          <strong>{{ copy.projectSettings }}</strong>
          <UiIconButton size="compact" :label="t('close')" @click="settingsOpen = false">
            <MaterialIcon name="close" :size="20" />
          </UiIconButton>
        </span>
      </template>
      <template #content>
        <div class="story-editor-dialog__fields">
          <UiTextField :model-value="project.meta.title" :label="copy.title" @update:model-value="setProjectTitle" />
          <UiTextField :model-value="project.meta.assetServer || ''" :label="copy.assetServer" readonly />
          <UiSelect
            :model-value="project.entrySceneId"
            :options="entrySceneOptions"
            :label="copy.entryScene"
            @update:model-value="setEntryScene"
          />
        </div>
      </template>
      <template #actions>
        <UiButton tone="text" @click="settingsOpen = false">{{ t("close") }}</UiButton>
      </template>
    </UiDialog>

    <input
      ref="projectInput"
      class="sr-only"
      type="file"
      accept=".json,.txt,.asset,application/json,text/plain"
      @change="onProjectInput"
    />
  </WorkspaceScreen>
</template>

<style scoped>
.story-editor-page__title-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.story-editor-add-command {
  min-height: var(--md-comp-control-height-compact);
  --md-filled-tonal-button-container-height: var(--md-comp-control-height-compact);
  --md-filled-tonal-button-label-text-size: var(--md-sys-typescale-label-medium-size);
}

.story-editor-page__title-divider {
  width: 1px;
  height: 22px;
  margin-inline: 2px;
  background: var(--md-sys-color-outline);
}

.story-editor-workbench {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(1120px, 1fr);
  grid-template-rows: minmax(0, 1fr) 28px;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--md-sys-color-surface-container-lowest);
  overscroll-behavior-x: contain;
  scrollbar-gutter: stable;
  touch-action: pan-x pan-y;
}

.story-editor-workbench.is-code-view {
  grid-template-rows: minmax(0, 1fr) 28px;
}

.story-editor-body-scroll {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.story-editor-body {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(300px, var(--story-sidebar-width)) minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.story-editor-sidebar {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 4px;
  padding: 0 4px 4px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.story-editor-preview-pane {
  display: grid;
  min-width: 0;
  flex: 0 0 auto;
  grid-template-rows: 30px auto;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-highest);
}

.story-editor-preview-pane > header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 0 5px 0 8px;
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container);
  font-family: var(--md-sys-typescale-label-medium-font);
}

.story-editor-preview-pane > header strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: var(--md-sys-typescale-label-medium-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-editor-preview-pane__mode {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 1px;
  padding-inline-start: 3px;
  border-inline-start: 1px solid var(--md-sys-color-outline-variant);
}

.story-editor-preview-pane__frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--md-sys-color-scrim);
}

.story-editor-preview-pane__frame:fullscreen {
  width: 100vw;
  height: 100vh;
  aspect-ratio: auto;
}

.story-editor-preview-pane__frame > :deep(*) {
  width: 100%;
  height: 100%;
}

.story-editor-browser {
  display: block;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
}

.story-editor-browser__tabs {
  flex: 0 0 auto;
  padding: 0;
}

.story-editor-browser__tabs :deep(.md3-segments) {
  width: 100%;
  min-height: var(--md-comp-control-height-compact);
}

.story-editor-browser__tabs :deep(.md3-segments__option) {
  min-width: 0;
  flex: 1;
}

.story-editor-browser__resources {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.story-editor-resource-target {
  display: flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 9px;
  color: var(--md-sys-color-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--md-sys-color-secondary) 24%, transparent);
  background: color-mix(in srgb, var(--md-sys-color-secondary) 7%, transparent);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-editor-resource-target code {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--md-sys-color-outline);
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-editor-sidebar__divider {
  position: absolute;
  z-index: 2;
  top: 4px;
  right: -2px;
  bottom: 4px;
  width: 6px;
  cursor: ew-resize;
}

.story-editor-sidebar__divider::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  content: "";
}

.story-editor-sidebar__divider:hover::after,
.story-editor-sidebar__divider:active::after {
  background: var(--md-sys-color-primary);
}

.story-editor-mainarea {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 35px minmax(0, 1fr);
  overflow: hidden;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  border-left: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small) 0 0;
}

.story-editor-diagnostics {
  position: absolute;
  z-index: var(--md-sys-z-index-local-raised);
  right: 8px;
  bottom: 8px;
  display: grid;
  width: min(420px, calc(100% - 16px));
  max-height: min(420px, calc(100% - 16px));
  grid-template-rows: 48px minmax(0, 1fr);
  overflow: auto;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level3);
}

.story-editor-diagnostics > header {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 7px 0 10px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: inherit;
  font-family: var(--md-sys-typescale-title-small-font);
}

.story-editor-diagnostics > header strong {
  flex: 1;
  font-size: var(--md-sys-typescale-title-small-size);
}

.story-editor-diagnostics > header span {
  color: var(--md-sys-color-outline);
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-editor-diagnostics__list {
  min-height: 0;
  overflow: auto;
  --md-list-container-color: var(--md-sys-color-surface-container-high);
}

.story-editor-diagnostics__list :deep(.md3-list-item) {
  --md-list-item-two-line-container-height: 56px;
}

.story-editor-diagnostics__list strong {
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
}

.story-editor-statusbar {
  position: relative;
  z-index: var(--md-sys-z-index-local-raised);
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  overflow: visible;
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  white-space: nowrap;
}

.story-editor-statusbar__message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.story-editor-statusbar .is-error {
  color: var(--md-sys-color-error);
}

.story-editor-statusbar__detail {
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.story-editor-statusbar__spacer {
  flex: 1;
}

.story-editor-statusbar__mode-separator {
  width: 1px;
  height: 16px;
  flex: 0 0 1px;
  background: var(--md-sys-color-outline-variant);
}

.story-editor-statusbar__issues {
  min-height: 24px;
  --md-text-button-container-height: 24px;
  --md-text-button-leading-space: var(--md-sys-spacing-1);
  --md-text-button-trailing-space: var(--md-sys-spacing-1);
  --md-text-button-label-text-color: var(--md-sys-color-error);
  --md-text-button-label-text-size: var(--md-sys-typescale-label-small-size);
}

.story-editor-statusbar__dirty {
  color: var(--md-sys-color-primary);
}

.story-editor-dialog {
  width: min(480px, calc(100vw - var(--md-sys-spacing-6)));
  max-width: 480px;
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
  --md-dialog-container-shape: var(--md-sys-shape-corner-extra-large);
}

.story-editor-dialog__headline {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.story-editor-dialog__headline strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-editor-dialog__fields {
  display: grid;
  gap: var(--md-sys-spacing-4);
  padding-block: var(--md-sys-spacing-1);
}

.story-editor-dialog__fields > * {
  width: 100%;
}
</style>
