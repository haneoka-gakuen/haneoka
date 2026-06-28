<script setup lang="ts">
import { langOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

interface StoryThumbnailAvatar {
  id: number;
  name: DisplayText;
  image?: string;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    logo?: string;
    avatars?: StoryThumbnailAvatar[];
    friendshipLevel?: number;
    standalone?: boolean;
  }>(),
  {
    logo: "",
    avatars: () => [],
    standalone: false,
  },
);

const logoFailed = ref(false);
watch(
  () => props.logo,
  () => {
    logoFailed.value = false;
  },
);
</script>

<template>
  <span
    class="story-thumbnail-decorations"
    :class="{ 'has-friendship-level': friendshipLevel !== undefined, 'is-standalone': standalone }"
    aria-hidden="true"
  >
    <img
      v-if="logo && !logoFailed"
      class="story-thumbnail-decorations__logo"
      :src="logo"
      alt=""
      loading="lazy"
      decoding="async"
      @error="logoFailed = true"
    />

    <span v-if="avatars.length" class="story-thumbnail-decorations__avatars">
      <span
        v-for="avatar in avatars.slice(0, 5)"
        :key="avatar.id"
        :style="{ '--avatar-color': avatar.color || 'var(--md-sys-color-primary)' }"
      >
        <EntityAvatar
          class="story-thumbnail-decorations__avatar"
          :image="avatar.image"
          :text="entityAvatarText(avatar.name)"
          :lang="langOf(avatar.name)"
          :color="avatar.color"
          fit="cover"
          icon="person"
        />
      </span>
    </span>

    <StoryFriendshipLevel
      v-if="friendshipLevel !== undefined"
      class="story-thumbnail-decorations__friendship-level"
      :level="friendshipLevel"
    />
  </span>
</template>

<style scoped>
.story-thumbnail-decorations {
  position: absolute;
  z-index: 3;
  inset: 0;
  pointer-events: none;
}

.story-thumbnail-decorations__logo {
  position: absolute;
  top: 6px;
  left: 6px;
  width: min(46%, 78px);
  height: min(32%, 34px);
  min-height: 18px;
  object-fit: contain;
  object-position: left center;
  filter: drop-shadow(0 2px 4px rgb(7 12 31 / 0.24));
}

.story-thumbnail-decorations__avatars {
  position: absolute;
  right: 7px;
  bottom: 7px;
  display: flex;
  align-items: center;
  filter: drop-shadow(0 3px 8px rgb(7 12 31 / 0.28));
}

.story-thumbnail-decorations.has-friendship-level:not(.is-standalone) .story-thumbnail-decorations__avatars {
  bottom: 32px;
}

.story-thumbnail-decorations__avatars > span {
  display: grid;
  width: 28px;
  height: 28px;
  overflow: hidden;
  color: var(--avatar-color);
  border: 2px solid var(--md-sys-color-surface-container-lowest);
  border-radius: 50%;
  background: color-mix(in srgb, var(--avatar-color) 16%, var(--md-sys-color-surface-container-lowest));
  place-items: center;
}

.story-thumbnail-decorations__avatars > span + span {
  margin-left: -7px;
}

.story-thumbnail-decorations__avatars img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.story-thumbnail-decorations__avatar {
  width: 100%;
  height: 100%;
  --entity-avatar-font-size: 9px;
}

.story-thumbnail-decorations.is-standalone .story-thumbnail-decorations__avatars {
  inset: 0;
  justify-content: center;
  padding: 10px;
  filter: drop-shadow(0 5px 10px rgb(7 12 31 / 0.18));
}

.story-thumbnail-decorations.is-standalone .story-thumbnail-decorations__avatars > span {
  width: clamp(38px, 4.6vw, 54px);
  height: clamp(38px, 4.6vw, 54px);
  border-width: 3px;
}

.story-thumbnail-decorations.is-standalone .story-thumbnail-decorations__avatars > span + span {
  margin-left: -10px;
}

.story-thumbnail-decorations__friendship-level {
  position: absolute;
  right: 7px;
  bottom: 7px;
}

@media (max-width: 760px) {
  .story-thumbnail-decorations__avatars {
    right: 6px;
    bottom: 6px;
    max-width: calc(100% - 12px);
    justify-content: flex-end;
  }

  .story-thumbnail-decorations__avatars > span {
    width: 24px;
    height: 24px;
  }

  .story-thumbnail-decorations__avatars > span + span {
    margin-left: -6px;
  }

  .story-thumbnail-decorations.has-friendship-level:not(.is-standalone) .story-thumbnail-decorations__avatars {
    bottom: 34px;
  }
}
</style>
