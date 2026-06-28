import type { LocationQueryRaw, LocationQueryValue, Router } from "vue-router";

type QueryValue = LocationQueryValue | LocationQueryValue[];

interface QueryCodec<T> {
  parse(value: QueryValue | undefined): T;
  serialize(value: T): string | undefined;
}

const firstQueryValue = (value: QueryValue | undefined): string => {
  const item = Array.isArray(value) ? value[0] : value;
  return item == null ? "" : String(item);
};

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

interface QueryBatch {
  flushing: boolean;
  path?: string;
  patch: QueryPatch[];
  scheduled: boolean;
}

interface QueryOwner {
  active: boolean;
}

interface QueryPatch {
  key: string;
  owner: QueryOwner;
  path: string;
  value: string | undefined;
}

const queryBatches = new WeakMap<Router, QueryBatch>();

const flushQueryBatch = async (router: Router, batch: QueryBatch) => {
  if (batch.flushing) return;
  batch.scheduled = false;
  batch.flushing = true;

  try {
    while (batch.patch.length) {
      const path = batch.path;
      if (!path || router.currentRoute.value.path !== path) {
        batch.patch.length = 0;
        break;
      }

      const pending = batch.patch.splice(0);
      const patch = new Map<string, string | undefined>();
      for (const entry of pending) {
        if (entry.owner.active && entry.path === path) patch.set(entry.key, entry.value);
      }
      if (!patch.size) continue;

      const current = router.currentRoute.value;
      const query: LocationQueryRaw = { ...current.query };

      for (const [key, value] of patch) {
        if (value) query[key] = value;
        else delete query[key];
      }

      try {
        await router.replace({ path, query, hash: current.hash });
      } catch (error) {
        if (router.currentRoute.value.path === path) {
          console.error("Failed to synchronize route query state", error);
        }
      }
    }
  } finally {
    batch.flushing = false;
    if (batch.patch.length && !batch.scheduled) {
      batch.scheduled = true;
      queueMicrotask(() => void flushQueryBatch(router, batch));
    } else if (!batch.patch.length) {
      batch.path = undefined;
    }
  }
};

const scheduleQueryReplace = (
  router: Router,
  batch: QueryBatch,
  path: string,
  owner: QueryOwner,
  key: string,
  value: string | undefined,
) => {
  if (!owner.active) return;
  if (router.currentRoute.value.path !== path) return;
  if (batch.path && batch.path !== path) batch.patch.length = 0;
  batch.path = path;
  if (key) batch.patch.push({ key, owner, path, value });
  if (batch.scheduled || batch.flushing) return;
  batch.scheduled = true;
  queueMicrotask(() => void flushQueryBatch(router, batch));
};

const queryBatchFor = (router: Router) => {
  const existing = queryBatches.get(router);
  if (existing) return existing;
  const batch: QueryBatch = { flushing: false, patch: [], scheduled: false };
  router.beforeEach((to, from) => {
    if (to.path === from.path) return;
    batch.patch.length = 0;
    batch.path = undefined;
  });
  queryBatches.set(router, batch);
  return batch;
};

export const useRouteQueryState = <T>(key: string, codec: QueryCodec<T>) => {
  const route = useRoute();
  const router = useRouter();
  const batch = queryBatchFor(router);
  const owner: QueryOwner = { active: true };
  const state = ref(codec.parse(route.query[key])) as Ref<T>;
  let applyingRoute = false;

  onScopeDispose(() => {
    owner.active = false;
    batch.patch = batch.patch.filter((entry) => entry.owner !== owner);
  });

  watch(
    () => route.query[key],
    (value) => {
      const next = codec.parse(value);
      if (equal(next, state.value)) return;
      applyingRoute = true;
      state.value = next;
      queueMicrotask(() => {
        applyingRoute = false;
      });
    },
    { deep: true },
  );

  watch(
    state,
    (value) => {
      if (applyingRoute) return;
      const serialized = codec.serialize(value);
      if (firstQueryValue(route.query[key]) === (serialized || "")) return;
      scheduleQueryReplace(router, batch, route.path, owner, key, serialized);
    },
    { deep: true },
  );

  return state;
};

export const useRouteQueryText = (key: string) =>
  useRouteQueryState(key, {
    parse: firstQueryValue,
    serialize: (value) => value.trim() || undefined,
  });

export const useRouteQueryList = (key: string, numeric = false) =>
  useRouteQueryState<Array<string | number>>(key, {
    parse: (raw) => {
      const values = firstQueryValue(raw)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return numeric ? values.map(Number).filter(Number.isFinite) : values;
    },
    serialize: (values) => (values.length ? values.join(",") : undefined),
  });

export const useRouteQueryEnum = <T extends string>(key: string, values: readonly T[], fallback: T) =>
  useRouteQueryState<T>(key, {
    parse: (raw) => {
      const value = firstQueryValue(raw) as T;
      return values.includes(value) ? value : fallback;
    },
    serialize: (value) => (value === fallback ? undefined : value),
  });

export const useRouteQueryNumber = (key: string) =>
  useRouteQueryState<number | undefined>(key, {
    parse: (raw) => {
      const value = Number(firstQueryValue(raw));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    },
    serialize: (value) => (value == null ? undefined : String(value)),
  });

export const useRouteQueryInteger = (key: string, fallback: number, options: { min?: number; max?: number } = {}) =>
  useRouteQueryState<number>(key, {
    parse: (raw) => {
      const serialized = firstQueryValue(raw);
      if (!serialized) return fallback;
      const value = Number(serialized);
      if (!Number.isInteger(value)) return fallback;
      if (options.min !== undefined && value < options.min) return fallback;
      if (options.max !== undefined && value > options.max) return fallback;
      return value;
    },
    serialize: (value) => (value === fallback ? undefined : String(value)),
  });
