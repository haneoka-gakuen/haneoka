import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".local-dev", { recursive: true });
await build({
  entryPoints: ["scripts/tests/account-import.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: ".local-dev/account-import.test.mjs",
});
const result = spawnSync(process.execPath, ["--test", ".local-dev/account-import.test.mjs"], {
  stdio: "inherit",
  windowsHide: true,
});
process.exitCode = result.status ?? 1;
