import { nativeRuleSupports, type NativeRuleIdentity } from "./native-rule-profile.ts";

/** Audited native driver and current RangePlaying dialect. Resource releases
 * reuse it only with the measured native files and selected patch programs. */
export function nativeGekisoAllComboDriverSupports(identity: NativeRuleIdentity): boolean {
  if (!nativeRuleSupports(identity, "normal-score") || !nativeRuleSupports(identity, "personal-solo")) return false;
  const evidence = identity.nativeRuleEvidence!;
  if (evidence.nativeFiles.il2cpp !== "d55c95ae6c4ea7876a6e56d8077de4fbee87db35c596c7fad5e69ca281b792b1" ||
    evidence.nativeFiles.metadata !== "1cffb3ddfbbd6a0bca5d5f01f03b4f0a3132eb0d2c56a50506beb166526868bf" ||
    evidence.nativeFiles.loader !== "c7c9d3983c59bcb6cec5fd13515b3c3190ad82a4bd257602beca97dc64aeaf0c") return false;
  const programs = evidence.selectedPatches.map((patch) => {
    const assembly = /^(Emb)?Patch\/(.+)\.patch-\d+(?:\.\d+)*$/u.exec(patch.address);
    return assembly ? `${assembly[1] ?? ""}:${assembly[2]}:${patch.sha256 ?? "absent"}` : null;
  }).sort();
  return programs.length === 3 && programs[0] === ":App.Runtime:7b62b0f44d9d3057a764d761a53caf5a2b9ef3c71ac348b658dd17f3fd6bd68e" &&
    programs[1] === ":Mingle.Runtime:absent" && programs[2] === "Emb:Mingle.Runtime:absent";
}

export const NATIVE_GEKISO_ALL_COMBO_CONDITIONS = [
  "native-gekiso-no-luck-or-single-luck-perfect-missions", "native-gekiso-uninterrupted-perfect-playback",
  "native-gekiso-disjoint-chart-ranges", "native-gekiso-basic-integer-member-effects",
  "native-luck-note-charge-below-both-gauge-maxima",
  "native-gekiso-personal-single-player-rank", "native-all-combo-ap-event-reduction",
] as const;
