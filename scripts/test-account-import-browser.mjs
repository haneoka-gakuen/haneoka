import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const dir = path.resolve(".local-dev/import-browser");
await fs.mkdir(dir, { recursive: true });
const workers = { "box-import": "parser-worker.js", engine: "engine-worker.js" };
await build({
  entryPoints: ["scripts/tests/account-import.browser.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  splitting: true,
  outdir: dir,
  entryNames: "main",
  loader: { ".svg": "dataurl" },
  external: ["/fonts/*", "/assets/*"],
  plugins: [
    {
      name: "test-worker-urls",
      setup(builder) {
        builder.onLoad({ filter: /(?:box-import|engine)[\\/]client\.ts$/ }, async (args) => {
          let contents = await fs.readFile(args.path, "utf8");
          const worker = args.path.includes("box-import") ? workers["box-import"] : workers.engine;
          contents = contents.replaceAll(
            'new URL("./worker.ts", import.meta.url)',
            `new URL("/${worker}", import.meta.url)`,
          );
          return { contents, loader: "ts" };
        });
      },
    },
  ],
});
for (const [name, file] of Object.entries(workers))
  await build({
    entryPoints: [`src/lib/team-builder/${name}/worker.ts`],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: path.join(dir, file),
  });
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1);
  if (!name) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/main.css"><title>Synthetic import test</title><script type="module" src="/main.js"></script>',
    );
    return;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const file = name === "icons.svg" ? path.resolve(".generated-public/icons.svg") : path.join(dir, name);
    const bytes = await fs.readFile(file);
    res.setHeader(
      "content-type",
      name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/javascript",
    );
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH } : {}),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
const page = await context.newPage(),
  errors = [],
  external = [];
const uploads = [],
  deletes = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(address) || url.startsWith("blob:") || url.startsWith("data:")) return route.continue();
  external.push(url);
  return route.abort();
});
// Same-origin synthetic recognition service. Never contacts the deployed service.
await page.route(address + "/api/v1/team-builder/recognition/jobs**", async (route) => {
  const request = route.request();
  if (request.method() === "DELETE") {
    deletes.push(request.url());
    await route.fulfill({ status: 204 });
    return;
  }
  assert.equal(request.method(), "POST");
  const bytes = request.postDataBuffer(),
    width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  uploads.push({ width, height });
  const id = request.headers()["idempotency-key"],
    identity = Object.fromEntries(new URL(request.url()).searchParams),
    referenceId = "b".repeat(64);
  await route.fulfill({
    status: 200,
    json: {
      job: {
        id,
        state: "ready",
        context: { ...identity, referenceId },
        result: {
          schema: "haneoka-card-recognition-result-v1",
          identity,
          referenceId,
          images: [
            {
              id: "image",
              sha256: "c".repeat(64),
              size: [width, height],
              coordinateSpace: "exif_normalized_original",
              observationIds: ["card"],
              status: "ready",
            },
          ],
          observations: [
            {
              id: "card",
              imageId: "image",
              kind: "members",
              cardId: 1,
              bbox: [0, 0, 128, 128],
              candidates: [],
              fields: { level: { value: 2, status: "recognized" } },
            },
          ],
          engine: { algorithm: "synthetic-browser" },
        },
      },
    },
  });
});
try {
  await page.goto(address);
  await page.waitForFunction(() => window.host?.view);
  // Direct Worker callers cannot bypass the real-input gate.
  const engineChecks = await page.evaluate(async () => {
    const worker = new Worker("/engine-worker.js", { type: "module" });
    let id = 0;
    const call = (message) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(Error("synthetic-worker-timeout")), 10000);
        worker.onmessage = ({ data }) => {
          if (data.id === requestId && data.type !== "progress") {
            clearTimeout(timer);
            resolve(data);
          }
        };
        worker.postMessage({ ...message, id: requestId });
      });
    try {
      await call({ type: "init", data: window.fixture });
      const base = window.host.request();
      const incomplete = await call({ type: "run", request: base });
      const members = Array.from({ length: 6 }, (_, index) => ({
        key: `m${index + 1}`,
        cardId: index + 1,
        level: null,
        awake: null,
        rank: null,
        liveSkillLevel: null,
        gekisoSkillLevel: null,
      }));
      const simulation = await call({ type: "run", request: { ...base, members, inputIntent: "simulation", k: 1 } });
      return { incomplete: incomplete.message, simulation: simulation.type, count: simulation.result?.overall.length };
    } finally {
      worker.terminate();
    }
  });
  assert.deepEqual(engineChecks, { incomplete: "actual-input-incomplete", simulation: "result", count: 1 });
  await page.getByRole("button", { name: "导入", exact: true }).first().click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, "01-import-desktop.png") });
  const text = await page.getByRole("dialog").innerText();
  assert(text.includes("iPhone"));
  assert(text.includes("安卓"));
  await page
    .getByRole("dialog")
    .locator("input[type=file]")
    .setInputFiles({
      name: "synthetic.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ _memberCards: [{ _masterId: 1, _exp: "10" }] })),
    });
  await page.waitForFunction(() => window.host.imports.box?.phase === "review");
  assert(!(await page.getByRole("dialog").innerText()).includes("Applies to existing entries"));
  assert.equal(await page.evaluate(() => window.writeCount()), 0);
  assert.equal(await page.evaluate(() => window.host.imports.box.confirmation.cards.some((row) => row.include)), false);
  const bind = page.getByRole("dialog").locator("md-checkbox").first();
  await bind.click();
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  assert.deepEqual(
    await page.evaluate(() => {
      const r = window.host.view.members.get(1);
      return { level: r.level, awake: r.awake, skill: r.skill };
    }),
    { level: 2, awake: null, skill: null },
  );
  // Reimport the same evidence: confirmation closes without an inventory write.
  await page.evaluate(() => window.host.imports.openBox());
  await page
    .getByRole("dialog")
    .locator("input[type=file]")
    .setInputFiles({
      name: "synthetic.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ _memberCards: [{ _masterId: 1, _exp: "10" }] })),
    });
  await page.waitForFunction(() => window.host.imports.box?.phase === "review");
  assert(!(await page.getByRole("dialog").innerText()).includes("Applies to existing entries"));
  await page.getByRole("dialog").locator("md-checkbox").first().click();
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  assert.equal(await page.evaluate(() => window.writeCount()), 1);
  await page.evaluate(() => window.host.completeInputs());
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, "02-required-inputs.png") });
  await page.keyboard.press("Escape");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.host.imports.openBox(); }, theme);
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, `import-${width}-${theme}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.keyboard.press("Escape");
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.host.imports.openBox());
    await page.getByRole("dialog").waitFor();
    await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, `03-import-${width}.png`) });
    const overflow = await page.evaluate(() => {
      const d = document.querySelector("dialog");
      return d.scrollWidth > d.clientWidth + 2;
    });
    assert.equal(overflow, false);
    await page.keyboard.press("Escape");
  }
  // A synthetic signed-in owner only. No backend or real account is contacted.
  await page.evaluate(() => {
    window.host.snapshot = { ...window.host.snapshot, owner: "synthetic-owner" };
    window.host.imports.openScreenshots();
  });
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 800;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#6c59a5";
    ctx.fillRect(0, 0, 400, 800);
    ctx.fillStyle = "#fff";
    ctx.font = "24px sans-serif";
    ctx.fillText("Synthetic screenshot", 20, 100);
    return c.toDataURL().split(",")[1];
  });
  await page
    .getByRole("dialog")
    .locator("input[type=file]")
    .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => window.host.imports.screenshot?.phase === "preview");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, "04-screenshot-preview-320.png") });
  assert.equal(await page.evaluate(() => window.writeCount()), 1);
  assert.equal(uploads.length, 0);
  await page.getByRole("dialog").locator("input[type=number]").first().fill("25");
  await page.getByRole("dialog").locator("input[type=number]").first().blur();
  await page.getByRole("dialog").getByRole("button", { name: "确认上传裁剪后的图片并识别" }).click();
  await page.waitForFunction(() => window.host.imports.screenshot?.phase === "review");
  assert(!(await page.getByRole("dialog").innerText()).includes("Applies to existing entries"));
  assert.deepEqual(uploads, [{ width: 400, height: 600 }]);
  assert.equal(deletes.length, 1);
  assert.equal(await page.evaluate(() => window.writeCount()), 1);
  await page.getByRole("dialog").locator("md-checkbox").first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, "06-screenshot-review-320.png") });
  const policy = page.getByRole("dialog").getByRole("radiogroup", { name: "已有卡牌", exact: true });
  const bounds = await policy.evaluate(group => {
    const outer = group.getBoundingClientRect();
    return [...group.querySelectorAll('button')].map(button => {
      const rect = button.getBoundingClientRect();
      return { height: rect.height, fits: rect.top >= outer.top && rect.bottom <= outer.bottom + 1 };
    });
  });
  assert.equal(bounds.length, 3);
  assert(bounds.every(row => row.height >= 48 && row.fits), JSON.stringify(bounds));
  await policy.getByRole("radio", { name: "全部覆盖现有值", exact: true }).click();
  assert.equal(await page.evaluate(() => window.host.imports.screenshot.existingValues), "overwrite");
  await policy.getByRole("radio", { name: "全部保留现有值", exact: true }).click();
  assert.equal(await page.evaluate(() => window.host.imports.screenshot.existingValues), "keep");
  await policy.getByRole("radio", { name: "应用提升，下降另选", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认导入", exact: true }).click();
  assert.equal(await page.evaluate(() => window.writeCount()), 1);
  await page.evaluate(() => window.host.imports.openScreenshots());
  const heic = Buffer.alloc(24);
  heic.write("ftypheic", 4);
  await page
    .getByRole("dialog")
    .locator("input[type=file]")
    .setInputFiles({ name: "renamed.png", mimeType: "image/png", buffer: heic });
  await page.getByRole("alert").filter({ hasText: "HEIC" }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir, "05-heic-recovery-320.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.host.imports.openScreenshots());
  await page
    .getByRole("dialog")
    .locator("input[type=file]")
    .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => window.host.imports.screenshot?.phase === "preview");
  const revoked = await page.evaluate(async () => {
    const url = window.host.imports.screenshot.localImages[0].url;
    window.host.adopt({
      ...window.host.snapshot,
      owner: "another-synthetic-owner",
      version: window.host.snapshot.version + 1,
    });
    try {
      await fetch(url);
      return false;
    } catch {
      return window.host.imports.screenshot === null;
    }
  });
  assert.equal(revoked, true);
  assert.equal(uploads.length, 1);
  // The host antivirus may inject a script even in a fresh browser. It remains blocked.
  const unexpected = external.filter((url) => !new URL(url).hostname.endsWith(".kaspersky-labs.com"));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(dir, "receipt.json"),
    JSON.stringify(
      {
        browser: await browser.version(),
        widths: [1280, 390, 320],
        cases: [
          "local parser Worker review and confirm",
          "real engine Worker rejects incomplete actual input and permits explicit simulation",
          "unknown survives host.write/readBox",
          "identical reimport writes nothing",
          "required-input dialog",
          "narrow layout",
          "local image preview with no upload",
          "explicit crop upload to synthetic service and coordinate-consistent review",
          "HEIC recovery",
          "Escape cleanup",
          "owner change revokes local images",
        ],
        uploads,
        errors,
        unexpected,
        blockedEnvironmentRequests: external.length,
      },
      null,
      2,
    ),
  );
  console.log("Browser checks passed:", dir);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
