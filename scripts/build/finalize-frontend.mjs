#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const output = path.resolve(".output/public");
// The Cubism declaration is useful to developers but is not a browser asset
// and is intentionally outside the runtime's exact production file set.
for (const relative of ["Core/CRI/live2dcubismmotionsynccore.d.ts"]) {
  const target = path.join(output, relative);
  if (existsSync(target)) unlinkSync(target);
}
console.log("finalized browser-only public output");
