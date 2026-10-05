import type { SearchCheckpoint, SearchResult } from "../contracts.ts";

/** Bump whenever scoring, adaptation, chart interpretation or enumeration changes. */
export const SEARCH_ENGINE_REVISION = "native-qualified-account-character-rank-total-search-v18";

function canonical(value: unknown): string {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))
    return String(Object.is(value, -0) ? "-0" : value);
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("checkpoint-value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Caller supplies the complete evaluator inputs, including worker-local closure data.
 * Remove only search budget: it cannot change an already exhaustive result.
 */
export async function searchFingerprint(semanticInputs: unknown): Promise<string> {
  return digest({ engineRevision: SEARCH_ENGINE_REVISION, semanticInputs });
}

export async function createSearchCheckpoint(
  fingerprint: string,
  result: SearchResult,
): Promise<SearchCheckpoint | null> {
  if (result.completeness !== "exhaustive" || result.proof?.status !== "proven") return null;
  // Snapshot once at completion. No reference to a mutable running frontier.
  const completed = JSON.parse(JSON.stringify(result)) as SearchResult;
  return {
    schema: "haneoka-search-checkpoint-v1",
    engineRevision: SEARCH_ENGINE_REVISION,
    fingerprint,
    resultDigest: await digest(completed),
    result: completed,
  };
}

/** Digests detect stale or corrupted local cache data; they are not authentication. */
export async function restoreSearchCheckpoint(
  checkpoint: SearchCheckpoint | undefined,
  fingerprint: string,
): Promise<SearchResult | null> {
  if (
    !checkpoint ||
    checkpoint.schema !== "haneoka-search-checkpoint-v1" ||
    checkpoint.engineRevision !== SEARCH_ENGINE_REVISION ||
    checkpoint.fingerprint !== fingerprint ||
    checkpoint.result?.completeness !== "exhaustive" ||
    checkpoint.result.proof?.status !== "proven"
  )
    return null;
  try {
    if ((await digest(checkpoint.result)) !== checkpoint.resultDigest) return null;
    return JSON.parse(JSON.stringify(checkpoint.result)) as SearchResult;
  } catch {
    return null;
  }
}
