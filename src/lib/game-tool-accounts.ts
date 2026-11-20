// L3 — GEB
// Input: Manual account drafts and identity metadata from device saves.
// Output: Private game-account identities and the existing recruitment key.
// Pos: [Map](L2-2.md); shared account contract for the three game tools.
// Effects/Dependencies: Hashes identifiers without including game credentials.
import { profileRegion } from "./game-records";
import { isPublicReleaseServer, type PublicReleaseServer } from "./temporary-public-routing";

export type GameTool = "team" | "songs" | "history";
export const isGameTool = (value: unknown): value is GameTool => value === "team" || value === "songs" || value === "history";
export interface GameToolAccount {
  id: string;
  tool: GameTool;
  server: PublicReleaseServer;
  name: string;
  uid?: string;
  rank?: number;
  favoriteCardId?: number;
  savedAt?: number;
  historyKeys: string[];
  settings?: GameToolAccountSettings;
}
export interface GameToolAccountSettings {
  alias: string;
  position: number;
  removed: boolean;
  changedAt: number;
}
export function isGameToolAccountSettings(value: unknown): value is GameToolAccountSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { alias, position, removed, changedAt } = value as Partial<GameToolAccountSettings>;
  return typeof alias === "string" && [...alias].length <= 80 && !/[\p{Cc}\p{Cs}]/u.test(alias) &&
    typeof position === "number" && Number.isFinite(position) && Math.abs(position) <= 1_000_000 &&
    typeof removed === "boolean" && typeof changedAt === "number" && Number.isSafeInteger(changedAt) && changedAt >= 0;
}

export const isGameToolAccountId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
export const isGameHistoryKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function legacyToolAccount(server: PublicReleaseServer, tool: GameTool): GameToolAccount {
  return { id: `legacy-${server}`, tool, server, name: "", historyKeys: [] };
}

export async function hashGameToolKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const gameToolIdFromSave = async (tool: GameTool, server: PublicReleaseServer, uid: string) =>
  (await hashGameToolKey(`haneoka-game-tool-account-v1:${tool}:${server}:${uid}`)).slice(0, 32);

export function gameToolHistoryServer(account: GameToolAccount) {
  const region = account.uid && profileRegion(account.uid);
  return region ? { jp: "jp", tw: "global-hmt", en: "global-en", kr: "global-kr" }[region] : undefined;
}
export async function historyKeyFromGameToolAccount(account: GameToolAccount): Promise<string | undefined> {
  const historyServer = gameToolHistoryServer(account);
  if (!historyServer) return;
  const key = await hashGameToolKey(`${account.server}:${account.uid}`);
  return hashGameToolKey(`${historyServer}:${key}-${historyServer}`);
}

export function isGameToolAccount(value: unknown): value is GameToolAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { id, tool, server, name, uid, rank, favoriteCardId, savedAt, historyKeys, settings } = value as Partial<GameToolAccount>;
  const region = typeof uid === "string" ? profileRegion(uid) : undefined;
  return isGameToolAccountId(id) && isGameTool(tool) && isPublicReleaseServer(server) &&
    typeof name === "string" && [...name].length <= 80 && !/[\p{Cc}\p{Cs}]/u.test(name) &&
    (uid === undefined || typeof uid === "string" && !!region && (region === "jp") === (server === "jp")) &&
    (rank === undefined || Number.isSafeInteger(rank) && rank >= 0 && rank <= 99_999_999) &&
    (favoriteCardId === undefined || Number.isSafeInteger(favoriteCardId) && favoriteCardId > 0 && favoriteCardId <= 2_147_483_647) &&
    (savedAt === undefined || Number.isSafeInteger(savedAt) && savedAt >= 0 && savedAt <= 8_640_000_000_000_000) &&
    Array.isArray(historyKeys) && historyKeys.length <= 64 && historyKeys.every(isGameHistoryKey) &&
    (settings === undefined || isGameToolAccountSettings(settings));
}
