import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Crop the original user artwork to 6:1 without redrawing or stretching it. */
export function buildServerBanner(root: string): string {
  const source = resolve(root, "packages/sonolus/assets/server-banner-source.jpg");
  const outputDirectory = resolve(root, "packages/sonolus/dist");
  const output = resolve(outputDirectory, "server-banner.png");
  const dimensions = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", source], { encoding: "utf8" }).trim();
  if (dimensions !== "3840x660") throw new Error(`Unexpected Sonolus banner source dimensions: ${dimensions}`);
  mkdirSync(outputDirectory, { recursive: true });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-vf", "crop=3840:640:0:10", "-frames:v", "1", "-pix_fmt", "rgba", output],
    { stdio: ["ignore", "pipe", "pipe"] });
  return output;
}
