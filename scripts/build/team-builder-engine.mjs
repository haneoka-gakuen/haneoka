#!/usr/bin/env node
// Compiles the team-building engine (.dependencies/ournotes-team-builder) to WebAssembly for the team builder Worker.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = path.join(root, ".dependencies/ournotes-team-builder/Cargo.toml");
const target = path.join(root, ".cache/ournotes-team-builder");
execFileSync(
  "cargo",
  ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest, "--target-dir", target],
  { stdio: "inherit" },
);
const out = path.join(root, "src/lib/team-builder/engine/generated");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(target, "wasm32-unknown-unknown/release/haneoka_team_engine.wasm"), path.join(out, "team-engine.wasm"));
console.log("built team-engine.wasm");
