/** Public resource sources exposed by the website and APIs. */
export const PUBLIC_RELEASE_SERVERS = ["jp", "intl"] as const;
export type PublicReleaseServer = (typeof PUBLIC_RELEASE_SERVERS)[number];
export const isPublicReleaseServer = (value: unknown): value is PublicReleaseServer =>
  value === "jp" || value === "intl";
export const isPlayerProfilePagePath = (pathname: string): boolean =>
  /^\/(?:(?:(?:jp|intl)\/)?(?:ja|en|ko|zh-CN|zh-TW)\/)?player-profile(?:\/|\.html$|$)/u.test(pathname);
export const isTemporarilyHiddenRoute = (route: string): boolean =>
  route === "/catalog/anon-tokyo" || route.startsWith("/catalog/anon-tokyo/") || isPlayerProfilePagePath(route);
