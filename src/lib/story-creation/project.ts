// L3 — GEB
// Input: 原生 Altair 工程，以及可编辑 TXT／原生映射与内部场景缓存。
// Output: 统一 Vega 项目、资源依赖闭包及发布健康检查。
// Pos: [Map](../L2-2.md)；浏览器导出与 Worker 发布使用同一编译契约。
// Effects/Dependencies: 读取工程 Blob；调用官方 ADV／WebGAL lowering，不加载外部插件代码。
import {
  AltairDocumentRegistry,
  parseAltairProjectDocument,
  parseAltairSceneDocument,
} from "@haneoka/altair/documents";
import { registerAdvDocumentCommands } from "@haneoka/altair-plugin-adv";
import { registerWebGalDocumentCommands } from "@haneoka/altair-plugin-webgal";
import { nativeScriptReferences, resolveNativeScriptWorkspace } from "@haneoka/altair-plugin-webgal/native-script";
import {
  compileVegaProjectWithDiagnostics,
  ALTAIR_VEGA_METADATA_KEYS,
  isCanonicalNativeWorkspace,
} from "@haneoka/altair-plugin-vega-preview/projection";
import { prepareStoryPackage, type StoryPackageFile } from "@haneoka/altair-plugin-vega-preview/packaging";
import {
  VEGA_ADV_OPCODE,
  VEGA_SYSTEM_OPCODE,
  VEGA_COMMAND_GROUP_OPCODE,
  VEGA_CORE_PROPERTY_CLIP,
  parsePropertyAnimationClip,
} from "@haneoka/vega-protocol";
import { WEBGAL_COMMAND_TYPES } from "@haneoka/vega-plugin-webgal/commands";
import { unsupportedVegaFullPresetPlugins } from "@haneoka/vega-preset-full/capabilities";
import { STORY_LIMITS } from "./types";
export async function compileCommunityStory(files: readonly StoryPackageFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file.blob]));
  const read = async (path: string) => {
    const blob = byPath.get(path.normalize("NFC"));
    if (!blob) throw new Error(`missing_file:${path}`);
    if (blob.size > STORY_LIMITS.scriptBytes) throw new Error(`file_size:${path}`);
    return blob.text();
  };
  const manifest = parseAltairProjectDocument(await read("project.yaml"));
  const scriptPaths = new Set([
    "project.yaml",
    ...manifest.scenes.map((ref) => ref.path),
    ...nativeScriptReferences(manifest).flatMap((ref) => [ref.source, ref.map]),
  ]);
  if ([...scriptPaths].reduce((sum, path) => sum + (byPath.get(path)?.size ?? 0), 0) > STORY_LIMITS.scriptBytes)
    throw new Error("file_size");
  const scriptFiles = new Map(
    await Promise.all([...scriptPaths].map(async (path) => [path, await read(path)] as const)),
  );
  const scenes = await Promise.all(
    manifest.scenes.map(async (ref) => {
      const scene = parseAltairSceneDocument(await read(ref.path));
      if (scene.id !== ref.id) throw new Error(`invalid_project:${ref.path}`);
      return scene;
    }),
  );
  const registry = new AltairDocumentRegistry();
  registerAdvDocumentCommands(registry);
  registerWebGalDocumentCommands(registry);
  const workspace = resolveNativeScriptWorkspace({ project: manifest, scenes }, scriptFiles);
  if (!isCanonicalNativeWorkspace(workspace)) throw new Error("native_conversion_required");
  const source = registry.compile(workspace);
  const result = compileVegaProjectWithDiagnostics(source, { preserveAuthoringSource: false });
  const supported = new Set<number | string>([
    "haneoka.vega-core:audioClip@1",
    VEGA_CORE_PROPERTY_CLIP,
    ...Object.values(VEGA_ADV_OPCODE),
    ...Object.values(VEGA_SYSTEM_OPCODE),
    VEGA_COMMAND_GROUP_OPCODE,
    ...Object.values(WEBGAL_COMMAND_TYPES),
  ]);
  const unsupported: { source: string; reason: string }[] = [];
  const check = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const command = value as Record<string, unknown>;
    if (!supported.has(command.command as number | string))
      unsupported.push({ source: path, reason: "unsupported_command" });
    const fields = (command.fields ?? command) as Record<string, unknown>;
    if (command.command === VEGA_CORE_PROPERTY_CLIP) parsePropertyAnimationClip(fields.clip);
    const group = fields.commandGroup as { actions?: { command: unknown }[] } | undefined;
    group?.actions?.forEach((action, index) => check(action.command, `${path}.actions.${index + 1}`));
    const timeline = fields.timeline as { signals?: { episode: unknown }[] } | undefined;
    timeline?.signals?.forEach((signal, index) => check(signal.episode, `${path}.signals.${index + 1}`));
  };
  source.scenes.forEach((scene) =>
    scene.commands.forEach((command, index) => check(command, `${scene.name}:${index + 1}`)),
  );
  const plugins = unsupportedVegaFullPresetPlugins(result.project);
  const error = result.diagnostics.some((issue) => issue.severity === "error")
    ? "invalid_project"
    : unsupported.length
      ? "unsupported_command"
      : plugins.length
        ? "unsupported_plugin"
        : null;
  const metadata = { ...result.project.metadata };
  delete metadata[ALTAIR_VEGA_METADATA_KEYS.authoringSource];
  delete metadata["altair:extensions"];
  delete metadata["altair:metaExtra"];
  const project = {
    ...result.project,
    metadata,
    scenes: Object.fromEntries(
      Object.entries(result.project.scenes).map(([id, scene]) => [
        id,
        { id: scene.id, ...(scene.title ? { title: scene.title } : {}), commands: scene.commands },
      ]),
    ),
  };
  const prepared = await prepareStoryPackage(project, files);
  return {
    ...prepared,
    error,
    diagnostics: [...unsupported, ...plugins.map((source) => ({ source, reason: "unsupported_plugin" }))],
    projectId: manifest.id,
    locales: [...manifest.locales],
    sceneCount: scenes.length,
    commandCount: Object.values(project.scenes).reduce((sum, scene) => sum + scene.commands.length, 0),
  };
}
