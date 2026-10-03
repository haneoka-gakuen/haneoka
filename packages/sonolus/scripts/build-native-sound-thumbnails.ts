import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Engine/SFX use the supplied square application icon, with its original
// pixels and alpha. Rectangular server banners are a separate resource.
export function buildNativeSoundThumbnail(sourceFile: string, outputFile: string) {
  const source = resolve(sourceFile);
  const output = resolve(outputFile);
  if (source === output) throw new Error("The Sonolus thumbnail must have its own output path");
  const png = readFileSync(source);
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error(`Expected a PNG application icon: ${source}`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || width !== height)
    throw new Error(`Engine/SFX thumbnails require a square application icon: ${width}x${height}`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, png);
  return { output, width, height, sourceWidth: width, sourceHeight: height };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error("Usage: build-native-sound-thumbnails.ts SOURCE.png OUTPUT.png");
  console.log(JSON.stringify(buildNativeSoundThumbnail(source, output)));
}
