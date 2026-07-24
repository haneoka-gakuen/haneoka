<script setup lang="ts">
import { collectFocusableElements, MaterialIcon, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import { capabilities, capabilitiesIn, type CapabilityDomain } from "~/config/capabilities";
import { capabilityNavigationIcon, nestedNavigationLeaves, shellNavigationIcons } from "~/config/navigation";
import { capabilityLabel } from "~/i18n/capabilities";

interface PrimaryDestination {
  icon: string;
  id: string;
  label: string;
  to: string;
}

type UtilityDestination = PrimaryDestination;
interface DrawerDestination extends PrimaryDestination {
  children?: DrawerDestination[];
  exact: boolean;
}

interface DrawerGroup {
  icon: string;
  id: CapabilityDomain;
  items: DrawerDestination[];
  label: string;
  to: string;
}

const route = useRoute();
const router = useRouter();
const { track, collapsed: playerCollapsed } = useAudioPlayer();
const { t } = useLocale();
const { identity: cachedIdentity } = useIdentityCache();
const navigationOpen = ref(false);
const navigationHistoryEntryActive = ref(false);
const navigationCollapsed = ref(false);
const wideNavigation = ref(false);
const navigationPanel = ref<HTMLElement>();
const navigationContent = ref<HTMLElement>();
const navigationReturnFocus = shallowRef<HTMLElement>();
const pendingNavigationScrollTop = ref<number>();
const expandedNavigationGroups = ref<CapabilityDomain[]>([]);
const expandedNavigationItems = ref<string[]>([]);
const NAVIGATION_COLLAPSED_KEY = "haneoka.navigation.collapsed";
const NAVIGATION_HISTORY_STATE_KEY = "haneokaNavigationOverlay";

const displayIdentity = computed(() => {
  const identity = cachedIdentity.value;
  if (!identity) return null;
  return {
    avatarSeed: identity.ownerUserId,
    avatarUrl: identity.avatarUrl || identity.sessionImage,
    name: identity.displayName || identity.accountName || identity.sessionName || "?",
  };
});

const routeIs = (to: string, exact = false) => {
  if (to === "/" || exact) return route.path === to;
  return route.path === to || route.path.startsWith(`${to}/`);
};

const labelFor = (id: string, fallback: string) => {
  const capability = capabilities.find((entry) => entry.id === id);
  return capability ? capabilityLabel(capability.id, t, capability.label) : fallback;
};

const utilityDestinations = computed<UtilityDestination[]>(() => [
  { id: "account", label: t("account"), to: "/account", icon: shellNavigationIcons.account },
  { id: "settings", label: t("settings"), to: "/settings", icon: shellNavigationIcons.settings },
  { id: "about", label: t("about"), to: "/about", icon: shellNavigationIcons.about },
]);

const drawerDomains = ["catalog", "community", "tools"] as const satisfies readonly CapabilityDomain[];
const drawerDomainIcons: Readonly<Record<(typeof drawerDomains)[number], string>> = {
  catalog: shellNavigationIcons.catalog,
  community: shellNavigationIcons.community,
  tools: shellNavigationIcons.tools,
};

const drawerGroups = computed<DrawerGroup[]>(() =>
  drawerDomains.map((domain) => {
    const root = capabilities.find((capability) => capability.id === domain)!;
    return {
      id: domain,
      icon: drawerDomainIcons[domain],
      label: capabilityLabel(root.id, t, root.label),
      to: root.route,
      items: capabilitiesIn(domain)
        .filter((capability) => capability.id !== root.id)
        .map((capability) => {
          const leaves = nestedNavigationLeaves[capability.id] ?? [];
          const children = leaves.map((child) => ({
            id: child.id,
            icon: child.icon,
            label: t(child.messageKey),
            to: child.route,
            exact: false,
          }));
          return {
            id: capability.id,
            icon: capabilityNavigationIcon(capability.id),
            label: capabilityLabel(capability.id, t, capability.label),
            to: capability.route,
            exact: leaves.length > 0 || capability.route === root.route,
            children: children.length ? children : undefined,
          };
        }),
    };
  }),
);

const destinationIsActive = (item: DrawerDestination) =>
  routeIs(item.to, item.exact) || Boolean(item.children?.some((child) => routeIs(child.to, child.exact)));
const navigationGroupItemsId = (group: DrawerGroup) => `navigation-group-${group.id}`;
const navigationGroupExpanded = (group: DrawerGroup) => expandedNavigationGroups.value.includes(group.id);
const toggleNavigationGroup = (group: DrawerGroup) => {
  const values = new Set(expandedNavigationGroups.value);
  if (values.has(group.id)) values.delete(group.id);
  else values.add(group.id);
  expandedNavigationGroups.value = [...values];
};
const navigationChildrenId = (item: DrawerDestination) => `navigation-children-${item.id}`;
const navigationItemExpanded = (item: DrawerDestination) => expandedNavigationItems.value.includes(item.id);
const toggleNavigationItem = (item: DrawerDestination) => {
  const values = new Set(expandedNavigationItems.value);
  if (values.has(item.id)) values.delete(item.id);
  else values.add(item.id);
  expandedNavigationItems.value = [...values];
};
const syncActiveNavigationExpansion = () => {
  expandedNavigationGroups.value = drawerGroups.value.filter((group) => routeIs(group.to)).map((group) => group.id);
  const values = new Set<string>();
  for (const group of drawerGroups.value) {
    for (const item of group.items) {
      if (item.children?.some((child) => routeIs(child.to, child.exact))) values.add(item.id);
    }
  }
  expandedNavigationItems.value = [...values];
};

const focusableElements = () => (navigationPanel.value ? collectFocusableElements(navigationPanel.value) : []);

const openNavigation = async (event: Event) => {
  navigationReturnFocus.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!wideNavigation.value && !navigationHistoryEntryActive.value) {
    const current = router.currentRoute.value;
    await router.push({
      path: current.path,
      query: current.query,
      hash: current.hash,
      state: { [NAVIGATION_HISTORY_STATE_KEY]: true },
      force: true,
    });
    navigationHistoryEntryActive.value = true;
  }
  navigationOpen.value = true;
  await nextTick();
  navigationPanel.value?.focus({ preventScroll: true });
};

provideShellNavigation(navigationOpen, openNavigation);

const closeNavigation = (restoreFocus = true) => {
  if (!navigationOpen.value) return;
  navigationOpen.value = false;
  if (navigationHistoryEntryActive.value) {
    navigationHistoryEntryActive.value = false;
    router.back();
  }
  if (restoreFocus) nextTick(() => navigationReturnFocus.value?.focus({ preventScroll: true }));
};

const activateNavigationDestination = (event: MouseEvent, to: string) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  ) {
    return;
  }
  event.preventDefault();
  if (route.path !== to) rememberNavigationScrollPosition();
  const replace = navigationHistoryEntryActive.value;
  navigationHistoryEntryActive.value = false;
  navigationOpen.value = false;
  void navigateTo(
    replace
      ? {
          path: to,
          // Vue Router preserves the current entry's user state on replace.
          // Explicitly clear the transient drawer marker so returning to this
          // destination cannot reopen the drawer and trigger another back().
          state: { [NAVIGATION_HISTORY_STATE_KEY]: false },
        }
      : to,
    { replace },
  );
};

const activateBrandNavigation = (event: MouseEvent) => activateNavigationDestination(event, "/");

const revealNavigationGroup = async (group: DrawerGroup) => {
  await nextTick();
  const trigger = navigationPanel.value?.querySelector<HTMLElement>(
    `[aria-controls="${navigationGroupItemsId(group)}"]`,
  );
  trigger?.focus();
  trigger?.scrollIntoView({ block: "nearest" });
};

const rememberNavigationScrollPosition = () => {
  if (!wideNavigation.value || navigationCollapsed.value || !navigationContent.value) return;
  pendingNavigationScrollTop.value = navigationContent.value.scrollTop;
};

const activeNavigationDestination = () => {
  const container = navigationContent.value;
  if (!container) return undefined;
  const selected = [...container.querySelectorAll<HTMLElement>(".navigation-drawer__item.is-selected")];
  return selected.at(-1) ?? container.querySelector<HTMLElement>(".navigation-drawer__group-heading.is-active");
};

const activeNavigationIsVisible = (element: HTMLElement, container: HTMLElement) => {
  const destination = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  return destination.top >= viewport.top && destination.bottom <= viewport.bottom;
};

const scrollActiveNavigationIntoView = async () => {
  if (!wideNavigation.value || navigationCollapsed.value) return;
  await nextTick();
  const container = navigationContent.value;
  if (!container) return;

  const savedTop = pendingNavigationScrollTop.value;
  if (savedTop !== undefined) {
    container.scrollTop = savedTop;
    pendingNavigationScrollTop.value = undefined;
    return;
  }

  const active = activeNavigationDestination();
  if (active && !activeNavigationIsVisible(active, container)) active.scrollIntoView({ block: "nearest" });
};

const applyNavigationCollapsedState = () => {
  document.documentElement.dataset.navigationCollapsed = String(navigationCollapsed.value);
};

const toggleNavigationCollapsed = () => {
  navigationCollapsed.value = !navigationCollapsed.value;
  applyNavigationCollapsedState();
  try {
    localStorage.setItem(NAVIGATION_COLLAPSED_KEY, String(navigationCollapsed.value));
  } catch {
    // The in-memory preference remains valid when persistent storage is unavailable.
  }
  if (!navigationCollapsed.value) void scrollActiveNavigationIntoView();
};

const expandPlayer = () => {
  playerCollapsed.value = false;
};

const activateNavigationGroup = async (group: DrawerGroup) => {
  if (wideNavigation.value && navigationCollapsed.value) {
    toggleNavigationCollapsed();
    if (!navigationGroupExpanded(group)) {
      expandedNavigationGroups.value = [...expandedNavigationGroups.value, group.id];
    }
    await revealNavigationGroup(group);
    return;
  }
  toggleNavigationGroup(group);
};

const handleNavigationKeydown = (event: KeyboardEvent) => {
  if (wideNavigation.value || !navigationOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeNavigation();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements();
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
};

const WIDE_NAVIGATION_QUERY = "(min-width: 960px), (min-width: 840px) and (min-height: 501px)";
let wideNavigationQuery: MediaQueryList | undefined;
const updateNavigationLayout = () => {
  wideNavigation.value = Boolean(wideNavigationQuery?.matches);
  if (wideNavigation.value) closeNavigation(false);
  void scrollActiveNavigationIntoView();
};
const handleNavigationPopState = (event: PopStateEvent) => {
  if (wideNavigation.value) return;
  navigationHistoryEntryActive.value = event.state?.[NAVIGATION_HISTORY_STATE_KEY] === true;
  navigationOpen.value = navigationHistoryEntryActive.value;
  if (navigationOpen.value) nextTick(() => navigationPanel.value?.focus({ preventScroll: true }));
};

watch(
  () => route.fullPath,
  () => {
    closeNavigation(false);
    syncActiveNavigationExpansion();
    void scrollActiveNavigationIntoView();
  },
  { immediate: true },
);

onMounted(() => {
  try {
    navigationCollapsed.value = localStorage.getItem(NAVIGATION_COLLAPSED_KEY) === "true";
  } catch {
    navigationCollapsed.value = false;
  }
  applyNavigationCollapsedState();
  syncActiveNavigationExpansion();
  navigationHistoryEntryActive.value = router.options.history.state[NAVIGATION_HISTORY_STATE_KEY] === true;
  wideNavigationQuery = window.matchMedia(WIDE_NAVIGATION_QUERY);
  updateNavigationLayout();
  wideNavigationQuery.addEventListener("change", updateNavigationLayout);
  window.addEventListener("popstate", handleNavigationPopState);
});

onBeforeUnmount(() => {
  wideNavigationQuery?.removeEventListener("change", updateNavigationLayout);
  window.removeEventListener("popstate", handleNavigationPopState);
  delete document.documentElement.dataset.navigationCollapsed;
});
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'app-shell--playing': track && !playerCollapsed,
      'is-navigation-collapsed': navigationCollapsed,
    }"
  >
    <a class="skip-link" href="#main-content">{{ t("content") }}</a>

    <button
      v-if="navigationOpen && !wideNavigation"
      class="navigation-drawer__scrim"
      type="button"
      :aria-label="t('close')"
      @click="closeNavigation()"
    />

    <aside
      id="global-navigation-panel"
      ref="navigationPanel"
      class="navigation-drawer"
      :class="{ 'is-open': navigationOpen }"
      :inert="!wideNavigation && !navigationOpen"
      tabindex="-1"
      :aria-hidden="!wideNavigation && !navigationOpen"
      :aria-label="t('primaryNavigation')"
      @keydown="handleNavigationKeydown"
    >
      <header class="navigation-drawer__header">
        <NuxtLink class="navigation-drawer__brand" to="/" @click="activateBrandNavigation">
          <img src="/favicon.svg" alt="" width="32" height="32" />
          <strong>haneoka</strong>
          <md-ripple />
        </NuxtLink>
        <UiIconButton
          class="navigation-drawer__toggle"
          :label="navigationCollapsed ? t('expand') : t('collapse')"
          @click="toggleNavigationCollapsed"
        >
          <MaterialIcon :name="navigationCollapsed ? 'left_panel_open' : 'left_panel_close'" :size="24" />
        </UiIconButton>
        <UiIconButton class="navigation-drawer__close" :label="t('close')" @click="closeNavigation()">
          <MaterialIcon name="close" :size="24" />
        </UiIconButton>
      </header>

      <nav ref="navigationContent" class="navigation-drawer__content">
        <UiList class="navigation-drawer__root-list">
          <NuxtLink
            v-if="navigationCollapsed && wideNavigation"
            class="navigation-rail__destination"
            :class="{ 'is-selected': routeIs('/', true) }"
            to="/"
            :aria-current="routeIs('/', true) ? 'page' : undefined"
          >
            <span class="navigation-rail__indicator">
              <MaterialIcon :name="shellNavigationIcons.home" :size="24" :filled="routeIs('/', true)" />
            </span>
            <span class="navigation-rail__label">
              <DisplayText :value="labelFor('home', 'Home')" />
            </span>
            <md-ripple />
          </NuxtLink>
          <UiListItem
            v-else
            class="navigation-drawer__item"
            :class="{ 'is-selected': routeIs('/', true) }"
            type="link"
            href="/"
            :aria-current="routeIs('/', true) ? 'page' : undefined"
            :aria-selected="routeIs('/', true)"
            @click="activateNavigationDestination($event, '/')"
          >
            <template #start>
              <MaterialIcon :name="shellNavigationIcons.home" :size="24" :filled="routeIs('/', true)" />
            </template>
            <template #headline><DisplayText :value="labelFor('home', 'Home')" /></template>
          </UiListItem>
        </UiList>

        <section
          v-for="group in drawerGroups"
          :key="group.id"
          class="navigation-drawer__group"
          :class="{ 'is-expanded': navigationGroupExpanded(group) }"
        >
          <div class="navigation-drawer__group-heading" :class="{ 'is-active': routeIs(group.to) }">
            <button
              v-if="navigationCollapsed && wideNavigation"
              class="navigation-rail__destination"
              :class="{ 'is-selected': routeIs(group.to) }"
              type="button"
              :aria-label="
                navigationGroupExpanded(group) ? `${t('collapse')} ${group.label}` : `${t('expand')} ${group.label}`
              "
              :aria-controls="navigationGroupItemsId(group)"
              :aria-expanded="navigationGroupExpanded(group)"
              @click="activateNavigationGroup(group)"
            >
              <span class="navigation-rail__indicator">
                <MaterialIcon :name="group.icon" :size="24" :filled="routeIs(group.to)" />
              </span>
              <span class="navigation-rail__label">
                <DisplayText :value="group.label" />
              </span>
              <md-ripple />
            </button>
            <UiList v-else class="navigation-drawer__group-list">
              <UiListItem
                class="navigation-drawer__item navigation-drawer__group-trigger"
                :class="{ 'is-selected': routeIs(group.to) }"
                type="button"
                :aria-controls="navigationGroupItemsId(group)"
                :aria-expanded="navigationGroupExpanded(group)"
                :aria-selected="routeIs(group.to)"
                @click="activateNavigationGroup(group)"
              >
                <template #start>
                  <MaterialIcon :name="group.icon" :size="24" :filled="routeIs(group.to)" />
                </template>
                <template #headline>
                  <DisplayText :value="group.label" />
                </template>
                <template #end>
                  <MaterialIcon
                    class="navigation-drawer__expand-icon"
                    :name="navigationGroupExpanded(group) ? 'expand_less' : 'expand_more'"
                    :size="24"
                  />
                </template>
              </UiListItem>
            </UiList>
          </div>

          <div
            v-show="navigationGroupExpanded(group)"
            :id="navigationGroupItemsId(group)"
            class="navigation-drawer__items"
          >
            <div
              v-for="item in group.items"
              :key="item.id"
              class="navigation-drawer__subgroup"
              :class="{
                'has-children': item.children?.length,
                'is-active': destinationIsActive(item),
                'is-expanded': navigationItemExpanded(item),
              }"
            >
              <UiList v-if="item.children?.length" class="navigation-drawer__parent-list">
                <UiListItem
                  class="navigation-drawer__item navigation-drawer__parent-button"
                  :class="{ 'is-selected': destinationIsActive(item) }"
                  type="button"
                  :aria-label="
                    navigationItemExpanded(item) ? `${t('collapse')} ${item.label}` : `${t('expand')} ${item.label}`
                  "
                  :aria-controls="navigationChildrenId(item)"
                  :aria-expanded="navigationItemExpanded(item)"
                  :aria-selected="destinationIsActive(item)"
                  @click="toggleNavigationItem(item)"
                >
                  <template #start>
                    <MaterialIcon :name="item.icon" :size="24" :filled="destinationIsActive(item)" />
                  </template>
                  <template #headline>
                    <DisplayText :value="item.label" />
                  </template>
                  <template #end>
                    <MaterialIcon
                      class="navigation-drawer__expand-icon"
                      :name="navigationItemExpanded(item) ? 'expand_less' : 'expand_more'"
                      :size="24"
                    />
                  </template>
                </UiListItem>
              </UiList>
              <UiListItem
                v-else
                class="navigation-drawer__item"
                :class="{ 'is-selected': routeIs(item.to, item.exact) }"
                type="link"
                :href="item.to"
                :aria-current="routeIs(item.to, item.exact) ? 'page' : undefined"
                :aria-selected="routeIs(item.to, item.exact)"
                @click="activateNavigationDestination($event, item.to)"
              >
                <template #start>
                  <MaterialIcon :name="item.icon" :size="24" :filled="routeIs(item.to, item.exact)" />
                </template>
                <template #headline><DisplayText :value="item.label" /></template>
              </UiListItem>

              <UiList
                v-if="item.children?.length"
                v-show="navigationItemExpanded(item)"
                :id="navigationChildrenId(item)"
                class="navigation-drawer__children"
              >
                <UiListItem
                  v-for="child in item.children"
                  :key="child.id"
                  class="navigation-drawer__item navigation-drawer__child"
                  :class="{ 'is-selected': routeIs(child.to, child.exact) }"
                  type="link"
                  :href="child.to"
                  :aria-current="routeIs(child.to, child.exact) ? 'page' : undefined"
                  :aria-selected="routeIs(child.to, child.exact)"
                  @click="activateNavigationDestination($event, child.to)"
                >
                  <template #start>
                    <MaterialIcon :name="child.icon" :size="24" :filled="routeIs(child.to, child.exact)" />
                  </template>
                  <template #headline><DisplayText :value="child.label" /></template>
                </UiListItem>
              </UiList>
            </div>
          </div>
        </section>
      </nav>

      <nav class="navigation-drawer__utility" :aria-label="t('account')">
        <UiList class="navigation-drawer__utility-list">
          <div v-if="track && playerCollapsed" class="navigation-drawer__utility-entry navigation-drawer__player-entry">
            <button
              v-if="navigationCollapsed && wideNavigation"
              class="navigation-rail__destination navigation-rail__player-action"
              type="button"
              :aria-label="t('player')"
              @click="expandPlayer"
            >
              <span class="navigation-rail__indicator">
                <MaterialIcon name="music_note" :size="24" />
              </span>
              <span class="navigation-rail__label"><DisplayText :value="t('player')" /></span>
              <md-ripple />
            </button>
            <UiListItem
              v-else
              class="navigation-drawer__item navigation-drawer__player-action"
              type="button"
              :aria-label="t('player')"
              @click="expandPlayer"
            >
              <template #start>
                <MaterialIcon name="music_note" :size="24" />
              </template>
              <template #headline><DisplayText :value="t('player')" /></template>
            </UiListItem>
          </div>
          <div
            v-for="item in utilityDestinations"
            :key="item.id"
            class="navigation-drawer__utility-entry"
            :class="{ 'is-active': routeIs(item.to) }"
          >
            <NuxtLink
              v-if="navigationCollapsed && wideNavigation"
              class="navigation-rail__destination"
              :class="{ 'is-selected': routeIs(item.to) }"
              :to="item.to"
              :aria-current="routeIs(item.to) ? 'page' : undefined"
            >
              <span class="navigation-rail__indicator">
                <LazyUserAvatar
                  v-if="item.id === 'account' && displayIdentity"
                  :src="displayIdentity.avatarUrl"
                  :name="displayIdentity.name"
                  :seed="displayIdentity.avatarSeed"
                  size="xs"
                  loading="eager"
                />
                <MaterialIcon v-else :name="item.icon" :size="24" :filled="routeIs(item.to)" />
              </span>
              <span class="navigation-rail__label"><DisplayText :value="item.label" /></span>
              <md-ripple />
            </NuxtLink>
            <UiListItem
              v-else
              class="navigation-drawer__item"
              :class="{ 'is-selected': routeIs(item.to) }"
              type="link"
              :href="item.to"
              :aria-current="routeIs(item.to) ? 'page' : undefined"
              :aria-selected="routeIs(item.to)"
              @click="activateNavigationDestination($event, item.to)"
            >
              <template #start>
                <LazyUserAvatar
                  v-if="item.id === 'account' && displayIdentity"
                  :src="displayIdentity.avatarUrl"
                  :name="displayIdentity.name"
                  :seed="displayIdentity.avatarSeed"
                  size="xs"
                  loading="eager"
                />
                <MaterialIcon v-else :name="item.icon" :size="24" :filled="routeIs(item.to)" />
              </template>
              <template #headline><DisplayText :value="item.label" /></template>
            </UiListItem>
          </div>
        </UiList>
      </nav>
    </aside>

    <main id="main-content" class="app-shell__main" :inert="!wideNavigation && navigationOpen" tabindex="-1">
      <slot />
    </main>

    <ClientOnly>
      <LazyAudioDock v-if="track" />
    </ClientOnly>
  </div>
</template>

<style scoped>
:global(:root) {
  --shell-navigation-width: var(--md-comp-navigation-drawer-width);
  --shell-bottom-navigation-height: 0px;
  --player-inset: 0px;
}

/* Full-screen detail surfaces and the audio dock are teleported to <body>, so
 * the player inset must live on the document root instead of only on the shell
 * element. The shell class remains the single reactive source of truth. */
:global(:root:has(.app-shell--playing)) {
  --player-inset: var(--md-comp-audio-dock-height);
}

:global(:root[data-navigation-collapsed="true"]) {
  --shell-navigation-width: var(--md-comp-navigation-rail-width);
}

.app-shell {
  display: grid;
  width: 100%;
  height: var(--app-viewport-height, 100dvh);
  grid-template-columns: var(--shell-navigation-width) minmax(0, 1fr);
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface);
}

.skip-link {
  position: fixed;
  z-index: var(--md-sys-z-index-a11y);
  top: var(--md-sys-spacing-2);
  left: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface);
  transform: translateY(-160%);
}

.skip-link:focus {
  transform: translateY(0);
}

.navigation-drawer {
  z-index: var(--md-sys-z-index-shell-navigation);
  display: grid;
  width: var(--shell-navigation-width);
  min-width: 0;
  min-height: 0;
  grid-column: 1;
  grid-row: 1;
  grid-template-rows: 72px minmax(0, 1fr) auto;
  overflow: hidden;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.navigation-drawer:focus {
  outline: none;
}

.navigation-drawer__header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
}

.navigation-drawer__brand {
  position: relative;
  display: flex;
  min-width: 0;
  height: 56px;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding-inline: var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  border-radius: var(--md-sys-shape-corner-large);
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
}

.navigation-drawer__brand img {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  aspect-ratio: 1;
  object-fit: contain;
}

.navigation-drawer__brand strong {
  font: inherit;
  letter-spacing: 0;
}

.navigation-drawer__close {
  display: none;
  flex: 0 0 auto;
}

.navigation-drawer__toggle {
  --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
  --md-comp-icon-button-visual-size: var(--md-comp-control-height-touch);

  width: var(--md-comp-control-height-touch);
  height: var(--md-comp-control-height-touch);
  min-width: var(--md-comp-control-height-touch);
  min-height: var(--md-comp-control-height-touch);
  flex: 0 0 auto;
  align-self: center;
  justify-self: center;
}

.navigation-drawer__toggle :deep(.md3-icon-button__icon) {
  display: grid;
  place-items: center;
}

.navigation-drawer__content {
  display: grid;
  min-height: 0;
  align-content: start;
  gap: var(--md-sys-spacing-3);
  padding: 0 var(--md-sys-spacing-2) var(--md-sys-spacing-4);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.navigation-drawer__root-list,
.navigation-drawer__group-list,
.navigation-drawer__parent-list,
.navigation-drawer__children,
.navigation-drawer__utility-list {
  min-width: 0;
  padding: 0;
  --md-list-container-color: transparent;
}

.navigation-drawer__group,
.navigation-drawer__items,
.navigation-drawer__subgroup,
.navigation-drawer__utility-entry {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.navigation-drawer__group {
  padding-top: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.navigation-drawer__group-heading {
  min-width: 0;
}

.navigation-drawer__item {
  display: flex;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  --md-list-item-container-color: transparent;
  --md-list-item-one-line-container-height: 48px;
  --md-list-item-top-space: 0;
  --md-list-item-bottom-space: 0;
  --md-list-item-leading-space: var(--md-sys-spacing-4);
  --md-list-item-trailing-space: var(--md-sys-spacing-4);
  --md-list-item-label-text-color: var(--md-sys-color-on-surface-variant);
  --md-list-item-label-text-font: var(--md-sys-typescale-label-large-font);
  --md-list-item-label-text-size: var(--md-sys-typescale-label-large-size);
  --md-list-item-label-text-weight: var(--md-sys-typescale-label-large-weight);
  --md-list-item-label-text-line-height: var(--md-sys-typescale-label-large-line-height);
  --md-list-item-leading-icon-color: var(--md-sys-color-on-surface-variant);
  --md-list-item-trailing-icon-color: var(--md-sys-color-on-surface-variant);
}

.navigation-drawer__item.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-leading-icon-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-trailing-icon-color: var(--md-sys-color-on-secondary-container);
}

.navigation-drawer__expand-icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  transition: transform var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.navigation-drawer__children {
  margin: 2px 0 var(--md-sys-spacing-1) 28px;
  padding-left: var(--md-sys-spacing-2);
  border-left: 1px solid var(--md-sys-color-outline-variant);
}

.navigation-drawer__child {
  --md-list-item-leading-space: var(--md-sys-spacing-3);
}

.navigation-drawer__brand md-ripple {
  border-radius: inherit;
}

.navigation-drawer__brand md-ripple {
  --md-ripple-hover-color: var(--md-sys-color-on-surface);
  --md-ripple-pressed-color: var(--md-sys-color-primary);
}

.navigation-drawer__utility {
  padding: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.navigation-drawer__utility-list {
  gap: 2px;
}

.navigation-drawer__utility :deep(.user-avatar) {
  --user-avatar-size: 24px;

  display: grid;
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  max-width: 24px;
  max-height: 24px;
  flex: 0 0 24px;
  aspect-ratio: 1;
  place-items: center;
  border-radius: 50%;
}

.navigation-drawer__utility :deep(.user-avatar img) {
  display: block;
  border-radius: inherit;
}

.navigation-drawer__scrim {
  display: none;
}

.app-shell__main {
  min-width: 0;
  min-height: 0;
  grid-column: 2;
  padding-bottom: var(--player-inset);
  overflow: hidden;
}

:global(.audio-dock) {
  left: var(--shell-navigation-width) !important;
}

@media (min-width: 840px) {
  .app-shell.is-navigation-collapsed .navigation-drawer {
    grid-template-rows: 112px minmax(0, 1fr) auto;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__header {
    display: grid;
    grid-template-rows: repeat(2, 48px);
    justify-content: center;
    padding: var(--md-sys-spacing-2);
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__brand {
    display: grid;
    width: 48px;
    height: 48px;
    flex: none;
    place-items: center;
    padding: 0;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__brand img {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    flex: 0 0 32px;
    aspect-ratio: 1;
    place-self: center;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__toggle {
    width: 48px;
    height: 48px;
    min-width: 48px;
    min-height: 48px;
    flex: 0 0 48px;
    align-self: center;
    justify-self: center;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__brand strong {
    display: none;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__content {
    justify-items: center;
    gap: var(--md-sys-spacing-1);
    padding-inline: 0;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__root-list,
  .app-shell.is-navigation-collapsed .navigation-drawer__group {
    width: 100%;
    justify-items: center;
    padding-top: 0;
    border-top: 0;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__root-list,
  .app-shell.is-navigation-collapsed .navigation-drawer__utility-list {
    align-items: center;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__items {
    display: none;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__group-heading,
  .app-shell.is-navigation-collapsed .navigation-drawer__utility-entry {
    display: grid;
    width: 100%;
    justify-items: center;
  }

  /* A Navigation Rail destination is one vertical target: the 56 × 32
   * selected indicator surrounds only the icon, with its label directly
   * underneath. The overall destination stays above the 48 px touch target. */
  .app-shell.is-navigation-collapsed .navigation-rail__destination {
    --md-ripple-hover-color: var(--md-sys-color-on-surface);
    --md-ripple-pressed-color: var(--md-sys-color-on-surface);

    position: relative;
    display: grid;
    width: 100%;
    min-width: var(--md-comp-control-height-touch);
    min-height: 64px;
    grid-template-rows: 32px 16px;
    align-content: center;
    justify-items: center;
    gap: var(--md-sys-spacing-1);
    padding: var(--md-sys-spacing-1) 0;
    overflow: hidden;
    color: var(--md-sys-color-on-surface-variant);
    border: 0;
    border-radius: var(--md-sys-shape-corner-large);
    background: transparent;
    font-family: var(--md-sys-typescale-label-medium-font);
    font-size: var(--md-sys-typescale-label-medium-size);
    font-weight: var(--md-sys-typescale-label-medium-weight);
    line-height: var(--md-sys-typescale-label-medium-line-height);
    letter-spacing: var(--md-sys-typescale-label-medium-tracking);
    text-align: center;
    text-decoration: none;
    cursor: pointer;
  }

  .app-shell.is-navigation-collapsed .navigation-rail__indicator {
    display: grid;
    width: 56px;
    height: 32px;
    place-items: center;
    border-radius: var(--md-sys-shape-corner-full);
  }

  .app-shell.is-navigation-collapsed .navigation-rail__label {
    display: block;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-shell.is-navigation-collapsed .navigation-rail__destination.is-selected {
    color: var(--md-sys-color-on-surface);
  }

  .app-shell.is-navigation-collapsed .navigation-rail__destination.is-selected .navigation-rail__indicator {
    color: var(--md-sys-color-on-secondary-container);
    background: var(--md-sys-color-secondary-container);
  }

  .app-shell.is-navigation-collapsed .navigation-rail__destination md-ripple {
    border-radius: inherit;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__utility {
    justify-items: center;
    padding-inline: 0;
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__utility-list {
    width: 100%;
    gap: var(--md-sys-spacing-1);
  }

  .app-shell.is-navigation-collapsed .navigation-drawer__utility :deep(.user-avatar) {
    --user-avatar-size: 24px;

    display: grid;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    max-width: 24px;
    max-height: 24px;
    flex: 0 0 24px;
    aspect-ratio: 1;
    place-self: center;
    place-items: center;
  }

  .app-shell.is-navigation-collapsed .navigation-rail__indicator :deep(.user-avatar) {
    place-self: center;
  }
}

@media (max-width: 839px), (max-width: 959px) and (max-height: 500px) {
  :global(:root),
  :global(:root[data-navigation-collapsed="true"]) {
    --shell-navigation-width: 0px;
    --shell-bottom-navigation-height: var(--md-sys-safe-area-inset-bottom);
  }

  .app-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .navigation-drawer {
    position: fixed;
    z-index: var(--md-sys-z-index-overlay-drawer);
    top: 0;
    bottom: 0;
    left: 0;
    width: min(var(--md-comp-navigation-drawer-width), calc(100vw - var(--md-sys-spacing-4)));
    grid-template-rows: calc(72px + var(--md-sys-safe-area-inset-top)) minmax(0, 1fr) auto;
    border-right: 0;
    border-radius: 0 var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0;
    box-shadow: var(--md-sys-elevation-level3);
    transform: translateX(-104%);
    visibility: hidden;
    transition:
      transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized),
      visibility 0s var(--md-sys-motion-duration-medium2);
  }

  .navigation-drawer.is-open {
    transform: translateX(0);
    visibility: visible;
    transition-delay: 0s;
  }

  .navigation-drawer__close {
    display: inline-flex;
  }

  .navigation-drawer__header {
    padding-top: calc(var(--md-sys-spacing-2) + var(--md-sys-safe-area-inset-top));
    padding-left: max(var(--md-sys-spacing-3), var(--md-sys-safe-area-inset-left));
  }

  .navigation-drawer__toggle {
    display: none;
  }

  .navigation-drawer__scrim {
    position: fixed;
    z-index: var(--md-sys-z-index-overlay-backdrop);
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: rgb(0 0 0 / 0.32);
  }

  .app-shell__main {
    grid-column: 1;
    grid-row: 1;
    padding-bottom: calc(var(--player-inset) + var(--md-sys-safe-area-inset-bottom));
  }

  .navigation-drawer__utility {
    padding-bottom: max(var(--md-sys-spacing-2), var(--md-sys-safe-area-inset-bottom));
  }

  :global(.audio-dock) {
    right: 0 !important;
    bottom: var(--shell-bottom-navigation-height) !important;
    left: 0 !important;
  }
}
</style>
