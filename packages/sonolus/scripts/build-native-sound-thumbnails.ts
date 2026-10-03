import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSquareThumbnail } from "./presentation-thumbnails.ts";

// Use the same fit and square canvas as the other Sonolus thumbnails.
// The banner and website artwork remain separate source files.
export function buildNativeSoundThumbnail(sourceFile: string, outputFile: string) {
  const source = resolve(sourceFile);
  const output = resolve(outputFile);
  if (source === output) throw new Error("The Sonolus thumbnail must have its own output path");
  const png = readFileSync(source);
  const thumbnail = buildSquareThumbnail(png, source);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, thumbnail);
  return {
    output, width: thumbnail.readUInt32BE(16), height: thumbnail.readUInt32BE(20),
    sourceWidth: png.readUInt32BE(16), sourceHeight: png.readUInt32BE(20),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error("Usage: build-native-sound-thumbnails.ts SOURCE.png OUTPUT.png");
  console.log(JSON.stringify(buildNativeSoundThumbnail(source, output)));
}
