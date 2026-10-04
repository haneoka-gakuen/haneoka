import type { Candidate, EvidenceGap, SearchResumeCheckpoint } from "./contracts.ts";
import type { AssignmentCursorState } from "./assignment-cursor.ts";
import type { SearchCollectorState } from "./search-collectors.ts";
import { SEARCH_ENGINE_REVISION, searchFingerprint } from "./solver/search-checkpoint.ts";

export interface SearchResumeState {
  schema: "haneoka-search-resume-state-v1";
  cursor: AssignmentCursorState;
  frontier: Candidate[];
  collectors: SearchCollectorState;
  evaluated: number;
  gaps: EvidenceGap[];
  incompleteNativeInputs: boolean;
  /** Already evaluated/collected but not retained at the frontier memory cap. */
  pendingCandidate?: Candidate;
}
export type { SearchResumeCheckpoint } from "./contracts.ts";
function valid(value: unknown, fingerprint: string): value is SearchResumeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as SearchResumeState;
  return state.schema === "haneoka-search-resume-state-v1" && state.cursor?.fingerprint === fingerprint &&
    state.cursor.schema === "haneoka-assignment-cursor-v1" && Number.isSafeInteger(state.evaluated) &&
    state.evaluated >= 0 && state.evaluated === state.cursor.completedLeaves &&
    Array.isArray(state.cursor.tasks) && state.cursor.tasks.length <= 20001 &&
    Array.isArray(state.frontier) && state.frontier.length <= 1000 && Array.isArray(state.gaps) &&
    state.gaps.every(gap => !!gap && typeof gap.code === "string" && typeof gap.source === "string") &&
    typeof state.incompleteNativeInputs === "boolean" && state.collectors?.schema === "haneoka-search-collector-v1";
}

/** Incomplete work is separate from the existing exhaustive/proven cache. */
export async function createSearchResumeCheckpoint(fingerprint: string, state: SearchResumeState): Promise<SearchResumeCheckpoint | null> {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || !valid(state, fingerprint) ||
    (!state.cursor.tasks.length && !state.pendingCandidate)) return null;
  const snapshot = structuredClone(state);
  return { schema: "haneoka-search-resume-v1", engineRevision: SEARCH_ENGINE_REVISION, fingerprint,
    stateDigest: await searchFingerprint({ schema: "haneoka-search-resume-state-v1", state: snapshot }), state: snapshot };
}

/** The Worker fingerprint includes native closure inputs. Storage still uses
 * its captured account/server key and discards late replies after scope changes. */
export async function restoreSearchResumeCheckpoint(checkpoint: SearchResumeCheckpoint | undefined,
  fingerprint: string): Promise<SearchResumeState | null> {
  if (!checkpoint || checkpoint.schema !== "haneoka-search-resume-v1" ||
    checkpoint.engineRevision !== SEARCH_ENGINE_REVISION || checkpoint.fingerprint !== fingerprint ||
    !valid(checkpoint.state, fingerprint)) return null;
  try {
    if (await searchFingerprint({ schema: "haneoka-search-resume-state-v1", state: checkpoint.state }) !== checkpoint.stateDigest)
      return null;
    return structuredClone(checkpoint.state);
  } catch { return null; }
}
