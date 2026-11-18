// L3 — GEB
// Input: Locked page sources, original getStaticPaths producers and captured build inputs.
// Output: Complete original route-plan records without an Astro/Vite render build.
// Pos: [Map](L2-2.md); prepare-only route collection with real compiler frontmatter parsing.
// Effects/Dependencies: Bundles one Node producer graph, runs original readers and writes route plans; failures preserve captures for a fresh producer + Astro fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { staticBuildSourceIdentity } from "../../src/server/static-build-identity.ts";

export async function prepareStaticRoutes({ root = process.cwd() } = {}) {
  root = fs.realpathSync(root);
  const initialCwd = process.cwd();
  const initialNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV ||= "production";
  process.chdir(root);
  const started = performance.now();
  const output = path.join(root, ".astro/static-inputs", `routes-${process.pid}.mjs`);
  try {
    const source = staticBuildSourceIdentity(root);
    assert.equal(process.env.NODE_ENV, "production", "Route preparation requires NODE_ENV=production");
    assert.ok(["capture", "frozen"].includes(process.env.STATIC_BUILD_INPUT_MODE));
    assert.equal(process.env.STATIC_BUILD_PHASE, "prepare", "Set STATIC_BUILD_PHASE=prepare");
    assert.ok(process.env.STATIC_BUILD_INPUT_ROOT, "Set STATIC_BUILD_INPUT_ROOT");
    const routeRoot = path.resolve(process.env.STATIC_BUILD_INPUT_ROOT, "route-plan");
    assert.ok(!fs.existsSync(routeRoot), "Route preparation requires a fresh route-plan directory");
    assert.ok(
      !process.env.STATIC_BUILD_LOCALE && !process.env.STATIC_BUILD_PARTITION,
      "Route preparation requires every locale and partition",
    );
    const require = createRequire(path.join(root, "package.json"));
    const ts = require("typescript"),
      { build } = require("esbuild");
    const astroRequire = createRequire(require.resolve("astro/package.json"));
    const compiler = await import(pathToFileURL(astroRequire.resolve("@astrojs/compiler")).href);
    const { resolve: resolveImport } = await import(pathToFileURL(astroRequire.resolve("import-meta-resolve")).href);
    const pages = path.join(root, "src/pages");
    const scripts = new Map();
    for (const relative of fs.readdirSync(pages, { recursive: true }).sort()) {
      if (!/\.(?:astro|ts)$/u.test(relative)) continue;
      const file = path.join(pages, relative),
        text = fs.readFileSync(file, "utf8");
      if (!/\bexport\s+(?:async\s+)?(?:function|const)\s+getStaticPaths\b/u.test(text)) continue;
      const script = file.endsWith(".astro")
        ? (await compiler.parse(text)).ast.children.find((node) => node.type === "frontmatter")?.value
        : text;
      assert.equal(typeof script, "string", `Missing page frontmatter: ${relative}`);
      scripts.set(file, script);
    }
    assert.ok(scripts.size, "Static route producers are missing");
    const options = {
      noResolve: true,
      noLib: true,
      allowNonTsExtensions: true,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (file) =>
      scripts.has(file)
        ? ts.createSourceFile(file, scripts.get(file), options.target, true, ts.ScriptKind.TS)
        : undefined;
    host.fileExists = (file) => scripts.has(file);
    host.readFile = (file) => scripts.get(file);
    const program = ts.createProgram([...scripts.keys()], options, host),
      checker = program.getTypeChecker();
    const producers = new Map();
    const literal = (node) => {
      if (!node) return false;
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
        return literal(node.expression);
      return (
        ts.isStringLiteral(node) ||
        ts.isNumericLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind) ||
        (ts.isArrayLiteralExpression(node) && node.elements.every(literal))
      );
    };
    for (const file of program.getSourceFiles()) {
      const selected = new Set(
        file.statements.filter(
          (node) => ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
        ),
      );
      let target;
      for (const statement of file.statements) {
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (declaration.name.getText(file) === "prerender")
              assert.equal(
                declaration.initializer?.kind,
                ts.SyntaxKind.TrueKeyword,
                `Unsupported prerender policy: ${file.fileName}`,
              );
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === "getStaticPaths") target = statement;
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations.find(
            (node) => node.name.getText(file) === "getStaticPaths",
          );
          if (declaration) {
            assert.equal(
              statement.declarationList.declarations.length,
              1,
              "Separate getStaticPaths from other declarations",
            );
            target = declaration;
          }
        }
      }
      assert.ok(target, `Missing getStaticPaths export: ${file.fileName}`);
      const fn = ts.isFunctionDeclaration(target) ? target : target.initializer;
      assert.ok(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn));
      assert.equal(fn.parameters.length, 0, `Unsupported route context: ${file.fileName}`);
      const top = (node) => {
        while (node.parent && !ts.isSourceFile(node.parent)) node = node.parent;
        return node;
      };
      selected.add(top(target));
      const visit = (node) => {
        if (ts.isIdentifier(node)) {
          assert.ok(!["Astro", "paginate"].includes(node.text), `Unsupported Astro route API: ${file.fileName}`);
          for (const declaration of checker.getSymbolAtLocation(node)?.declarations || []) {
            const statement = top(declaration);
            if (ts.isImportDeclaration(statement)) {
              assert.ok(
                !/\.(?:astro|css)$/u.test(statement.moduleSpecifier.text),
                `Route producer uses a renderer import: ${file.fileName}`,
              );
            } else if (statement.parent === file && !selected.has(statement)) {
              assert.ok(
                ts.isVariableStatement(statement) &&
                  statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
                  statement.declarationList.flags & ts.NodeFlags.Const &&
                  statement.declarationList.declarations.every((entry) => literal(entry.initializer)),
                `Unsupported route module binding: ${node.text} in ${file.fileName}`,
              );
              selected.add(statement);
              ts.forEachChild(statement, visit);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(target);
      const contents = file.statements
        .filter((node) => selected.has(node))
        .map((node) => node.getText(file))
        .join("\n");
      assert.ok(!/import\.meta\.glob\b/u.test(contents), `Unsupported Vite glob: ${file.fileName}`);
      producers.set(file.fileName, contents);
    }
    const imports = [...producers.keys()].map(
      (file, index) => `import { getStaticPaths as route${index} } from ${JSON.stringify(file)};`,
    );
    const calls = [...producers.keys()].map((_, index) => `await route${index}();`);
    const entry = [
      `import { resetStaticBuildInputErrors, finishStaticBuildInputs } from ${JSON.stringify(path.join(root, "src/server/static-input-store.ts"))};`,
      `import { beginStaticDocumentsBuild } from ${JSON.stringify(path.join(root, "src/server/static-documents.ts"))};`,
      `import { themeCharacters } from ${JSON.stringify(path.join(root, "src/server/theme-characters.ts"))};`,
      `import { staticCatalogJsonMetrics, staticCatalogBlobMetrics } from ${JSON.stringify(path.join(root, "src/lib/static-catalog-source.ts"))};`,
      ...imports,
      "export async function collect() { resetStaticBuildInputErrors(); beginStaticDocumentsBuild(); await themeCharacters('en');",
      ...calls,
      "return { capture: await finishStaticBuildInputs(), nativeJson: staticCatalogJsonMetrics(), nativeBlobs: staticCatalogBlobMetrics() }; }",
    ].join("\n");
    await build({
      stdin: { contents: entry, resolveDir: root, sourcefile: "static-route-producers" },
      absWorkingDir: root,
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      define: { "import.meta.env": JSON.stringify({ PROD: true, DEV: false, SSR: true, BASE_URL: "/" }) },
      logLevel: "warning",
      plugins: [
        {
          name: "original-route-frontmatter",
          setup(builder) {
            builder.onResolve({ filter: /\.css$/u }, (args) => ({
              path: require.resolve(args.path, { paths: [args.resolveDir] }),
              namespace: "route-css",
            }));
            builder.onLoad({ filter: /.*/u, namespace: "route-css" }, (args) => ({
              contents: fs.readFileSync(args.path, "utf8"),
              loader: "css",
              resolveDir: path.dirname(args.path),
            }));
            builder.onResolve({ filter: /\.svg\?(?:raw|url)$/u }, (args) => {
              const [file, query] = args.path.split("?");
              return { path: path.resolve(args.resolveDir, file), namespace: `route-asset-${query}` };
            });
            for (const [namespace, loader] of [
              ["route-asset-raw", "text"],
              ["route-asset-url", "dataurl"],
            ])
              builder.onLoad({ filter: /.*/u, namespace }, (args) => ({
                contents: fs.readFileSync(args.path),
                loader,
              }));
            builder.onResolve({ filter: /\.astro$/u }, (args) => {
              const file = path.resolve(args.resolveDir, args.path);
              return producers.has(file)
                ? { path: file, namespace: "route-producer" }
                : { path: file, external: true, sideEffects: false };
            });
            builder.onLoad({ filter: /.*/u, namespace: "route-producer" }, (args) => ({
              contents: producers.get(args.path),
              loader: "ts",
              resolveDir: path.dirname(args.path),
            }));
            builder.onLoad({ filter: /\.ts$/u }, (args) =>
              producers.has(args.path)
                ? { contents: producers.get(args.path), loader: "ts", resolveDir: path.dirname(args.path) }
                : undefined,
            );
            builder.onResolve({ filter: /^astro:/u }, (args) => {
              if (args.path === "astro:transitions/client" && args.kind === "dynamic-import")
                return { path: args.path, external: true };
              throw new Error(`Unsupported Astro virtual module: ${args.path}`);
            });
            builder.onResolve({ filter: /^[^./]/u }, (args) =>
              args.path.startsWith("@haneoka/") || args.path.startsWith("#")
                ? undefined
                : {
                    path: resolveImport(
                      args.path,
                      pathToFileURL(args.importer || path.join(root, "package.json")).href,
                    ),
                    external: true,
                  },
            );
          },
        },
      ],
    });
    const { collect } = await import(pathToFileURL(output).href);
    const { capture, nativeJson, nativeBlobs } = await collect();
    const recorded = fs
      .readdirSync(routeRoot)
      .map((file) => JSON.parse(fs.readFileSync(path.join(routeRoot, file), "utf8")));
    assert.deepEqual(
      recorded.map((record) => path.resolve(record.sourcePattern)).sort(),
      [...producers.keys()].sort(),
      "Static route producer set differs",
    );
    return {
      stage: "static-route-prepare",
      sourceSha: source.sha,
      producers: producers.size,
      routes: recorded.reduce((sum, record) => sum + record.routes.length, 0),
      inputMode: process.env.STATIC_BUILD_INPUT_MODE,
      inputRecords: capture?.records.length,
      inputFiles: capture?.files.length,
      nativeJson,
      nativeBlobs,
      elapsedMs: performance.now() - started,
      peakRssKb: process.resourceUsage().maxRSS,
    };
  } catch (error) {
    throw new Error(
      "Static route collection failed; restart the producer and original Astro prepare with a fresh capture root",
      { cause: error },
    );
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(output.replace(/\.mjs$/u, ".css"), { force: true });
    process.chdir(initialCwd);
    if (initialNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = initialNodeEnv;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: "string" } } });
  console.log(JSON.stringify(await prepareStaticRoutes({ root: values.root })));
}
