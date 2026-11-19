/** The public page identity of a skill: its family and in-family id. */
export const skillPageId = (entry: { family: string; id: string }) => `${entry.family}-${entry.id}`;

export const SKILL_FAMILY_RESOURCES = {
  leader: "leader-skills",
  live: "skills",
  gekisou: "gekisou-skills",
  support: "support-skills",
  gekisouSupport: "gekisou-support-skills",
} as const;
