import type { TeamBuilderData } from "../data";

/** Assets keep the immutable release of the row selected during the union. */
export function teamBuilderSourceIdentity(data: TeamBuilderData, collection: string, id: number): TeamBuilderData["identity"] {
  const server = data.crossServer?.owners[collection]?.[String(id)];
  return (server && data.crossServer?.identities[server]) || data.identity;
}
