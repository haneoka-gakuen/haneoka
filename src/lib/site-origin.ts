// L3 — GEB
// Input: 请求或浏览器 URL，以及站内资源和链接地址。
// Output: 双域名白名单、当前站点源和保持当前入口的地址。
// Pos: [Map](L2-2.md)；Worker、认证和浏览器共用的站点域名契约。
// Effects/Dependencies: 浏览器调用默认读取 location；其他调用显式传入 URL 或源。
export const CANONICAL_ORIGIN = "https://haneoka.org";
export const SITE_HOSTNAMES = ["haneoka.org", "haneoka.com"] as const;

export const isSiteHostname = (hostname: string): boolean => SITE_HOSTNAMES.some((host) => host === hostname);

export const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export const isSiteOrigin = (origin: string): boolean => SITE_HOSTNAMES.some((host) => origin === `https://${host}`);

export function siteOrigin(url?: URL): string {
  const browser = globalThis as { window?: unknown; location?: { href: string } };
  const current =
    url ?? (browser.window === globalThis && browser.location ? new URL(browser.location.href) : undefined);
  if (current && isSiteHostname(current.hostname)) return `https://${current.hostname}`;
  return current && isLocalHostname(current.hostname) ? current.origin : CANONICAL_ORIGIN;
}

export function siteAssetUrl(value: string, origin = siteOrigin()): string {
  const url = new URL(value, origin);
  return isSiteOrigin(url.origin) ? new URL(`${url.pathname}${url.search}${url.hash}`, origin).href : url.href;
}

export function siteLink(value: string, origin = siteOrigin()): string {
  if (!/^(?:https?:)?\/\//u.test(value)) return value;
  const url = new URL(value, origin);
  if (isSiteOrigin(url.origin)) return `${url.pathname}${url.search}${url.hash}`;
  if (url.origin === "https://open.sonolus.com") {
    const [address, ...path] = url.pathname.slice(1).split("/");
    if (address && isSiteHostname(address))
      return `https://open.sonolus.com/${new URL(origin).host}${path.length ? `/${path.join("/")}` : ""}${url.search}${url.hash}`;
  }
  return value;
}
