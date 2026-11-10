/** Public resource sources exposed by the website and APIs. */
export const PUBLIC_RELEASE_SERVERS = ["jp", "intl"] as const;
export type PublicReleaseServer = (typeof PUBLIC_RELEASE_SERVERS)[number];
export const isPublicReleaseServer = (value: unknown): value is PublicReleaseServer =>
  value === "jp" || value === "intl";
export const isTemporarilyHiddenRoute = (route: string): boolean =>
  route === "/catalog/anon-tokyo" || route.startsWith("/catalog/anon-tokyo/");
