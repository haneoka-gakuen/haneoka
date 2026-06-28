import type { HistoryState, LocationQueryRaw, LocationQueryValue, RouteLocationRaw } from "vue-router";

interface RouteQueryLayerOptions {
  clearOnClose?: readonly string[];
}

const firstQueryValue = (value: LocationQueryValue | LocationQueryValue[] | undefined) => {
  const item = Array.isArray(value) ? value[0] : value;
  return item == null ? "" : String(item);
};

const applyQueryPatch = (query: LocationQueryRaw, patch: LocationQueryRaw) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") delete query[key];
    else query[key] = value;
  }
};

const layerParentStateKey = (key: string) => `__haneoka_query_layer_parent_${key}`;

interface RouteQueryLayerParentState extends HistoryState {
  version: 1;
  key: string;
  parentFullPath: string;
  targetPath: string;
  parentPosition?: number;
}

const routeQueryLayerParent = (value: HistoryState[string]): RouteQueryLayerParentState | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as RouteQueryLayerParentState;
  return candidate.version === 1 &&
    typeof candidate.key === "string" &&
    typeof candidate.parentFullPath === "string" &&
    typeof candidate.targetPath === "string"
    ? candidate
    : undefined;
};

export const createRouteQueryLayerState = (
  key: string,
  parentFullPath: string,
  targetPath: string,
  parentPosition?: number,
): HistoryState => ({
  [layerParentStateKey(key)]: {
    version: 1,
    key,
    parentFullPath,
    targetPath,
    parentPosition,
  },
});

/**
 * Models a query-backed, full-screen detail as a real navigation layer.
 *
 * Filters keep using useRouteQueryState/replace. Opening a detail pushes one
 * history entry and records its exact parent. Switching peer details replaces
 * that entry, and closing only pops an entry that this composable created.
 * Direct and unmarked cross-route links fall back to revealing the owning
 * catalog page instead of accidentally jumping to an unrelated source page.
 */
export const useRouteQueryLayer = (key: string, options: RouteQueryLayerOptions = {}) => {
  const router = useRouter();
  const parentStateKey = layerParentStateKey(key);

  const open = (value: string | number, patch: LocationQueryRaw = {}) => {
    const current = router.currentRoute.value;
    const query: LocationQueryRaw = { ...current.query };
    applyQueryPatch(query, patch);
    query[key] = String(value);

    const target: RouteLocationRaw = {
      path: current.path,
      query,
      hash: current.hash,
    };
    if (firstQueryValue(current.query[key])) {
      const recordedParent = routeQueryLayerParent(router.options.history.state[parentStateKey]);
      return router.replace(
        recordedParent
          ? {
              ...target,
              state: createRouteQueryLayerState(
                key,
                recordedParent.parentFullPath,
                recordedParent.targetPath,
                recordedParent.parentPosition,
              ),
            }
          : target,
      );
    }
    const parentPosition = router.options.history.state.position;
    return router.push({
      ...target,
      state: createRouteQueryLayerState(
        key,
        current.fullPath,
        current.path,
        typeof parentPosition === "number" ? parentPosition : undefined,
      ),
    });
  };

  const close = () => {
    const current = router.currentRoute.value;
    // A delayed transition callback or a second Back gesture can arrive after
    // this layer was already removed. Closing an absent layer must not pop its
    // parent.
    if (!firstQueryValue(current.query[key])) return;

    const previousLocation = router.options.history.state.back;
    const recordedParent = routeQueryLayerParent(router.options.history.state[parentStateKey]);

    if (typeof previousLocation === "string" && previousLocation) {
      const previous = router.resolve(previousLocation);
      const recorded = recordedParent ? router.resolve(recordedParent.parentFullPath) : undefined;
      const currentPosition = router.options.history.state.position;
      const positionMatches =
        recordedParent?.parentPosition === undefined ||
        (typeof currentPosition === "number" && currentPosition === recordedParent.parentPosition + 1);
      const isRecordedParent =
        recordedParent?.key === key &&
        recordedParent.targetPath === current.path &&
        recorded?.fullPath === previous.fullPath &&
        positionMatches;
      // Same-page fallback keeps detail entries created before an HMR update
      // working without restoring the old, unsafe cross-route heuristic.
      const isLegacySamePageParent =
        recorded === undefined && previous.path === current.path && !firstQueryValue(previous.query[key]);
      if ((isRecordedParent || isLegacySamePageParent) && !firstQueryValue(previous.query[key])) {
        router.back();
        return;
      }
    }

    const query: LocationQueryRaw = { ...current.query };
    delete query[key];
    for (const childKey of options.clearOnClose ?? []) delete query[childKey];
    return router.replace({ path: current.path, query, hash: current.hash });
  };

  const toggle = (value: string | number, patch: LocationQueryRaw = {}) => {
    const selected = firstQueryValue(router.currentRoute.value.query[key]);
    return selected === String(value) ? close() : open(value, patch);
  };

  return { close, open, toggle };
};

export const useRouteQueryLayerLink = () => {
  const route = useRoute();
  const router = useRouter();

  return (to: RouteLocationRaw, key: string): RouteLocationRaw => {
    const target = router.resolve(to);
    const parentPosition = router.options.history.state.position;
    return {
      path: target.path,
      query: target.query,
      hash: target.hash,
      state: createRouteQueryLayerState(
        key,
        route.fullPath,
        target.path,
        typeof parentPosition === "number" ? parentPosition : undefined,
      ),
    };
  };
};
