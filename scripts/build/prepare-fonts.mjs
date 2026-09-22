#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicSource = path.join(root, "public");
const staging = path.join(root, ".generated-public");
rmSync(staging, { recursive: true, force: true });
cpSync(publicSource, staging, { recursive: true });
console.log("staged public assets");
