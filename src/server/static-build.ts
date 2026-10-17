import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isLocale } from "@haneoka/i18n";
import { staticDocumentLookupPath } from "../lib/static-documents.ts";

/** Build complete page families independently without blocking other releases. */
export function staticPageGroupEnabled(group: "provider" | "assets"): boolean {
  const groups = (process.env.STATIC_PAGE_GROUPS || "all").split(",").map((value) => value.trim());
  if (groups.some((value) => !["all", "core", "provider", "assets"].includes(value)))
    throw new Error("STATIC_PAGE_GROUPS must contain core, provider, assets, or all");
  return groups.includes("all") || groups.includes(group);
}

interface StaticBuildPath {
  params: Record<string, string | number | undefined>;
  props?: Record<string, unknown>;
}

/** Matches Astro's parameter normalization before its directory-format output. */
function physicalPath(sourcePattern: string, params: StaticBuildPath["params"]): string {
  const endpoint = sourcePattern.endsWith(".json.ts");
  const route = sourcePattern.replace(/^src\/pages\//u, "")
    .replace(/\.(?:astro|ts)$/u, "")
    .replace(/(?:^|\/)index$/u, "")
    .split("/")
    .map((segment) => segment.replace(/\[(\.\.\.)?([\w$]+)\]/gu, (_, spread, key: string) => {
      const value = params[key];
      if (value === undefined) {
        if (spread) return "";
        throw new Error(`Missing static route parameter: ${sourcePattern}:${key}`);
      }
      return String(value).replace(/^\/+|\/+$/gu, "").normalize().replaceAll("#", "%23").replaceAll("?", "%3F");
    }).normalize().replaceAll("#", "%23").replaceAll("?", "%3F"))
    .filter(Boolean).join("/");
  return endpoint ? `/${route}` : `/${route}${route ? "/" : ""}index.html`;
}

function recordPaths(sourcePattern: string, paths: readonly StaticBuildPath[]): void {
  const root = process.env.STATIC_BUILD_INPUT_ROOT;
  if (!root) throw new Error("STATIC_BUILD_INPUT_ROOT is required for route preparation");
  const sourceSha256 = createHash("sha256").update(fs.readFileSync(path.resolve(sourcePattern))).digest("hex");
  const routes = paths.map((entry) => {
    const astroPathname = physicalPath(sourcePattern, entry.params);
    const documentPath = staticDocumentLookupPath(astroPathname);
    const target = (entry.props?.entry as { staticRedirect?: string } | undefined)?.staticRedirect;
    const redirect = target ? { status: 308, location: `/${entry.params.locale}${target}/` } : undefined;
    return {
      params: entry.params,
      locale: entry.params.locale,
      type: sourcePattern.endsWith(".json.ts") ? "json" : "html",
      pathname: documentPath || astroPathname,
      astroPathname,
      packable: !!documentPath && !redirect,
      ...(redirect ? { redirect } : {}),
    };
  });
  const file = path.join(root, "route-plan", `${createHash("sha256").update(sourcePattern).digest("hex")}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      schema: "haneoka-static-route-plan-v1", sourcePattern, sourceSha256, routes,
    }), { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Enumerate complete props first; only the renderer's final path list is sharded. */
export function staticBuildPaths<T extends StaticBuildPath>(sourcePattern: string, paths: T[]): T[] {
  if (process.env.STATIC_BUILD_PHASE === "prepare") {
    recordPaths(sourcePattern, paths);
    return [];
  }
  const locale = process.env.STATIC_BUILD_LOCALE;
  if (!locale) return paths;
  if (!isLocale(locale)) throw new Error("Invalid STATIC_BUILD_LOCALE");
  if (process.env.STATIC_BUILD_INPUT_MODE !== "frozen")
    throw new Error("Locale shards require frozen build inputs");
  return paths.filter((entry) => entry.params.locale === locale);
}
