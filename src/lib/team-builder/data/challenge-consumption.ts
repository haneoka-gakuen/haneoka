import type { EvidenceGap } from "../contracts";
import type { TeamBuilderData } from "../data";
import type { BoostBonusRow } from "../solver/event-rewards";

/** Audited Intl UI selector/Event default, independent of the challenge boot domain. */
const SELECTOR = {
  methodFingerprint: "547e20f689a6c35878a86122b7efddd3d107e27837b494dc2aea117a0102a119",
  abiFingerprint: "798ed3616293df9b933444db069f96924afeaeb4b09864ca2976312709f9a878",
  nativeFiles: {
    il2cpp: "d55c95ae6c4ea7876a6e56d8077de4fbee87db35c596c7fad5e69ca281b792b1",
    metadata: "1cffb3ddfbbd6a0bca5d5f01f03b4f0a3132eb0d2c56a50506beb166526868bf",
    loader: "c7c9d3983c59bcb6cec5fd13515b3c3190ad82a4bd257602beca97dc64aeaf0c",
  },
  selectedPatches: [
    { address: "Patch/App.Runtime.patch-1.0.2", sha256: "7b62b0f44d9d3057a764d761a53caf5a2b9ef3c71ac348b658dd17f3fd6bd68e" },
    { address: "Patch/Mingle.Runtime.patch-1.0.2", sha256: null },
    { address: "EmbPatch/Mingle.Runtime.patch-1.0.2", sha256: null },
  ],
  counts: [200, 400, 800, 1600],
  defaultConsumption: 200,
} as const;

export function resolveChallengeConsumptionChoices(
  identity: TeamBuilderData["identity"],
  rows: readonly BoostBonusRow[],
  availability: { status: string; gaps: readonly EvidenceGap[] },
): { baseConsumption: number | null; selectableCounts: number[] | null; gaps: EvidenceGap[] } {
  const evidence = identity.nativeRuleEvidence;
  const qualified = identity.server === "intl" && !!identity.sourceId &&
    evidence?.schema === "haneoka-native-rule-evidence-v1" && evidence.sourceId === identity.sourceId &&
    evidence.patchSelection === "complete" &&
    Object.entries(SELECTOR.nativeFiles).every(([key, sha]) => evidence.nativeFiles?.[key as keyof typeof SELECTOR.nativeFiles] === sha) &&
    Array.isArray(evidence.selectedPatches) && evidence.selectedPatches.length === SELECTOR.selectedPatches.length &&
    SELECTOR.selectedPatches.every((expected) => evidence.selectedPatches.filter((patch) =>
      patch.address === expected.address && patch.sha256 === expected.sha256).length === 1);
  const fail = (gaps: EvidenceGap[]) => ({ baseConsumption: null, selectableCounts: null, gaps });
  if (!qualified) return fail([{
    code: "native-challenge-consumption-selection-unverified",
    source: `UIChallengePointConsumeSelectionView:${SELECTOR.methodFingerprint}/${SELECTOR.abiFingerprint}`,
  }]);
  if (availability.status !== "ready") return fail([...availability.gaps, {
    code: "native-challenge-consumption-table-unavailable", source: "MasterChallengeMusicBoostBonus",
  }]);
  const gaps: EvidenceGap[] = [];
  for (const count of SELECTOR.counts) {
    const matches = rows.filter((row) => row.consumedCount === count);
    if (matches.length !== 1) gaps.push({
      code: matches.length ? "native-challenge-consumption-row-ambiguous" : "native-challenge-consumption-row-missing",
      source: `MasterChallengeMusicBoostBonus:${count}`,
    });
  }
  if (gaps.length) return fail(gaps);
  return { baseConsumption: SELECTOR.defaultConsumption, selectableCounts: [...SELECTOR.counts], gaps: [] };
}
