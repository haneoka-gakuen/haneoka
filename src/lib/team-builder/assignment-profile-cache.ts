import type { ResolvedSlotProfile, TeamAssignment } from "./contracts.ts";
import type { PreparedSong } from "./song-metrics.ts";
import type { EvaluationRequest } from "./solver/evaluation.ts";
import type { SearchEvaluationControls } from "./optimizer.ts";

type Profiles = (ResolvedSlotProfile | undefined)[];

/** One last exact preparation per immutable resolver generation. This removes
 * the immediate score→metric duplicate slot calculation without retaining a
 * broad formation matrix. Array/slot/leader order stays exact, and cloned
 * results protect the stored preparation from caller mutation. No score, bound
 * or proof is cached here; new native data/player/scenario creates a new wrapper.
 */
export function reuseAssignmentProfiles(
  resolve: (assignment: TeamAssignment, song: PreparedSong) => Profiles,
  /** The resolver must be created from this immutable request snapshot. */
  context: Readonly<EvaluationRequest>,
) {
  // Full source/server/data, practice/player/equipment candidates, event,
  // objectives/basis/domain and constraints belong to this factory generation.
  // A wrapper belongs to this complete immutable request object. Recreate it
  // with the native factory for any auth/data/practice/scenario generation.
  // Object identity avoids serializing the entire catalogue at every formation.
  let last: { song: PreparedSong; key: string; context: Readonly<EvaluationRequest>; profiles: Profiles } | null = null;
  let interrupted: (() => boolean) | undefined;
  let calls = 0, hits = 0;
  return {
    resolve(assignment: TeamAssignment, song: PreparedSong, controls?: SearchEvaluationControls): Profiles {
      if (controls) interrupted = () => controls.cancelled() || controls.expired();
      if (interrupted?.()) last = null;
      const key = JSON.stringify(assignment);
      if (!interrupted?.() && last?.song === song && last.key === key && last.context === context) {
        hits++;
        return structuredClone(last.profiles);
      }
      calls++;
      const profiles = resolve(assignment, song);
      const complete = profiles.length === assignment.memberInstanceIds.length &&
        profiles.every(profile => profile !== undefined && profile.gaps.length === 0 && Number.isFinite(profile.power));
      last = complete && !interrupted?.() ? { song, key, context, profiles: structuredClone(profiles) } : null;
      return profiles;
    },
    clear() { last = null; interrupted = undefined; },
    stats() { return { preparations: calls, hits, entries: last ? 1 : 0 }; },
  };
}
