import { access, readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);

for (const path of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
  await access(new URL(path, root));
}

if (manifest.exports?.["./story-editor"]) {
  throw new Error("The editor-specific Bestdori export must not be published");
}

for (const dependencyGroup of [
  "dependencies",
  "peerDependencies",
  "devDependencies",
  "optionalDependencies",
]) {
  const dependencies = manifest[dependencyGroup] ?? {};
  if (
    Object.hasOwn(dependencies, "@haneoka/altair") ||
    Object.hasOwn(dependencies, "@haneoka/altair-plugin-adv")
  ) {
    throw new Error(
      `${dependencyGroup} must not couple the neutral Bestdori package to Altair`,
    );
  }
}

const sourceFiles = await readdir(new URL("dist/", root), {
  recursive: true,
});
if (sourceFiles.some((path) => path.includes("story-editor"))) {
  throw new Error("Editor-specific files remain in the Bestdori publish output");
}
const publishedSource = (
  await Promise.all(
    sourceFiles
      .filter((path) => /\.(?:js|d\.ts)$/u.test(path))
      .map((path) => readFile(new URL(`dist/${path}`, root), "utf8")),
  )
).join("\n");

if (
  publishedSource.includes("@haneoka/altair") ||
  publishedSource.includes("story-editor")
) {
  throw new Error("Editor-specific code remains in the Bestdori publish output");
}

console.log(`Verified ${manifest.name}@${manifest.version}`);
