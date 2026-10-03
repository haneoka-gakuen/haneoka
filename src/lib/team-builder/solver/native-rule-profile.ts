import type { EvidenceGap, NativeRuleDomain, NativeRuleEvidence, ReleaseIdentity } from "../contracts.ts";

const fingerprints = {
  "challenge-context": [{
    methodFingerprint: "a29abed8f286a269d902d5430e99bd10cf698c6d6642c562a36e712e115011d5",
    abiFingerprint: "1793aa00193d856dd0db4741cb2b00046eb6900df3dadcfd3676e98458966162",
  }],
  "normal-score": [
    {
      methodFingerprint: "66aed236ebe536279fb414eb0f94974af8377b3734ebc4c500bdf258b9777861",
      abiFingerprint: "8a1652367913d854aa8e077abacb00e35263cfd3b117534cd3dadfe9c426d9ed",
    },
    {
      methodFingerprint: "adc02e9c452f99a45efec967a4afaf2fe70375d7e1a2cad1e730cdcdddbae5d5",
      abiFingerprint: "d59ad6823036d5f0a2bce698d041ae7f2058fb75a986740ae56c8189250f482d",
    },
  ],
  "personal-solo": [
    {
      methodFingerprint: "13682635bf51497893186fdeb0864b47238039e61512fa4a8fb539e22b8f0e16",
      abiFingerprint: "247b50a6bb98a8f6d0e1c2cc6217b4efa6da74946a564dda606406ffb13fe5fd",
    },
    {
      methodFingerprint: "bd5946aa33307e422daf53212d3de3dc51e7ffca68e09e792ec6ceb26a6e87f3",
      abiFingerprint: "247b50a6bb98a8f6d0e1c2cc6217b4efa6da74946a564dda606406ffb13fe5fd",
    },
  ],
  "ordinary-event-points": [
    {
      methodFingerprint: "64499407bb84f00f7d03b81a4016898b4c88855a41e12ee2dbf15bbf76834211",
      abiFingerprint: "ac69d3b15db18292ff41026755b2a9ad9451f6c2b5f76137babb87ba913975b5",
    },
    {
      methodFingerprint: "486af02e7615162f6214e90c1fd390e3fc9de5060c271c35b6aa52e268cb1fca",
      abiFingerprint: "96925f42560eb2a35b9c69abfb443d89c16a00053bce3f0341e05eec44f2072c",
    },
  ],
  "snapshot-equip": [
    {
      methodFingerprint: "ba988aed6d4b90af1946cffb3dd9f07c330294f9adf4c22fa886b1fd480f2934",
      abiFingerprint: "184d29e4541f51dd143870c9d33e4d417fb53ae8f0bfa532bb6bcfd28c3eb535",
    },
    {
      methodFingerprint: "17501df6e4a81c1376107e1182d5a00cc12b71ecf528adb39840e63b302c4295",
      abiFingerprint: "6ff397d5a4d1c3d1be2e572a8714820c8c9e786d6d0ffeabf37981e2607ab112",
    },
  ],
} as const;
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export type NativeRuleIdentity = ReleaseIdentity & { sourceId?: string };

/** Source producer binds the related method/ABI audit and the actually selected
 * patches. Resource release, app version and whole-package hashes select no rule.
 * Each factory continues validating its actual same-release Master inputs.
 */
export function nativeRuleGaps(identity: NativeRuleIdentity, domain: NativeRuleDomain): EvidenceGap[] {
  const fail = (code: string): EvidenceGap[] => [{ code, source: identity.sourceId ?? identity.server }];
  if (identity.server !== "intl") return fail("native-server-rules-unverified");
  const evidence: NativeRuleEvidence | undefined = identity.nativeRuleEvidence;
  if (!evidence || evidence.schema !== "haneoka-native-rule-evidence-v1") return fail("native-rule-evidence-missing");
  if (!identity.sourceId || evidence.sourceId !== identity.sourceId)
    return fail("native-rule-evidence-source-mismatch");
  if (
    !evidence.nativeFiles ||
    !Object.values(evidence.nativeFiles).every(sha256) ||
    !["il2cpp", "metadata", "loader"].every((key) =>
      sha256(evidence.nativeFiles[key as keyof typeof evidence.nativeFiles]),
    )
  )
    return fail("native-rule-file-evidence-unresolved");
  if (
    evidence.patchSelection !== "complete" ||
    !Array.isArray(evidence.selectedPatches) ||
    !evidence.selectedPatches.length ||
    evidence.selectedPatches.some(
      (patch) =>
        !patch ||
        typeof patch.address !== "string" ||
        !patch.address ||
        (patch.sha256 !== null && !sha256(patch.sha256)),
    ) ||
    new Set(evidence.selectedPatches.map((patch) => patch.address)).size !== evidence.selectedPatches.length
  )
    return fail("native-rule-patch-selection-unresolved");
  const rule = evidence.domains?.[domain];
  const expected = domain in fingerprints ? fingerprints[domain as keyof typeof fingerprints] : null;
  if (
    !rule ||
    !expected ||
    rule.profile !== "intl-ap-v1" ||
    !expected.some(
      (pair) => rule.methodFingerprint === pair.methodFingerprint && rule.abiFingerprint === pair.abiFingerprint,
    )
  )
    return fail("native-rule-profile-unverified");
  if (rule.callGraph !== "reviewed" || !["disjoint", "equivalent"].includes(rule.patchCoverage))
    return fail("native-rule-related-coverage-unresolved");
  return [];
}

export const nativeRuleSupports = (identity: NativeRuleIdentity, domain: NativeRuleDomain): boolean =>
  nativeRuleGaps(identity, domain).length === 0;

/** Reuse an audited family for a new resource source after its native files and
 * selected patch programs have been measured. App/package and resource hashes
 * may change; any changed native file or patch program requires a new audit.
 * A null patch hash represents an explicitly checked absent address.
 */
export function bindNativeRuleEvidenceToSource(
  audit: NativeRuleEvidence,
  observed: Pick<NativeRuleEvidence, "sourceId" | "nativeFiles" | "selectedPatches" | "patchSelection">,
): NativeRuleEvidence | null {
  if (!audit || !observed || observed.patchSelection !== "complete" || audit.patchSelection !== "complete") return null;
  if (!audit.nativeFiles || !observed.nativeFiles || typeof observed.sourceId !== "string" || !observed.sourceId)
    return null;
  if (!audit.domains || typeof audit.domains !== "object") return null;
  if (
    !Object.values(audit.nativeFiles).every(sha256) ||
    !["il2cpp", "metadata", "loader"].every(
      (key) =>
        sha256(audit.nativeFiles[key as keyof typeof audit.nativeFiles]) &&
        observed.nativeFiles[key as keyof typeof observed.nativeFiles] ===
          audit.nativeFiles[key as keyof typeof audit.nativeFiles],
    )
  )
    return null;
  const patchPrograms = (patches: NativeRuleEvidence["selectedPatches"]): string | null => {
    if (!Array.isArray(patches) || !patches.length) return null;
    const programs = patches.map((patch) => {
      const assembly = /^(?:Emb)?Patch\/(.+)\.patch-\d+(?:\.\d+)*$/u.exec(patch?.address ?? "");
      return assembly && (patch.sha256 === null || sha256(patch.sha256))
        ? `${patch.address.startsWith("Emb") ? "Emb:" : ""}${assembly[1]}:${patch.sha256 ?? "absent"}`
        : null;
    });
    if (programs.some((value) => value === null) || new Set(programs).size !== programs.length) return null;
    return (programs as string[]).sort().join("\n");
  };
  const expected = patchPrograms(audit.selectedPatches);
  if (!expected || expected !== patchPrograms(observed.selectedPatches)) return null;
  const evidence: NativeRuleEvidence = {
    ...audit,
    ...observed,
    nativeFiles: { ...observed.nativeFiles },
    selectedPatches: observed.selectedPatches.map((patch) => ({ ...patch })),
    domains: Object.fromEntries(Object.entries(audit.domains).map(([domain, rule]) => [domain, { ...rule }])),
  };
  const identity = {
    server: "intl",
    releaseId: "source-audit",
    sourceId: observed.sourceId,
    nativeRuleEvidence: evidence,
  };
  return Object.keys(evidence.domains).length &&
    Object.keys(evidence.domains).every((domain) => nativeRuleSupports(identity, domain as NativeRuleDomain))
    ? evidence
    : null;
}
