// L3 — GEB
// Input: Private Global client configuration and an authenticated Container account result.
// Output: Account-bound SDK/game phases and validated private identity/session results.
// Pos: [Map](L2.md); login transport beside the encrypted platform vault.
// Effects/Dependencies: Pure parsing; no network, logs or persistence.
import { OFFICIAL_API_ORIGINS } from "../src/lib/official-ranking";
import type { PlatformLoginResult, PlatformRegion, PlatformSdkSession } from "./official-platform-accounts";

type Document = Record<string, unknown>;
export class AccountJobContractError extends Error {}
const document = (value: unknown): Document => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountJobContractError("invalid_login_document");
  return value as Document;
};
const header = (value: unknown): value is string => typeof value === "string" && /^[\x20-\x7e]{1,4096}$/u.test(value);
const stringMap = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === "string");

export interface GlobalLoginConfiguration {
  sdkProfile: { origin: string; app_key: string; common_params: Record<string, string>; email_country_id?: number; one_sdk_version?: string };
  playerProfile: { client_version: string; device_model: string; operating_system: string; device_id: string;
    client_package: string; global_channel_id: number; brand_id: number; area_id: number; initial_data_group: string };
  masterConfig: Document;
  apiOrigin: string;
}

export function globalLoginConfiguration(raw: string | undefined, accountId: string, region: PlatformRegion): GlobalLoginConfiguration {
  if (!raw || new TextEncoder().encode(raw).length > 65_536) throw new Error("global_login_not_configured");
  const config = document(JSON.parse(raw)), sdk = document(config.sdkProfile), player = document(config.playerProfile);
  const common = sdk.common_params;
  const required = ["game_id", "server_id", "merchant_id", "app_ver", "sdk_ver", "channel_id", "platform", "platform_type"];
  const commonKeys = [...required, "net", "operators", "model", "pf_ver", "dp", "adid", "lang", "sdk_log_type", "ad_ext", "time_zone", "isRoot", "web_code"];
  if (!stringMap(common) || required.some((key) => !common[key]) || Object.keys(common).some((key) => !commonKeys.includes(key))
    || !["https://l11-sdk-login-intl.biligame.net", "https://l12-sdk-login-intl.biligame.net", "https://l13-sdk-login-intl.biligame.net"].includes(String(sdk.origin))
    || typeof sdk.app_key !== "string" || !sdk.app_key || !header(player.client_version) || !/^\d+\.\d+\.\d+$/u.test(player.client_version)
    || common.app_ver !== player.client_version
    || [player.device_model, player.operating_system, player.client_package].some((value) => typeof value !== "string" || !value || value.length > 256)
    || [player.global_channel_id, player.brand_id, player.area_id].some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    || player.initial_data_group !== undefined && (typeof player.initial_data_group !== "string" || player.initial_data_group.length > 256)
    || sdk.email_country_id !== undefined && (typeof sdk.email_country_id !== "number" || !Number.isInteger(sdk.email_country_id) || sdk.email_country_id < 0)
    || sdk.one_sdk_version !== undefined && !header(sdk.one_sdk_version))
    throw new Error("invalid_global_login_configuration");
  const masterConfig = document(document(config.masterConfigs)[region]);
  if (!Object.keys(masterConfig).length) throw new Error("invalid_global_login_configuration");
  const apiOrigin = config.apiOrigins === undefined ? OFFICIAL_API_ORIGINS[region][0]! : document(config.apiOrigins)[region];
  if (typeof apiOrigin !== "string" || !OFFICIAL_API_ORIGINS[region].includes(apiOrigin)) throw new Error("invalid_global_login_configuration");
  return { sdkProfile: { origin: sdk.origin as string, app_key: sdk.app_key,
    common_params: { ...common, udid: accountId },
    ...(sdk.one_sdk_version === undefined ? {} : { one_sdk_version: sdk.one_sdk_version as string }),
    ...(sdk.email_country_id === undefined ? {} : { email_country_id: sdk.email_country_id as number }) },
  playerProfile: { client_version: player.client_version, device_model: player.device_model as string,
    operating_system: player.operating_system as string, client_package: player.client_package as string,
    device_id: accountId, global_channel_id: player.global_channel_id as number, brand_id: player.brand_id as number,
    area_id: player.area_id as number, initial_data_group: player.initial_data_group as string | undefined ?? "" }, masterConfig, apiOrigin };
}

function resultSdkSession(value: unknown, expectedSdkUid: string | null): PlatformSdkSession | null | undefined {
  if (value === undefined || value === null) return value;
  const session = document(value);
  if (!header(session.uid) || typeof session.access_key !== "string" || !session.access_key
    || typeof session.id_token !== "string" || session.mid !== null && typeof session.mid !== "string")
    throw new AccountJobContractError("invalid_sdk_session");
  if (expectedSdkUid !== null && session.uid !== expectedSdkUid) throw new AccountJobContractError("sdk_identity_mismatch");
  return { uid: session.uid, access_key: session.access_key, id_token: session.id_token, mid: session.mid };
}

export type PlatformSdkResult = { status: "sdk_ready"; sdkSession: PlatformSdkSession }
  | Exclude<PlatformLoginResult, { status: "ready" | "needs_initialization" }>;

export function platformSdkResult(value: unknown, runId: string, region: PlatformRegion, config: GlobalLoginConfiguration, expectedSdkUid: string | null): PlatformSdkResult {
  const result = document(value);
  if (result.status !== "sdk_ready") {
    const failure = platformLoginResult(value, runId, region, config, expectedSdkUid, "sdk");
    if (failure.status === "ready" || failure.status === "needs_initialization") throw new AccountJobContractError("invalid_sdk_result");
    if (failure.sdkSession) throw new AccountJobContractError("invalid_sdk_result");
    return failure;
  }
  if (result.contract !== "haneoka:official-account-result/1" || result.action !== "sdk" || result.runId !== runId || result.region !== region)
    throw new AccountJobContractError("account_result_mismatch");
  const session = resultSdkSession(result.sdkSession, expectedSdkUid);
  if (!session) throw new AccountJobContractError("invalid_sdk_result");
  return { status: "sdk_ready", sdkSession: session };
}

export function platformLoginResult(value: unknown, runId: string, region: PlatformRegion, config: GlobalLoginConfiguration, expectedSdkUid: string | null = null, action: "sdk" | "game" = "game"): PlatformLoginResult {
  const result = document(value);
  if (result.contract !== "haneoka:official-account-result/1" || result.action !== action || result.runId !== runId || result.region !== region)
    throw new AccountJobContractError("account_result_mismatch");
  if (action === "game" && result.sdkSession !== undefined) throw new AccountJobContractError("unexpected_game_sdk_session");
  const sdk: { sdkSession?: PlatformSdkSession | null } = {};
  const session = resultSdkSession(result.sdkSession, expectedSdkUid);
  if (session !== undefined) sdk.sdkSession = session;
  if (result.status === "ready") {
    const auth = document(result.credentials);
    if (expectedSdkUid !== null && auth.bid !== expectedSdkUid) throw new AccountJobContractError("sdk_identity_mismatch");
    if (!header(result.playerId) || auth.player_id !== result.playerId || !header(auth.credential) || !header(auth.bid)
      || typeof auth.device_id !== "string" || !/^[\x20-\x7e]{0,4096}$/u.test(auth.device_id)
      || sdk.sdkSession === null || sdk.sdkSession !== undefined && sdk.sdkSession.uid !== auth.bid) throw new AccountJobContractError("invalid_account_result");
    return { ...sdk, status: "ready", playerId: result.playerId, configuration: { clientVersion: config.playerProfile.client_version,
      credentials: { region: region === "tw" ? "hk" : region, origin: config.apiOrigin,
        credentials: { player_id: result.playerId, credential: auth.credential, device_id: auth.device_id, bid: auth.bid } }, masterConfig: config.masterConfig } };
  }
  if (result.status === "needs_initialization" && header(result.playerId)) return { ...sdk, status: result.status, playerId: result.playerId };
  if (["auth_required", "auth_uncertain", "failed"].includes(String(result.status)) && typeof result.errorCode === "string"
    && /^[a-z][a-z0-9_]{0,63}(?::-?[0-9]{1,12})?$/u.test(result.errorCode)
    && (result.playerId === undefined || header(result.playerId)))
    return { ...sdk, status: result.status as "auth_required" | "auth_uncertain" | "failed", errorCode: result.errorCode,
      ...(result.playerId === undefined ? {} : { playerId: result.playerId as string }) };
  throw new AccountJobContractError("invalid_account_result");
}
