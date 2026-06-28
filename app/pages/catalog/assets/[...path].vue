<script setup lang="ts">
import { isVisibleAssetExplorerRoute } from "~/composables/useAssetExplorer";

definePageMeta({
  validate: (route) => isVisibleAssetExplorerRoute(route.params.path),
});
</script>

<template>
  <AssetExplorerWorkspace />
</template>
