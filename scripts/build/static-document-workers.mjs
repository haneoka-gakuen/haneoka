// Input: Complete rendered files, frozen publication metadata and verified media mappings.
// Output: Public page selections, byte-preserving URL rewrites and complete Markdown records.
// Pos: Build-only workers owned by finalize-frontend.mjs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { registerHooks } from "node:module";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export class StaticDocumentWorkers {
  constructor(options) {
    this.queue = [];
    this.workers = Array.from({ length: Math.min(4, options.concurrency ?? 4, availableParallelism()) }, () => {
      const worker = new Worker(new URL(import.meta.url), { workerData: options });
      const slot = { worker };
      worker.on("message", ({ value, error }) => {
        const task = slot.task;
        slot.task = undefined;
        if (!task) return;
        if (error) task.reject(new Error(error));
        else task.resolve(value);
        this.next(slot);
      });
      worker.on("error", (error) => this.fail(error));
      worker.on("exit", (code) => {
        if (!this.closed) this.fail(new Error(`Static document worker exited (${code})`));
      });
      return slot;
    });
  }
  next(slot) {
    if (slot.task || this.failure || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    slot.task = task;
    slot.worker.postMessage(task.job);
  }
  run(job) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      for (const slot of this.workers) this.next(slot);
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const slot of this.workers) {
      slot.task?.reject(error);
      slot.task = undefined;
    }
    for (const task of this.queue.splice(0)) task.reject(error);
  }
  async close() {
    this.closed = true;
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
  }
}

if (!isMainThread) {
  const source = new URL("../../src/", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" ||
          !/^\.\.?\//u.test(specifier) ||
          !context.parentURL?.startsWith(source)
        )
          throw error;
        return next(`${specifier}.ts`, context);
      }
    },
  });
  const module = await import("../../src/server/public-static-documents.ts");
  const { publicStaticStagingRoot, isPublicStaticDocument } = await import("../../src/server/static-documents.ts");
  const { publicMediaRewrite } = await import("./public-static-media.mjs");
  const { markdownDocument } = await import("./search-metadata.mjs");
  const { output, documentsRoot, options, media, urlMap, urlTokens } = workerData;
  const tokens = urlTokens && new Map(urlTokens);
  const tokenCache = new Map();
  let mediaFor;
  const mapped = urlMap && module.publicUrlMapRewrite(urlMap);
  const rewrites = new Map();
  parentPort.on("message", (job) => {
    try {
      let value;
      if (job.kind === "materialize") {
        const html = fs.readFileSync(path.join(output, job.sourcePath), "utf8");
        const references = new Map();
        const functional = job.target.scope === "global" && /\/team-builder\/$/u.test(job.target.path);
        const published =
          !isPublicStaticDocument(html) &&
          module.materializePublicStaticDocument(html, job.target, {
            ...options,
            ...(media && {
              rewriteUrl(url, site) {
                if (!(functional && "script" in site)) references.set(url, (references.get(url) || 0) + 1);
                return undefined;
              },
            }),
          });
        if (published) {
          module.stagePublicStaticDocument(documentsRoot, job.sourcePath, published.html);
          value = { references: [...references], privateData: published.privateData };
        }
      } else if (job.kind === "tokenize") {
        const file = path.join(job.staged ? publicStaticStagingRoot(documentsRoot) : output, job.sourcePath);
        const html = fs.readFileSync(file, "utf8");
        if (!/<\/html\s*>/iu.test(html)) {
          parentPort.postMessage({ value: [] });
          return;
        }
        const added = [];
        const rewrite = Object.assign(
          (url, site) => {
            const key = `${"element" in site ? "a" : "j"}\0${url}`;
            if (tokenCache.has(key)) return tokenCache.get(key);
            const token = module.staticUrlToken(url, site);
            tokenCache.set(key, token);
            if (token) added.push([token, url]);
            return token;
          },
          { contextIndependent: true },
        );
        const next = module.rewriteStaticDocumentUrls(html, rewrite);
        if (next !== html) fs.writeFileSync(file, next);
        value = added;
      } else if (job.kind === "rewrite") {
        if (media && !mediaFor)
          mediaFor = publicMediaRewrite(
            JSON.parse(fs.readFileSync(path.join(documentsRoot, "public-media.json"), "utf8")),
          );
        if (!rewrites.has(job.locale)) {
          const own = mediaFor?.(job.locale);
          rewrites.set(
            job.locale,
            Object.assign((url, site) => own?.(url, site) ?? mapped?.(url, site) ?? module.functionalMediaUrl(url), {
              contextIndependent: true,
            }),
          );
        }
        const file = path.join(job.staged ? publicStaticStagingRoot(documentsRoot) : output, job.sourcePath);
        const html = fs.readFileSync(file, "utf8");
        if (!job.staged && !job.contentsOnly && (isPublicStaticDocument(html) || !/<\/html\s*>/iu.test(html))) {
          parentPort.postMessage({ value: false });
          return;
        }
        const externalize = (_id, data) => {
          const sha256 = createHash("sha256").update(data).digest("hex");
          const target = path.join(output, "entity-data", "v1", `${sha256}.json`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          try {
            fs.writeFileSync(target, data, { flag: "wx" });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          return `/entity-data/v1/${sha256}.json`;
        };
        let next;
        if (tokens) {
          next = module.resolveStaticUrlTokens(html, tokens, rewrites.get(job.locale));
          if (job.staged && module.publicStaticTarget(job.sourcePath)?.scope !== "entity")
            next = module.externalizePublicPageData(next, externalize);
        } else
          next = module.rewriteStaticDocumentUrls(html, rewrites.get(job.locale), job.staged ? externalize : undefined);
        if (job.contentsOnly) value = next;
        else {
          if (next !== html) fs.writeFileSync(file, next);
          value = true;
        }
      } else if (job.kind === "markdown") {
        value = markdownDocument(job.content, job.sourcePath);
      } else throw new Error(`Unknown static document operation: ${job.kind}`);
      parentPort.postMessage({ value });
    } catch (error) {
      parentPort.postMessage({ error: error.stack || String(error) });
    }
  });
}
