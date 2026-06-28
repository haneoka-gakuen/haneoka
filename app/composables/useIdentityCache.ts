const IDENTITY_CACHE_KEY = "haneoka-account-identity-v1";
const IDENTITY_CACHE_SCHEMA = 1 as const;

export interface CachedAccountIdentity {
  accountName: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  ownerUserId: string;
  savedAt: number;
  schema: typeof IDENTITY_CACHE_SCHEMA;
  sessionImage: string | null;
  sessionName: string | null;
}

type CachedAccountIdentityPatch = Partial<
  Pick<CachedAccountIdentity, "accountName" | "avatarUrl" | "displayName" | "sessionImage" | "sessionName">
>;

const nullableString = (value: unknown, maxLength: number): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const normalized = value.trim();
  return normalized || null;
};

const parseCachedIdentity = (value: unknown): CachedAccountIdentity | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const ownerUserId = nullableString(candidate.ownerUserId, 256);
  const accountName = nullableString(candidate.accountName, 256);
  const avatarUrl = nullableString(candidate.avatarUrl, 2_048);
  const displayName = nullableString(candidate.displayName, 256);
  const sessionImage = nullableString(candidate.sessionImage, 2_048);
  const sessionName = nullableString(candidate.sessionName, 256);
  if (
    candidate.schema !== IDENTITY_CACHE_SCHEMA ||
    !ownerUserId ||
    accountName === undefined ||
    avatarUrl === undefined ||
    displayName === undefined ||
    sessionImage === undefined ||
    sessionName === undefined ||
    typeof candidate.savedAt !== "number" ||
    !Number.isSafeInteger(candidate.savedAt) ||
    candidate.savedAt < 0
  ) {
    return null;
  }
  return {
    accountName,
    avatarUrl,
    displayName,
    ownerUserId,
    savedAt: candidate.savedAt,
    schema: IDENTITY_CACHE_SCHEMA,
    sessionImage,
    sessionName,
  };
};

const readCachedIdentity = (): CachedAccountIdentity | null => {
  if (!import.meta.client) return null;
  try {
    const stored = localStorage.getItem(IDENTITY_CACHE_KEY);
    if (!stored) return null;
    return parseCachedIdentity(JSON.parse(stored) as unknown);
  } catch {
    return null;
  }
};

export const useIdentityCache = () => {
  const identity = useState<CachedAccountIdentity | null>("cached-account-identity", () => null);
  const initialized = useState<boolean>("cached-account-identity-initialized", () => false);

  const persist = (value: CachedAccountIdentity | null) => {
    if (!import.meta.client) return;
    try {
      if (value) localStorage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(value));
      else localStorage.removeItem(IDENTITY_CACHE_KEY);
    } catch {
      // Storage may be unavailable in hardened or private browser contexts.
    }
  };

  if (import.meta.client && !initialized.value) {
    identity.value = readCachedIdentity();
    initialized.value = true;
    // Re-serialize the validated shape so obsolete or unexpected fields are never retained.
    persist(identity.value);
  }

  const clear = () => {
    identity.value = null;
    initialized.value = true;
    persist(null);
  };

  const remember = (ownerUserId: string, patch: CachedAccountIdentityPatch) => {
    const normalizedOwner = ownerUserId.trim();
    if (!normalizedOwner || normalizedOwner.length > 256) return;
    const current = identity.value?.ownerUserId === normalizedOwner ? identity.value : null;
    const next = parseCachedIdentity({
      accountName: patch.accountName !== undefined ? patch.accountName : current?.accountName || null,
      avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : current?.avatarUrl || null,
      displayName: patch.displayName !== undefined ? patch.displayName : current?.displayName || null,
      ownerUserId: normalizedOwner,
      savedAt: Date.now(),
      schema: IDENTITY_CACHE_SCHEMA,
      sessionImage: patch.sessionImage !== undefined ? patch.sessionImage : current?.sessionImage || null,
      sessionName: patch.sessionName !== undefined ? patch.sessionName : current?.sessionName || null,
    });
    if (!next) return;
    identity.value = next;
    initialized.value = true;
    persist(next);
  };

  return {
    clear,
    identity: readonly(identity),
    remember,
  };
};
