export interface ExternalResourceUrlPolicy {
  readonly id: string;
  readonly accepts: (url: string) => boolean;
}

const policies = new Map<string, ExternalResourceUrlPolicy>();

export const registerExternalResourceUrlPolicy = (policy: ExternalResourceUrlPolicy): void => {
  const id = String(policy.id || "").trim();
  if (!id) throw new TypeError("External resource URL policy id must not be empty");
  policies.set(id, { ...policy, id });
};

export const isAcceptedExternalResourceUrl = (url: string): boolean => {
  for (const policy of policies.values()) {
    if (policy.accepts(url)) return true;
  }
  return false;
};
