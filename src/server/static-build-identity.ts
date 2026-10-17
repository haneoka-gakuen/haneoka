import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function staticBuildSourceIdentity(root: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Use a clean locked source checkout");
  return {
    sha: git("rev-parse", "HEAD"),
    gitlinks: git("ls-tree", "-r", "HEAD")
      .split("\n")
      .filter((line) => line.startsWith("160000 ")),
    packageLockSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, "pnpm-lock.yaml")))
      .digest("hex"),
    node: process.version,
    icu: process.versions.icu,
    platform: process.platform,
    architecture: process.arch,
    configuration: Object.fromEntries(
      [
        "STATIC_PAGE_GROUPS",
        "STATIC_RESOURCE_SERVERS",
        "STATIC_CATALOG_SOURCE",
        "CALENDAR_LIVES_MONTH",
        "PROVIDER_STATIC_ALLOW_PARTIAL",
        "PROVIDER_STATIC_DATA_ROOT",
        "PROVIDER_ENTITY_ROOT",
        "NATIVE_META_REFERENCE_RECEIPTS_JSON",
      ].map((key) => [key, process.env[key] || ""]),
    ),
  };
}
