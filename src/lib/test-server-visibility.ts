import { spoilerContentEnabled } from "./spoiler-content";

/** The Worker supplies current site policy before any catalogue element hydrates. */
export function showTestServerContent(): boolean {
  return spoilerContentEnabled() && (typeof document === "undefined" || document.documentElement.dataset.showTestServerContent !== "0");
}

export const isTestContentServer = (server: string) => server.includes("-test");
export function visibleContentServers<T extends string>(servers: readonly T[]): T[] {
  return servers.filter((server) => showTestServerContent() || !isTestContentServer(server));
}
