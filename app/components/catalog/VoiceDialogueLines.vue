<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import { textOf, type DisplayText } from "~/types/displayText";

export interface VoiceDialogueLine {
  key: string;
  characterId?: number;
  characterName?: DisplayText;
  characterImage?: string;
  text: DisplayText;
  cue?: string;
  playableUrl?: string;
  playing?: boolean;
}

export interface VoiceDialogueGroup {
  key: string;
  label?: DisplayText;
  lines: VoiceDialogueLine[];
  playing?: boolean;
}

withDefaults(defineProps<{ groups?: VoiceDialogueGroup[] }>(), { groups: () => [] });
const emit = defineEmits<{ play: [group: VoiceDialogueGroup] }>();
const { t } = useLocale();
</script>

<template>
  <div v-if="groups.length" class="voice-groups">
    <section v-for="group in groups" :key="group.key" class="voice-groups__entry">
      <header v-if="textOf(group.label)" class="voice-groups__header">
        <span><DisplayText :value="group.label" /></span>
        <span class="voice-groups__actions">
          <small v-if="group.lines.length > 1" class="display-number">{{ group.lines.length }}</small>
          <UiIconButton
            v-if="group.lines.some((line) => line.playableUrl)"
            class="voice-groups__play"
            size="compact"
            :label="group.playing ? t('pause') : t('play')"
            @click="emit('play', group)"
          >
            <MaterialIcon name="pause" v-if="group.playing" :size="14" aria-hidden="true" />
            <MaterialIcon name="play_arrow" v-else :size="14" aria-hidden="true" />
          </UiIconButton>
        </span>
      </header>
      <UiList class="voice-lines">
        <UiListItem v-for="line in group.lines" :key="line.key" type="text" :class="{ 'is-selected': line.playing }">
          <template #start>
            <span class="voice-lines__avatar">
              <img v-if="line.characterImage" :src="line.characterImage" alt="" loading="lazy" decoding="async" />
              <span v-else-if="line.characterId" class="display-number">{{ line.characterId }}</span>
            </span>
          </template>
          <template #headline>
            <strong><DisplayText :value="textOf(line.text) ? line.text : line.cue || '—'" /></strong>
          </template>
          <template v-if="textOf(line.characterName)" #supporting>
            <small v-if="textOf(line.characterName)"><DisplayText :value="line.characterName" /></small>
          </template>
          <template v-if="line.cue" #end>
            <code v-if="line.cue" class="display-number">{{ line.cue }}</code>
          </template>
        </UiListItem>
      </UiList>
    </section>
  </div>
</template>

<style scoped>
.voice-groups {
  display: grid;
  gap: var(--md-sys-spacing-3);
}

.voice-groups__entry {
  min-width: 0;
}

.voice-groups__header {
  display: flex;
  min-height: var(--md-comp-control-height-compact);
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-inline: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.voice-groups__header small {
  color: var(--md-comp-detail-accent);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.voice-groups__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.voice-groups__play {
  --md-icon-button-icon-size: 18px;
  --md-icon-button-icon-color: var(--md-sys-color-primary);
}

.voice-lines {
  padding: 0;
}

.voice-lines__avatar {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-outline);
  border-radius: 50%;
  background: var(--md-sys-color-surface-container-high);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.voice-lines__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.voice-lines small,
.voice-lines code {
  overflow: hidden;
  color: var(--md-sys-color-outline);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
