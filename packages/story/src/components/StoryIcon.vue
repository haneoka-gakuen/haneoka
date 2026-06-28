<script setup lang="ts">
export type StoryIconName =
  "play" | "replay" | "skip" | "settings" | "volume" | "mute" | "fullscreen" | "user";

defineOptions({ name: "StoryIcon" });
defineProps<{ name: StoryIconName }>();
</script>

<template>
  <span class="story-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false" role="img">
      <path v-if="name === 'play'" d="M7 4.8a1 1 0 0 1 1.52-.85l11 7.2a1 1 0 0 1 0 1.7l-11 7.2A1 1 0 0 1 7 19.2z" />
      <path
        v-else-if="name === 'replay'"
        d="M12 4a8 8 0 1 1-7.56 10.62 1 1 0 1 1 1.89-.65A6 6 0 1 0 7.2 8.2H10a1 1 0 0 1 0 2H4.8a1 1 0 0 1-1-1V4a1 1 0 0 1 2 0v2.45A7.97 7.97 0 0 1 12 4"
      />
      <path
        v-else-if="name === 'skip'"
        d="M4 5.25a1 1 0 0 1 1.55-.83L14.5 11v-5.75a1 1 0 0 1 1.55-.83l5.5 4a1 1 0 0 1 .45.83v5.5a1 1 0 0 1-.45.83l-5.5 4a1 1 0 0 1-1.55-.83V13l-8.95 6.58A1 1 0 0 1 4 18.75z"
      />
      <path
        v-else-if="name === 'settings'"
        d="M10.9 2h2.2l.45 2.1a8 8 0 0 1 1.35.56l1.8-1.17 1.56 1.56-1.17 1.8c.23.43.42.88.56 1.35l2.1.45v2.2l-2.1.45a8 8 0 0 1-.56 1.35l1.17 1.8-1.56 1.56-1.8-1.17a8 8 0 0 1-1.35.56l-.45 2.1h-2.2l-.45-2.1a8 8 0 0 1-1.35-.56l-1.8 1.17-1.56-1.56 1.17-1.8a8 8 0 0 1-.56-1.35l-2.1-.45v-2.2l2.1-.45c.14-.47.33-.92.56-1.35l-1.17-1.8L7.3 3.49l1.8 1.17c.43-.23.88-.42 1.35-.56zM12 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6"
      />
      <path
        v-else-if="name === 'volume'"
        d="M4 9h4l5-4v14l-5-4H4zm11.5-.7a1 1 0 0 1 1.4.15 5.7 5.7 0 0 1 0 7.1 1 1 0 1 1-1.55-1.25 3.7 3.7 0 0 0 0-4.6 1 1 0 0 1 .15-1.4m2.9-2.45a1 1 0 0 1 1.4.15 9.65 9.65 0 0 1 0 12 1 1 0 1 1-1.55-1.25 7.65 7.65 0 0 0 0-9.5 1 1 0 0 1 .15-1.4"
      />
      <path
        v-else-if="name === 'mute'"
        d="M4 9h4l5-4v14l-5-4H4zm11.3.3 1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z"
      />
      <path
        v-else-if="name === 'user'"
        d="M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9m0 11c5.05 0 8 2.5 8 5v2H4v-2c0-2.5 2.95-5 8-5"
      />
      <path v-else d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" />
    </svg>
  </span>
</template>

<style scoped>
.story-icon {
  align-items: center;
  display: inline-flex;
  flex: none;
  justify-content: center;
  line-height: 1;
}

.story-icon svg {
  display: block;
  fill: currentColor;
  height: 1em;
  width: 1em;
}
</style>
