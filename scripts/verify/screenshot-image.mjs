// Run the TypeScript preprocessor with a canvas boundary double; no network or image fixtures.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { prepareScreenshot, FULL_SCREENSHOT } from "../../src/lib/team-builder/screenshot-image.ts";

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}

let frames, closed;
const originals = new Map(["createImageBitmap", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
beforeEach(() => {
  frames = [];
  closed = 0;
  globalThis.createImageBitmap = async blob => {
    const view = new DataView(await blob.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20), close() { closed++; } };
  };
  globalThis.document = {
    createElement() {
      let source;
      return {
        getContext() { return { drawImage(_image, x, y, width, height) { source = [x, y, width, height]; } }; },
        toBlob(done) {
          frames.push({ width: this.width, height: this.height, source });
          done(png(this.width, this.height));
        },
      };
    },
  };
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test("large landscape and portrait images remain within the deployed pixel limit after both passes", async () => {
  for (const [width, height] of [[4096, 2160], [2160, 4096], [4000, 4000], [8192, 1024]]) {
    const signal = new AbortController().signal;
    const prepared = await prepareScreenshot(png(width, height), FULL_SCREENSHOT, signal);
    await prepareScreenshot(prepared, FULL_SCREENSHOT, signal);
    for (const frame of frames.slice(-2)) {
      assert.ok(frame.width * frame.height <= 8_000_000);
      assert.ok(Math.max(frame.width, frame.height) <= 4096);
      assert.ok(Math.abs(frame.width / frame.height - width / height) < .01);
    }
    assert.equal(frames.at(-1).width, frames.at(-2).width);
    assert.equal(frames.at(-1).height, frames.at(-2).height);
  }
  assert.equal(closed, 8);
});

test("ordinary iOS screenshots keep their dimensions and a crop uses original pixels", async () => {
  await prepareScreenshot(png(1280, 889), FULL_SCREENSHOT, new AbortController().signal);
  assert.deepEqual(frames[0], { width: 1280, height: 889, source: [0, 0, 1280, 889] });
  await prepareScreenshot(png(1280, 889), { top: 10, bottom: 10, left: 5, right: 5 }, new AbortController().signal);
  assert.deepEqual(frames[1], { width: 1152, height: 713, source: [64, 88, 1152, 713] });
  assert.equal(closed, 2);
});

test("an aborted request never decodes or encodes an image", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareScreenshot(png(1280, 889), FULL_SCREENSHOT, controller.signal), { name: "AbortError" });
  assert.equal(closed, 0);
  assert.equal(frames.length, 0);
});
