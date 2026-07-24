<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiLinearProgress, UiList, UiListItem } from "@haneoka/ui";

import type { AssetTreeNode } from "~/composables/useAssetExplorer";
import { assetGroupOf, assetPathSegments, assetTreeNode, encodeAssetPath } from "~/composables/useAssetExplorer";
import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";

interface DirectoryEntry {
  name: string;
  path: string[];
  count: number;
  bundle: boolean;
}

interface DirectoryColumn {
  key: string;
  label: string;
  entries: DirectoryEntry[];
}

interface SourceDescriptor {
  outputs?: Array<{ path?: string }>;
  objectArchive?: { path?: string };
}

const route = useRoute();
const router = useRouter();
const config = useRuntimeConfig();
const { t } = useLocale();
const { releaseServer: server } = useReleaseServer();
const selectedFile = useRouteQueryText("file");
const fileLayer = useRouteQueryLayer("file");
const columnsViewport = ref<HTMLElement>();
const rememberedColumnScrollLeft = useState<number>("asset-explorer:column-scroll-left", () => 0);
const canScrollBackward = ref(false);
const canScrollForward = ref(false);
let columnsResizeObserver: ResizeObserver | undefined;
let mobileColumnsQuery: MediaQueryList | undefined;

const segments = computed(() => assetPathSegments(route.params.path));
const path = computed(() => segments.value.join("/"));

const {
  data: tree,
  pending: treePending,
  error: treeError,
  refresh: refreshTree,
} = useAsyncData<Record<string, AssetTreeNode>>(
  () => `asset-tree:${server.value}`,
  () =>
    $fetch<Record<string, AssetTreeNode>>(
      catalogApiUrl(config.public.apiBase, ourNotesReleaseOrigin(server.value), "sources/tree"),
    ),
  { deep: false, server: false, default: () => ({}) },
);

const node = computed(() => assetTreeNode(tree.value, segments.value));
const leaf = computed(() => typeof node.value === "number");
const siblingBundlePath = (target: string[], current = segments.value) =>
  target.length > 0 &&
  target.length === current.length &&
  target.slice(0, -1).join("\0") === current.slice(0, -1).join("\0") &&
  typeof assetTreeNode(tree.value, target) === "number" &&
  typeof assetTreeNode(tree.value, current) === "number";

const assetRoute = (parts: string[] = []) => ({
  path: parts.length ? `/catalog/assets/${encodeAssetPath(parts)}` : "/catalog/assets",
  query: {
    ...route.query,
    file: selectedFile.value && siblingBundlePath(parts) ? selectedFile.value : undefined,
  },
});
const assetHref = (parts: string[]) => router.resolve(assetRoute(parts)).href;
const assetRouteWithoutFile = (parts: string[] = segments.value) => ({
  path: parts.length ? `/catalog/assets/${encodeAssetPath(parts)}` : "/catalog/assets",
  query: { ...route.query, file: undefined },
});

const sortEntries = (branch: Record<string, AssetTreeNode>, prefix: string[]): DirectoryEntry[] =>
  Object.entries(branch)
    .map(([name, value]) => ({
      name,
      path: [...prefix, name],
      count: typeof value === "number" ? value : Object.keys(value).length,
      bundle: typeof value === "number",
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }));

const directoryColumns = computed<DirectoryColumn[]>(() => {
  const columns: DirectoryColumn[] = [];
  for (let depth = 0; depth <= segments.value.length; depth += 1) {
    const prefix = segments.value.slice(0, depth);
    const branch = assetTreeNode(tree.value, prefix);
    if (!branch || typeof branch !== "object") break;
    if (depth > 0 && !Object.keys(branch).length) break;
    columns.push({
      key: prefix.join("/") || "root",
      label: prefix.at(-1) || t("assets"),
      entries: sortEntries(branch, prefix),
    });
  }
  return columns;
});

const files = shallowRef<string[]>([]);
const filesPending = ref(false);
const filesError = shallowRef<unknown>();
let filesRequest: AbortController | undefined;

const refreshFiles = async () => {
  filesRequest?.abort();
  filesError.value = undefined;
  if (import.meta.server || !leaf.value || !path.value) {
    files.value = [];
    selectedFile.value = "";
    filesPending.value = false;
    return;
  }

  const request = new AbortController();
  filesRequest = request;
  filesPending.value = true;
  try {
    const descriptor = await $fetch<SourceDescriptor>(
      catalogApiUrl(config.public.apiBase, ourNotesReleaseOrigin(server.value), `sources/${path.value}`),
      { signal: request.signal },
    );
    if (request.signal.aborted) return;
    const nextFiles = [
      ...(descriptor.outputs || []).map((output) => output.path).filter((value): value is string => Boolean(value)),
      ...(descriptor.objectArchive?.path ? [descriptor.objectArchive.path] : []),
    ];
    files.value = nextFiles;
    if (selectedFile.value && !nextFiles.includes(selectedFile.value)) selectedFile.value = nextFiles[0] || "";
  } catch (reason) {
    if (!request.signal.aborted) filesError.value = reason;
  } finally {
    if (filesRequest === request) {
      filesRequest = undefined;
      filesPending.value = false;
    }
  }
};

watch([path, leaf, server], () => void refreshFiles(), { immediate: true });

const assetOutputName = (file: string) => file.split("/").at(-1) || file;
const currentTitle = computed(() =>
  selectedFile.value ? assetOutputName(selectedFile.value) : segments.value.at(-1) || t("assets"),
);
const backTo = computed(() => {
  if (selectedFile.value) return router.resolve(assetRouteWithoutFile()).href;
  if (segments.value.length) return router.resolve(assetRoute(segments.value.slice(0, -1))).href;
  return "";
});
const groupDefinitions = computed(() => [
  { id: "image" as const, label: t("assetImages"), icon: "image" },
  { id: "audio" as const, label: t("assetAudio"), icon: "graphic_eq" },
  { id: "video" as const, label: t("assetVideo"), icon: "movie" },
  { id: "model" as const, label: t("assetModels"), icon: "deployed_code" },
  { id: "data" as const, label: t("assetData"), icon: "data_object" },
  { id: "other" as const, label: t("assetOther"), icon: "draft" },
]);
const groupedFiles = computed(() =>
  groupDefinitions.value
    .map((group) => ({
      ...group,
      files: files.value.filter((file) => assetGroupOf(file, segments.value) === group.id),
    }))
    .filter((group) => group.files.length),
);
const fileExtension = (name: string) => name.split(".").pop()?.toLocaleUpperCase() || "-";
const currentEntries = computed(() => {
  const column = directoryColumns.value.at(-1);
  return column?.entries || [];
});
const currentCount = computed(() => (leaf.value ? files.value.length : currentEntries.value.length));
const selectedUrl = computed(() => {
  if (!selectedFile.value) return "";
  const [treeName, ...parts] = selectedFile.value.split("/").filter(Boolean);
  if (!treeName || !["assets", "runtime", "objects"].includes(treeName)) return "";
  return `/${treeName}/${encodeURIComponent(server.value)}/${encodeAssetPath(parts)}`;
});
const breadcrumbs = computed(() => [
  { label: t("assets"), path: [] as string[], to: assetRoute() },
  ...segments.value.map((segment, index) => {
    const itemPath = segments.value.slice(0, index + 1);
    return { label: segment, path: itemPath, to: assetRoute(itemPath) };
  }),
]);

const updateColumnScrollState = () => {
  const viewport = columnsViewport.value;
  if (!viewport) {
    canScrollBackward.value = false;
    canScrollForward.value = false;
    return;
  }
  const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  canScrollBackward.value = viewport.scrollLeft > 2;
  canScrollForward.value = viewport.scrollLeft < maximum - 2;
  if (!mobileColumnsQuery?.matches) rememberedColumnScrollLeft.value = viewport.scrollLeft;
};

const settleColumnLayout = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const scrollToCurrentColumn = async (behavior: ScrollBehavior = "smooth") => {
  await nextTick();
  await settleColumnLayout();
  const viewport = columnsViewport.value;
  if (!viewport || window.matchMedia("(max-width: 760px)").matches) return;
  const current = viewport.lastElementChild as HTMLElement | null;
  if (!current) return;
  const target = Math.max(0, current.offsetLeft + current.offsetWidth - viewport.clientWidth);
  viewport.scrollTo({
    left: target,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior,
  });
  updateColumnScrollState();
};

const onColumnLayoutChange = (event: MediaQueryListEvent) => {
  if (!event.matches) void scrollToCurrentColumn("auto");
};

watch([path, leaf, selectedFile, () => directoryColumns.value.length], () => void scrollToCurrentColumn(), {
  flush: "post",
});
watch(server, (value, previous) => {
  if (previous && value !== previous) void navigateTo(assetRoute());
});
watch([files, filesPending], ([values, pending]) => {
  if (!pending && selectedFile.value && !values.includes(selectedFile.value)) selectedFile.value = values[0] || "";
});

const scrollColumnsBy = (direction: -1 | 1) => {
  const viewport = columnsViewport.value;
  if (!viewport) return;
  const column = viewport.querySelector<HTMLElement>(".asset-column");
  const distance = column?.offsetWidth || Math.min(320, viewport.clientWidth * 0.8);
  const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const target = Math.max(0, Math.min(maximum, viewport.scrollLeft + direction * distance));
  viewport.scrollTo({
    left: target,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
};

const onColumnsWheel = (event: WheelEvent) => {
  const viewport = columnsViewport.value;
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;

  const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX;
  const horizontalIntent = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (!horizontalIntent || !horizontalDelta) return;
  event.preventDefault();
  viewport.scrollLeft += horizontalDelta;
};

onMounted(() => {
  const viewport = columnsViewport.value;
  if (!viewport) return;
  mobileColumnsQuery = window.matchMedia("(max-width: 760px)");
  if (!mobileColumnsQuery.matches) {
    viewport.scrollLeft = Math.min(
      rememberedColumnScrollLeft.value,
      Math.max(0, viewport.scrollWidth - viewport.clientWidth),
    );
  }
  columnsResizeObserver = new ResizeObserver(updateColumnScrollState);
  columnsResizeObserver.observe(viewport);
  for (const column of viewport.children) columnsResizeObserver.observe(column);
  updateColumnScrollState();
  mobileColumnsQuery.addEventListener("change", onColumnLayoutChange);
  void scrollToCurrentColumn();
});
watch(
  () => directoryColumns.value.length + Number(leaf.value) + Number(Boolean(selectedFile.value)),
  async () => {
    await nextTick();
    const viewport = columnsViewport.value;
    if (!viewport || !columnsResizeObserver) return;
    columnsResizeObserver.disconnect();
    columnsResizeObserver.observe(viewport);
    for (const column of viewport.children) columnsResizeObserver.observe(column);
    updateColumnScrollState();
  },
  { flush: "post" },
);
onBeforeUnmount(() => {
  filesRequest?.abort();
  columnsResizeObserver?.disconnect();
  mobileColumnsQuery?.removeEventListener("change", onColumnLayoutChange);
});

useHead(() => ({ title: `${currentTitle.value} · haneoka` }));
</script>

<template>
  <WorkspaceScreen
    domain="catalog"
    :title="currentTitle"
    :count="currentCount"
    :detail-available="false"
    :back-to="backTo"
    :back-label="t('previous')"
    :back-action="selectedFile ? fileLayer.close : undefined"
  >
    <template #heading-actions>
      <nav class="asset-breadcrumb" :aria-label="t('breadcrumb')">
        <template v-for="(item, index) in breadcrumbs" :key="`${index}:${item.label}`">
          <NuxtLink
            :to="item.to"
            :aria-current="!selectedFile && index === breadcrumbs.length - 1 ? 'location' : undefined"
          >
            {{ item.label }}
          </NuxtLink>
          <MaterialIcon v-if="index < breadcrumbs.length - 1 || selectedFile" name="chevron_right" :size="18" />
        </template>
        <span v-if="selectedFile" class="asset-breadcrumb__current" aria-current="location">
          {{ assetOutputName(selectedFile) }}
        </span>
      </nav>
    </template>

    <LoadingState v-if="treePending && !Object.keys(tree).length" />
    <ErrorState v-else-if="treeError" @retry="refreshTree()" />
    <EmptyState v-else-if="node === undefined" />
    <ErrorState v-else-if="filesError" @retry="refreshFiles()" />
    <div v-else class="asset-explorer" :aria-busy="filesPending">
      <UiLinearProgress v-if="filesPending" class="asset-explorer__progress" indeterminate :label="t('loading')" />

      <div
        ref="columnsViewport"
        class="asset-columns"
        tabindex="0"
        :aria-label="t('assets')"
        @scroll.passive="updateColumnScrollState"
        @wheel="onColumnsWheel"
      >
        <section
          v-for="(column, columnIndex) in directoryColumns"
          :key="column.key"
          class="asset-column"
          :class="{
            'is-mobile-current': !leaf && !selectedFile && columnIndex === directoryColumns.length - 1,
          }"
          :aria-label="column.label"
        >
          <nav class="asset-column__list">
            <UiList v-if="column.entries.length" class="asset-entry-list">
              <UiListItem
                v-for="entry in column.entries"
                :key="entry.name"
                class="asset-entry"
                :class="{ 'is-selected': segments[columnIndex] === entry.name }"
                type="link"
                :href="assetHref(entry.path)"
                :aria-current="segments[columnIndex] === entry.name ? 'location' : undefined"
                @click.prevent="navigateTo(assetRoute(entry.path))"
              >
                <template #start>
                  <MaterialIcon :name="entry.bundle ? 'inventory_2' : 'folder'" :size="20" />
                </template>
                <template #headline>{{ entry.name }}</template>
                <template #end>
                  <span class="asset-entry__end">
                    <small class="display-number">{{ entry.count }}</small>
                    <MaterialIcon name="chevron_right" :size="20" />
                  </span>
                </template>
              </UiListItem>
            </UiList>
            <EmptyState v-if="!column.entries.length" />
          </nav>
        </section>

        <section
          v-if="leaf"
          class="asset-column asset-column--files"
          :class="{ 'is-mobile-current': !selectedFile }"
          :aria-label="t('files')"
        >
          <div class="asset-column__list asset-file-list">
            <section v-for="group in groupedFiles" :key="group.id" class="asset-file-group">
              <h3>
                <MaterialIcon :name="group.icon" :size="18" />
                <span>{{ group.label }}</span>
                <small class="display-number">{{ group.files.length }}</small>
              </h3>
              <UiList class="asset-file-group__list">
                <UiListItem
                  v-for="file in group.files"
                  :key="file"
                  class="asset-file"
                  :class="{ 'is-selected': file === selectedFile }"
                  type="button"
                  :aria-pressed="file === selectedFile"
                  @click="fileLayer.open(file)"
                >
                  <template #start><MaterialIcon :name="group.icon" :size="20" /></template>
                  <template #headline>{{ assetOutputName(file) }}</template>
                  <template #end>
                    <span class="asset-file__end">
                      <small>{{ fileExtension(file) }}</small>
                      <MaterialIcon name="chevron_right" :size="20" />
                    </span>
                  </template>
                </UiListItem>
              </UiList>
            </section>
            <EmptyState v-if="!groupedFiles.length" />
          </div>
        </section>

        <section
          v-if="selectedFile"
          class="asset-column asset-column--preview is-mobile-current"
          :aria-label="assetOutputName(selectedFile)"
        >
          <AssetPreview :src="selectedUrl" :name="assetOutputName(selectedFile)" />
        </section>
      </div>

      <div v-if="canScrollBackward || canScrollForward" class="asset-scroll-controls" aria-label="Column navigation">
        <UiIconButton
          :label="t('previous')"
          size="compact"
          touch-target
          :disabled="!canScrollBackward"
          @click="scrollColumnsBy(-1)"
        >
          <MaterialIcon name="chevron_left" :size="22" />
        </UiIconButton>
        <UiIconButton
          :label="t('next')"
          size="compact"
          touch-target
          :disabled="!canScrollForward"
          @click="scrollColumnsBy(1)"
        >
          <MaterialIcon name="chevron_right" :size="22" />
        </UiIconButton>
      </div>
    </div>
  </WorkspaceScreen>
</template>

<style scoped>
.asset-explorer {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.asset-breadcrumb {
  display: flex;
  max-width: min(44vw, 640px);
  min-width: 0;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.asset-breadcrumb::-webkit-scrollbar {
  display: none;
}

.asset-breadcrumb a,
.asset-breadcrumb__current {
  min-width: 0;
  flex: 0 0 auto;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-breadcrumb a[aria-current="location"],
.asset-breadcrumb__current {
  color: var(--md-sys-color-primary);
}

.asset-breadcrumb__current {
  max-width: min(24vw, 320px);
}

.asset-breadcrumb .md3-material-icon {
  margin-inline: var(--md-sys-spacing-1);
  color: var(--md-sys-color-outline);
}

.asset-explorer__progress {
  position: absolute;
  z-index: 4;
  top: 0;
  left: 0;
}

.asset-columns {
  display: flex;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scrollbar-color: var(--md-sys-color-outline) transparent;
  scrollbar-width: thin;
}

.asset-columns:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: -2px;
}

.asset-column {
  display: flex;
  width: clamp(248px, 22vw, 320px);
  min-width: 0;
  min-height: 0;
  flex: 0 0 clamp(248px, 22vw, 320px);
  flex-direction: column;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface);
}

.asset-column__list {
  min-height: 0;
  flex: 1;
  padding: var(--md-sys-spacing-2);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-x: auto;
  overscroll-behavior-y: contain;
  scrollbar-width: thin;
}

.asset-entry-list {
  width: 100%;
  padding: 0;
}

.asset-entry {
  min-height: 48px;
  --md-list-item-container-shape: var(--md-sys-shape-corner-small);
  --md-list-item-label-text-font: var(--md-sys-typescale-body-medium-font);
  --md-list-item-label-text-size: var(--md-sys-typescale-body-medium-size);
}

.asset-entry + .asset-entry {
  margin-top: var(--md-sys-spacing-1);
}

.asset-entry.is-selected {
  --md-list-item-container-color: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-supporting-text-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-leading-icon-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-trailing-icon-color: var(--md-sys-color-on-secondary-container);
}

.asset-entry__end {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.asset-entry__end small,
.asset-file__end small {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.asset-file-group + .asset-file-group {
  margin-top: var(--md-sys-spacing-3);
  padding-top: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.asset-file-group h3 {
  display: grid;
  min-height: 36px;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin: 0;
  padding-inline: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
}

.asset-file-group h3 span {
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
}

.asset-file-group h3 small {
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
}

.asset-file-group__list {
  width: 100%;
  padding: 0;
}

.asset-file {
  min-height: 48px;
  --md-list-item-container-shape: var(--md-sys-shape-corner-small);
  --md-list-item-label-text-font: var(--md-sys-typescale-body-medium-font);
  --md-list-item-label-text-size: var(--md-sys-typescale-body-medium-size);
}

.asset-file.is-selected {
  --md-list-item-container-color: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-leading-icon-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-trailing-icon-color: var(--md-sys-color-on-secondary-container);
}

.asset-entry :deep(.md3-list-item__slot),
.asset-file :deep(.md3-list-item__slot),
.asset-file-group h3 > .md3-material-icon {
  display: grid;
  place-items: center;
}

.asset-file__end {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.asset-column--preview {
  flex-basis: clamp(420px, 44vw, 720px);
  background: var(--md-sys-color-surface-container-low);
}

.asset-column--preview :deep(.asset-preview) {
  min-height: 0;
  flex: 1;
  grid-template-rows: minmax(0, 1fr);
}

.asset-column--preview :deep(.asset-preview > header) {
  display: none;
}

.asset-scroll-controls {
  position: absolute;
  z-index: 3;
  right: var(--md-sys-spacing-4);
  bottom: calc(var(--md-sys-spacing-4) + 10px);
  display: flex;
  align-items: center;
  padding: var(--md-sys-spacing-1);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-sys-color-surface-container-high) 92%, transparent);
  box-shadow: var(--md-sys-elevation-level2);
  backdrop-filter: blur(12px);
}

@media (max-width: 760px) {
  .asset-breadcrumb {
    max-width: 30vw;
  }

  .asset-breadcrumb a,
  .asset-breadcrumb__current {
    max-width: 96px;
  }

  .asset-columns {
    display: block;
    overflow: hidden;
  }

  .asset-column {
    display: none;
    width: 100%;
    height: 100%;
    border: 0;
  }

  .asset-column.is-mobile-current {
    display: flex;
  }

  .asset-column--preview {
    width: 100%;
  }

  .asset-scroll-controls {
    display: none;
  }
}
</style>
