export const RELEASE_SERVERS = ["intl", "jp-cbt", "intl-cbt"] as const;
export type ReleaseServer = (typeof RELEASE_SERVERS)[number];
const KEY = "haneoka.release-server";

export function normalizeReleaseServer(value: unknown): ReleaseServer {
  const current = value === "gl-cbt" ? "intl-cbt" : value;
  return RELEASE_SERVERS.includes(current as ReleaseServer) ? (current as ReleaseServer) : "intl";
}

export function readReleaseServer(): ReleaseServer {
  try {
    const stored = localStorage.getItem(KEY);
    const current = normalizeReleaseServer(stored);
    if (stored === "gl-cbt") localStorage.setItem(KEY, current);
    return current;
  } catch {
    return "intl";
  }
}

export function writeReleaseServer(value: unknown): ReleaseServer {
  const server = normalizeReleaseServer(value);
  try {
    localStorage.setItem(KEY, server);
  } catch {}
  return server;
}
