// L3 — GEB
// Input: Private JP client configuration and authenticated Container phase responses.
// Output: Identity-bound guest job configuration and validated creation/verification results.
// Pos: [Map](L2.md); private job contract before encrypted guest persistence.
// Effects/Dependencies: Pure parsing; no network, persistence or credentials in errors.
import { OFFICIAL_API_ORIGINS } from "../src/lib/official-ranking";
import type { GuestLease } from "./official-guest-accounts";

type Document = Record<string, unknown>;
export class GuestJobContractError extends Error {}
const document = (value: unknown): Document => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuestJobContractError("invalid_guest_document");
  return value as Document;
};
const header = (value: unknown): value is string => typeof value === "string" && /^[\x20-\x7e]{1,4096}$/u.test(value);
const optionalHeader = (value: unknown): value is string => typeof value === "string" && /^[\x20-\x7e]{0,4096}$/u.test(value);

export interface GuestConfiguration {
  guestProfile: { client_version: string; device_id: string; initial_data_group: string };
  apiOrigin: string;
  masterConfig: Document;
}

export function guestConfiguration(raw: string | undefined): GuestConfiguration {
  if (!raw) throw new GuestJobContractError("guest_not_configured");
  const config = document(JSON.parse(raw));
  const masterConfig = document(config.masterConfig);
  const apiOrigin = config.apiOrigin ?? OFFICIAL_API_ORIGINS.jp[0]!;
  if (!header(config.clientVersion) || config.deviceId !== undefined && !optionalHeader(config.deviceId)
    || config.initialDataGroup !== undefined && typeof config.initialDataGroup !== "string"
    || !Object.keys(masterConfig).length || typeof apiOrigin !== "string" || !OFFICIAL_API_ORIGINS.jp.includes(apiOrigin))
    throw new GuestJobContractError("invalid_guest_configuration");
  return { guestProfile: { client_version: config.clientVersion, device_id: config.deviceId as string | undefined ?? "",
    initial_data_group: config.initialDataGroup as string | undefined ?? "" }, apiOrigin, masterConfig };
}

export type GuestPhaseResult =
  | { action: "register"; status: "created"; playerId: string; profileId: string; configuration: Document }
  | { action: "register"; status: "failed" | "uncertain"; errorCode: string }
  | { action: "verify"; status: "ready"; playerId: string }
  | { action: "verify"; status: "created"; playerId: string; errorCode: string };

export function guestPhaseResult(value: unknown, action: "register" | "verify", lease: GuestLease,
  config: GuestConfiguration, expectedPlayerId?: string): GuestPhaseResult {
  const result = document(value);
  if (result.contract !== "haneoka:official-guest-result/1" || result.action !== action || result.region !== "jp"
    || result.runId !== lease.runId || result.guestId !== lease.guestId)
    throw new GuestJobContractError("guest_result_mismatch");
  if (action === "register" && result.status === "created") {
    const credentials = document(result.credentials);
    if (!header(result.playerId) || credentials.player_id !== result.playerId || !header(credentials.credential)
      || !optionalHeader(credentials.device_id) || typeof result.profileId !== "string" || !/^-?\d{1,19}$/u.test(result.profileId)
      || BigInt(result.profileId) < -(1n << 63n) || BigInt(result.profileId) >= 1n << 63n)
      throw new GuestJobContractError("invalid_guest_result");
    return { action, status: "created", playerId: result.playerId, profileId: result.profileId,
      configuration: { clientVersion: config.guestProfile.client_version, credentials: { region: "jp", origin: config.apiOrigin,
        credentials: { player_id: result.playerId, credential: credentials.credential, device_id: credentials.device_id } }, masterConfig: config.masterConfig } };
  }
  if (action === "verify") {
    if (!header(expectedPlayerId) || result.playerId !== undefined && result.playerId !== expectedPlayerId)
      throw new GuestJobContractError("guest_identity_mismatch");
    if (result.status === "ready" && result.playerId === expectedPlayerId) return { action, status: "ready", playerId: expectedPlayerId };
    if (result.status === "created" && typeof result.errorCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(result.errorCode))
      return { action, status: "created", playerId: expectedPlayerId, errorCode: result.errorCode };
  } else if ((result.status === "failed" || result.status === "uncertain")
    && typeof result.errorCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(result.errorCode))
    return { action, status: result.status, errorCode: result.errorCode };
  throw new GuestJobContractError("invalid_guest_result");
}
