// Fixed item schema versions required by the Sonolus custom server protocol.
// https://wiki.sonolus.com/custom-server-specs/misc/level-item
export const SONOLUS_ITEM_VERSIONS = {
  playlist: 1,
  level: 1,
  skin: 5,
  background: 2,
  effect: 5,
  particle: 4,
  engine: 14,
} as const;

export type SonolusItemType = keyof typeof SONOLUS_ITEM_VERSIONS;
