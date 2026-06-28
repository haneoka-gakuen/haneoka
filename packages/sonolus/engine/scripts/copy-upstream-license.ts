import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(engineRoot, "../../..");
const outputRoot = resolve(engineRoot, "dist");

mkdirSync(outputRoot, { recursive: true });
copyFileSync(resolve(repositoryRoot, "LICENSE"), resolve(outputRoot, "LICENSE"));
copyFileSync(resolve(engineRoot, "NOTICE.txt"), resolve(outputRoot, "NOTICE.txt"));
copyFileSync(resolve(engineRoot, "LICENSE.pjsekai.txt"), resolve(outputRoot, "LICENSE.pjsekai.txt"));

const sourceRevision = [process.env.GITHUB_SHA, process.env.CF_PAGES_COMMIT_SHA].find((value) =>
  /^[0-9a-f]{40}$/i.test(value ?? ""),
);
const sourceUrl = sourceRevision
  ? `https://github.com/haneoka-gakuen/haneoka/tree/${sourceRevision}`
  : "https://github.com/haneoka-gakuen/haneoka";
writeFileSync(resolve(outputRoot, "SOURCE.txt"), `Corresponding Haneoka Source Code Form:\n${sourceUrl}\n`);
