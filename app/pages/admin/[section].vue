<script setup lang="ts">
import { isAdminSection, type AdminSection } from "~/types/admin";

const route = useRoute();
const { t } = useLocale();
const section = computed<AdminSection>(() => {
  const value = String(route.params.section || "");
  if (!isAdminSection(value) || value === "overview") {
    throw createError({ statusCode: 404, statusMessage: t("adminPage.sectionNotFound") });
  }
  return value;
});
</script>

<template>
  <AdminDashboard :section="section" />
</template>
