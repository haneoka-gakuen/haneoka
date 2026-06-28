import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pagesRoot = path.join(root, "app", "pages");
const outputPublicRoot = path.join(root, ".output", "public");
const canonicalOrigin = "https://haneoka.org";

// These pages are private, user-specific, or editing workflows. They should
// not be presented to search engines as public landing pages.
const excludedPathPrefixes = ["/account", "/admin", "/community", "/settings", "/tools"];

const walkPages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkPages(entryPath);
      return entry.isFile() && entry.name.endsWith(".vue") ? [entryPath] : [];
    }),
  );
  return files.flat();
};

const routeForPage = (file: string): string | null => {
  const segments = path
    .relative(pagesRoot, file)
    .replace(/\\/g, "/")
    .replace(/\.vue$/, "")
    .split("/");
  if (segments.some((segment) => segment.includes("["))) return null;
  if (segments.at(-1) === "index") segments.pop();
  const route = `/${segments.join("/")}`.replace(/\/$/, "") || "/";
  return excludedPathPrefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)) ? null : route;
};

const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const routes = (await walkPages(pagesRoot))
  .map(routeForPage)
  .filter((route): route is string => route !== null)
  .sort((left, right) => left.localeCompare(right));

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((route) => `  <url><loc>${escapeXml(`${canonicalOrigin}${route}`)}</loc></url>`),
  "</urlset>",
  "",
].join("\n");

await mkdir(outputPublicRoot, { recursive: true });
await writeFile(path.join(outputPublicRoot, "sitemap.xml"), sitemap, "utf8");
await writeFile(
  path.join(outputPublicRoot, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: ${canonicalOrigin}/sitemap.xml\n`,
  "utf8",
);

console.log(`[sitemap] generated ${routes.length} public URLs`);
