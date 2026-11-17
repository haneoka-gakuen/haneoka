// L3 — GEB
// Input: Native game-history failures and shared localized reading instructions.
// Output: Known error labels and the guide's message keys for history and save pages.
// Pos: [Map](L2-2.md); game-session guidance without exposing or renewing credentials.
// Effects/Dependencies: Pure labels; no game, account or network requests.
export const HISTORY_HELP_KEYS = [
  "readHelp",
  "readHelpTitle",
  "readHelpSummary",
  "readHelpPrivacy",
  "readHelpCredentials",
  "readHelpStep1",
  "readHelpStep2",
  "readHelpStep3",
  "readHelpOther",
] as const;
export type HistoryHelpKey = (typeof HISTORY_HELP_KEYS)[number] | "close";
export function gameHistoryErrorKey(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return (
    (
      {
        history_missing_session: "errorMissingSession",
        history_session_expired: "errorSessionExpired",
        history_network_error: "errorNetwork",
        history_service_unavailable: "errorServiceUnavailable",
        history_version_unavailable: "errorVersionUnavailable",
        history_response_invalid: "errorResponseInvalid",
      } as Record<string, string>
    )[code] ?? "errorGameReadFailed"
  );
}
