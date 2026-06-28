<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { RouteLocationRaw } from "vue-router";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

export interface StoryCatalogAvatar {
  id: number;
  name: DisplayText;
  image?: string;
  color?: string;
}

export interface StoryCatalogListItem {
  id: string;
  title: DisplayText;
  subtitle?: DisplayText;
  to: RouteLocationRaw;
  thumbnail?: string;
  overlayImage?: string;
  avatars?: StoryCatalogAvatar[];
  duration?: string;
  release?: string;
  level?: number;
}

const props = withDefaults(
  defineProps<{
    items: StoryCatalogListItem[];
    media?: "avatars" | "thumbnail";
    layout?: "list" | "grid";
    selectedId?: string;
    sort?: string;
    order?: "asc" | "desc";
    /** Limit clickable list headers when a source does not provide every field. */
    sortableKeys?: readonly string[];
    showCast?: boolean;
    /** Use the shared grid in document flow when a detail surface owns scrolling. */
    flow?: boolean;
  }>(),
  { media: "avatars", layout: "list", sort: "id", order: "desc", showCast: true, flow: false },
);

const emit = defineEmits<{
  "update:sort": [value: string];
  "update:order": [value: "asc" | "desc"];
}>();

const { t } = useLocale();
const hasLevel = computed(() => props.items.some((item) => item.level !== undefined));
const isSortable = (key: string) => !props.sortableKeys || props.sortableKeys.includes(key);

// List geometry belongs to VirtualCollectionTable. Each data column merely
// declares its share of the available width; only the disclosure affordance is
// intrinsic. This stays in lockstep with the corresponding row cells.
const tableColumns = computed(() =>
  props.media === "thumbnail"
    ? [
        { key: "id", label: t("id"), sortable: isSortable("id") },
        { key: "cover", label: t("cover") },
        { key: "title", label: t("title"), sortable: isSortable("title") },
        ...(props.showCast ? [{ key: "characters", label: t("characters"), sortable: isSortable("characters") }] : []),
        ...(hasLevel.value
          ? [
              {
                key: "level",
                label: t("friendshipLevel"),
                sortable: isSortable("level"),
                align: "center" as const,
              },
            ]
          : []),
        { key: "release", label: t("release"), sortable: isSortable("release"), align: "end" as const },
        { key: "duration", label: t("length"), sortable: isSortable("duration"), align: "end" as const },
        { key: "open", label: "", kind: "action" as const },
      ]
    : [
        { key: "id", label: t("id"), sortable: isSortable("id") },
        { key: "characters", label: t("characters"), sortable: isSortable("characters"), align: "center" as const },
        { key: "title", label: t("title"), sortable: isSortable("title") },
        ...(hasLevel.value
          ? [
              {
                key: "level",
                label: t("friendshipLevel"),
                sortable: isSortable("level"),
                align: "center" as const,
              },
            ]
          : []),
        { key: "release", label: t("release"), sortable: isSortable("release"), align: "end" as const },
        { key: "duration", label: t("length"), sortable: isSortable("duration"), align: "end" as const },
        { key: "open", label: "", kind: "action" as const },
      ],
);

const listRowHeight = computed(() => (props.media === "thumbnail" ? 100 : 62));
const gridRowHeight = (columnWidth: number, compact: boolean) => {
  // Story banners are authored at 16:9 and the shared tile lets that artwork
  // keep its natural height.  Estimating them as 4:3 left a large invisible
  // tail on every virtual row, which looked like an oversized grid gap.
  if (props.media === "thumbnail") return Math.ceil(columnWidth * (9 / 16) + (compact ? 54 : 62));
  return compact ? 126 : 142;
};
</script>

<template>
  <VirtualCollectionTable
    v-if="layout === 'list'"
    class="story-catalog-list is-layout-list"
    :class="[`is-${media}`, { 'has-level': hasLevel, 'has-no-cast': !showCast }]"
    :items="items"
    :item-key="(item) => item.id"
    :label="t('stories')"
    :row-height="listRowHeight"
    :selected-key="selectedId"
    :columns="tableColumns"
    :sort="sort"
    :order="order"
    scroll-key="story-list"
    @update:sort="emit('update:sort', $event)"
    @update:order="emit('update:order', $event)"
  >
    <template #row="{ item, index, style }">
      <CollectionTableRow
        class="story-catalog-row"
        :style="style"
        :label="textOf(item.title)"
        :selected="item.id === selectedId"
        :row-index="index"
        :to="item.to"
      >
        <code class="story-catalog-row__id display-number" role="gridcell">
          {{ item.id }}
        </code>

        <div v-if="media === 'thumbnail'" class="story-catalog-row__thumbnail" role="gridcell">
          <TextFallbackMedia
            :image="item.thumbnail"
            :label="item.title"
            :secondary-label="item.subtitle"
            icon="auto_stories"
            fallback-aspect-ratio="16 / 9"
            fit="cover"
          />
          <StoryThumbnailDecorations :logo="item.overlayImage" />
        </div>

        <div v-else class="story-catalog-row__avatars" role="gridcell" aria-hidden="true">
          <span
            v-for="avatar in item.avatars?.slice(0, 5)"
            :key="avatar.id"
            :style="{ '--avatar-color': avatar.color || 'var(--md-sys-color-primary)' }"
          >
            <EntityAvatar
              class="story-catalog-row__avatar"
              :image="avatar.image"
              :text="entityAvatarText(avatar.name)"
              :lang="langOf(avatar.name)"
              :color="avatar.color"
              fit="cover"
              icon="person"
            />
          </span>
        </div>

        <CollectionTileIdentity
          class="story-catalog-row__copy"
          :title="item.title"
          :subtitle="item.subtitle || ''"
          role="gridcell"
        />

        <div
          v-if="media === 'thumbnail' && showCast"
          class="story-catalog-row__cast"
          role="gridcell"
          aria-hidden="true"
        >
          <span
            v-for="avatar in item.avatars?.slice(0, 5)"
            :key="avatar.id"
            :style="{ '--avatar-color': avatar.color || 'var(--md-sys-color-primary)' }"
          >
            <EntityAvatar
              class="story-catalog-row__avatar"
              :image="avatar.image"
              :text="entityAvatarText(avatar.name)"
              :lang="langOf(avatar.name)"
              :color="avatar.color"
              fit="cover"
              icon="person"
            />
          </span>
        </div>

        <span v-if="hasLevel" class="story-catalog-row__level display-number" role="gridcell">
          {{ item.level ?? "—" }}
        </span>
        <time class="story-catalog-row__release display-number" role="gridcell">{{ item.release || "—" }}</time>
        <span class="story-catalog-row__duration display-number" role="gridcell">{{ item.duration || "—" }}</span>
        <MaterialIcon name="chevron_right" :size="15" role="gridcell" aria-hidden="true" />
      </CollectionTableRow>
    </template>
  </VirtualCollectionTable>

  <CatalogCollectionGrid
    v-else
    class="story-catalog-list is-layout-grid"
    :class="[`is-${media}`, { 'has-level': hasLevel, 'has-no-cast': !showCast }]"
    :items="items"
    :item-key="(item) => item.id"
    :label="t('stories')"
    :minimum-column-width="206"
    :compact-minimum-column-width="160"
    :estimate-row-height="gridRowHeight"
    :selected-key="selectedId"
    :flow="flow"
    scroll-key="story-grid"
  >
    <template #item="{ item }">
      <CollectionTileSurface
        class="story-catalog-row story-catalog-row--tile"
        :label="item.title"
        :secondary-label="item.subtitle || ''"
        :to="item.to"
        :selected="item.id === selectedId"
      >
        <template #media>
          <div v-if="media === 'thumbnail'" class="story-catalog-row__thumbnail">
            <TextFallbackMedia
              :image="item.thumbnail"
              :label="item.title"
              :secondary-label="item.subtitle"
              icon="auto_stories"
              fallback-aspect-ratio="16 / 9"
              fit="cover"
            />
            <StoryThumbnailDecorations :logo="item.overlayImage" :avatars="item.avatars" />
          </div>

          <div v-else class="story-catalog-row__avatars" aria-hidden="true">
            <span
              v-for="avatar in item.avatars?.slice(0, 5)"
              :key="avatar.id"
              :style="{ '--avatar-color': avatar.color || 'var(--md-sys-color-primary)' }"
            >
              <EntityAvatar
                class="story-catalog-row__avatar"
                :image="avatar.image"
                :text="entityAvatarText(avatar.name)"
                :lang="langOf(avatar.name)"
                :color="avatar.color"
                fit="cover"
                icon="person"
              />
            </span>
          </div>
        </template>

        <CollectionTileIdentity class="story-catalog-row__copy" :title="item.title">
          <template v-if="textOf(item.subtitle) || item.level !== undefined || item.duration || item.release" #subtitle>
            <CollectionSubtitleAvatars v-if="textOf(item.subtitle)" :avatars="item.avatars">
              <DisplayText :value="item.subtitle || ''" />
            </CollectionSubtitleAvatars>
            <StoryFriendshipLevel v-if="item.level !== undefined" :level="item.level" />
            <span v-if="item.release">
              <MaterialIcon name="calendar_month" :size="12" />
              {{ item.release }}
            </span>
            <span v-if="item.duration">
              <MaterialIcon name="schedule" :size="12" />
              {{ item.duration }}
            </span>
          </template>
        </CollectionTileIdentity>
      </CollectionTileSurface>
    </template>
  </CatalogCollectionGrid>
</template>

<style scoped>
.story-catalog-list {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--md-sys-color-surface);
}

.story-catalog-list.is-layout-list .story-catalog-row {
  position: relative;
  min-height: 62px;
  align-items: center;
  color: var(--md-sys-color-on-surface-variant);
}

.story-catalog-list.is-layout-list.is-thumbnail .story-catalog-row {
  min-height: 100px;
}

.story-catalog-list.is-layout-list .story-catalog-row__copy {
  padding-right: 12px;
}

.story-catalog-row__avatars,
.story-catalog-row__cast {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
}

.story-catalog-row__avatars > span,
.story-catalog-row__cast > span {
  position: relative;
  display: grid;
  overflow: hidden;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--avatar-color) 46%, var(--md-sys-color-surface));
  border-radius: 50%;
  background: color-mix(in srgb, var(--avatar-color) 14%, var(--md-sys-color-surface-container-lowest));
  box-shadow: 0 0 0 2px var(--md-sys-color-surface-container-lowest);
}

.story-catalog-row__avatars > span {
  width: 40px;
  height: 40px;
}

.story-catalog-row__avatars > span + span {
  margin-left: -14px;
}

.story-catalog-row__cast > span {
  width: 30px;
  height: 30px;
}

.story-catalog-row__cast > span + span {
  margin-left: -8px;
}

.story-catalog-row__avatars img,
.story-catalog-row__cast img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.story-catalog-row__avatar {
  width: 100%;
  height: 100%;
  --entity-avatar-font-size: 10px;
}

.story-catalog-row__thumbnail {
  position: relative;
  overflow: hidden;
  width: min(100%, 118px);
  justify-self: center;
  aspect-ratio: var(--md-comp-story-media-aspect-ratio);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-highest);
}

.story-catalog-row__thumbnail img,
.story-catalog-row__thumbnail > span {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.story-catalog-row__level,
.story-catalog-row__release,
.story-catalog-row__duration {
  min-width: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
  overflow-wrap: anywhere;
}

.story-catalog-row__id {
  display: block;
  min-width: 0;
  padding-inline: 5px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
  overflow-wrap: anywhere;
}

.story-catalog-row > :deep(.md3-material-icon) {
  color: var(--md-sys-color-on-surface-variant);
  justify-self: center;
}

.story-catalog-list.is-layout-grid :deep(.collection-tile-surface__media) {
  height: max-content;
  min-height: 0;
  align-self: start;
  background: transparent;
}

.story-catalog-list.is-layout-grid :deep(.collection-tile-surface__metadata) {
  align-items: stretch;
}

.story-catalog-list.is-layout-grid .story-catalog-row__thumbnail {
  width: 100%;
  height: max-content;
  min-height: 0;
  align-self: start;
  aspect-ratio: auto;
}

.story-catalog-list.is-layout-grid .story-catalog-row__thumbnail img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: initial;
}

.story-catalog-list.is-layout-grid .story-catalog-row__thumbnail > span {
  display: block;
  height: auto;
  min-height: 0;
}

.story-catalog-list.is-layout-grid .story-catalog-row__avatars {
  position: relative;
  width: 100%;
  min-height: 72px;
  flex: 0 0 72px;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-high);
}

.story-catalog-list.is-layout-grid .story-catalog-row__avatars > span {
  z-index: 1;
  width: 52px;
  height: 52px;
}

.story-catalog-list.is-layout-grid .story-catalog-row__copy {
  width: 100%;
  padding: 0 2px 2px;
}

@media (max-width: 760px) {
  .story-catalog-list.is-layout-grid .story-catalog-row__avatars {
    min-height: 61px;
    flex-basis: 61px;
  }

  .story-catalog-list.is-layout-grid .story-catalog-row__avatars > span {
    width: 40px;
    height: 40px;
  }
}
</style>
