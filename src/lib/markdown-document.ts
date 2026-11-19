// L3 — GEB
// Input: Canonical public page addresses.
// Output: Markdown addresses and the static shard containing an entity.
// Pos: [Map](L2-2.md); build and request routing for public Markdown.
// Effects/Dependencies: Pure path mapping shared by the build and Worker.
import { fnv1a32Shard } from "./hash-partition.ts";

const ENTITY = /^\/(jp|intl)\/(en|ja|ko|zh-CN|zh-TW)\/([a-z][a-z0-9-]*)\/[^/]+(?:\/chart)?\.md$/u;

export function markdownPath(pathname: string): string {
  return /^\/(?:(?:jp|intl)\/)?(?:en|ja|ko|zh-CN|zh-TW)\/$/u.test(pathname) || pathname === "/"
    ? `${pathname}index.md`
    : `${pathname.replace(/\/+$/u, "")}.md`;
}

export function markdownShardPath(pathname: string): string | undefined {
  const route = ENTITY.exec(pathname);
  if (!route) return;
  const [, server, locale, kind] = route;
  return `/markdown/${server}/${locale}/${kind}/${fnv1a32Shard(pathname, 64)}.json`;
}
