import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const wranglerCli = resolve(dirname(wranglerPackage), "bin/wrangler.js");

export const runWrangler = (arguments_: readonly string[], repositoryRoot: string): void => {
  const result = spawnSync(process.execPath, [wranglerCli, ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.signal) throw new Error(`Wrangler stopped after receiving ${result.signal}`);
  throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}`);
};
