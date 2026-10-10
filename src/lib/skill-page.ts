/** The public page identity of a skill: its family and in-family id. */
export const skillPageId = (entry: { family: string; id: string }) => `${entry.family}-${entry.id}`;
