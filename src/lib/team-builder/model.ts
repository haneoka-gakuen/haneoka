// L3 — GEB
// Input: 配队模型的来源身份、规则证据与属性。
// Output: ReleaseIdentity、EvidenceGap 等共享领域契约。
// Pos: [Map](L2-2.md)；配队数据与求解接口的基础类型。
// Effects/Dependencies: 以类型和模型声明为主；运行和持久化由消费者承担。
/** Serializable inputs shared by the inventory adapter, solver worker and UI. */
export interface ReleaseIdentity {
  server: string;
  releaseId: string;
  /** Source producer's related-method/ABI/selected-patch audit, independent of resource release. */
  nativeRuleEvidence?: NativeRuleEvidence;
}

export type NativeRuleDomain =
  "normal-score" | "personal-solo" | "ordinary-event-points" | "snapshot-equip" | "challenge-context";

export interface NativeRuleEvidence {
  schema: "haneoka-native-rule-evidence-v1";
  sourceId: string;
  /** Hashes identify the audited rule inputs; package version is provenance, not the rule selector. */
  nativeFiles: { il2cpp: string; metadata: string; loader: string };
  selectedPatches: { address: string; sha256: string | null }[];
  patchSelection: "complete" | "unresolved";
  domains: Partial<
    Record<
      NativeRuleDomain,
      {
        profile: string;
        methodFingerprint: string;
        abiFingerprint: string;
        callGraph: "reviewed" | "unresolved";
        patchCoverage: "disjoint" | "equivalent" | "unresolved";
      }
    >
  >;
}

export interface EvidenceGap {
  code: string;
  source: string;
}

export interface PowerStats {
  performance: number;
  technique: number;
  visual: number;
}

export interface TeamAssignment {
  memberInstanceIds: string[];
  /** Each index equips the corresponding member; null is an empty slot. */
  snapshotInstanceIds: (string | null)[];
  leaderInstanceId: string;
}
