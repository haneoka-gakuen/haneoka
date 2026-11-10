// L3 — GEB
// Input: Persisted skill-role limits for members and Snapshots.
// Output: Normalized optional role bounds sent to the native search.
// Pos: [Map](L2-2.md); pair-aware skill quantity constraints.
// Effects/Dependencies: Pure data conversion; no scoring or persistence.
export const SKILL_ROLES = ["count", "window", "conversion", "score"] as const;
export type SkillRole = (typeof SKILL_ROLES)[number];
export type SkillRoleLimits = Record<"member" | "snap", Record<SkillRole, [number, number]>>;
export const skillRoleDefaults = (): SkillRoleLimits => ({
  member: { count: [0, 5], window: [0, 5], conversion: [0, 5], score: [0, 5] },
  snap: { count: [0, 5], window: [0, 5], conversion: [0, 5], score: [0, 5] },
});
export const hasSkillRoleLimits = (limits: SkillRoleLimits) =>
  Object.values(limits).some((group) => Object.values(group).some(([min, max]) => min > 0 || max < 5));

export function readSkillRoleLimits(value: unknown): SkillRoleLimits {
  const limits = skillRoleDefaults();
  if (!value || typeof value !== "object") return limits;
  const stored = value as Partial<SkillRoleLimits>;
  for (const kind of ["member", "snap"] as const) for (const role of SKILL_ROLES) {
    const range = stored[kind]?.[role];
    if (Array.isArray(range) && range.length === 2 && range.every(value => Number.isInteger(value) && value >= 0 && value <= 5) && range[0] <= range[1]) limits[kind][role] = [...range];
  }
  return limits;
}
