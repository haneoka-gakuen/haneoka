// L3 — GEB
// Input: Immutable source index and native-stage atlas/font descriptors.
// Output: Public chart-render resource names and exact output identities.
// Pos: [Map](L2.md); public native-stage projection and media ownership.
// Effects/Dependencies: Reads release metadata through its caller; excludes entity artwork and source browsing.
import { CAMERA_MANAGER_SOURCE } from "./retired-game-files";
import { HANEOKA_CHART_ASSETS_PROJECTION } from "../packages/api-client/src/chart-assets";
import type { HaneokaChartAssetSource } from "../packages/api-client/src/chart-assets";
export const CHART_ASSETS_PROJECTION = HANEOKA_CHART_ASSETS_PROJECTION;
const LIVE = "Assets/AddressableResources/Live/";
const EFFECT = "Assets/AddressableResources/Effect/Live/";
const FONT = "Assets/AddressableResources/Font/VibeMOPro-Medium/";
const FONT_ASSET = /\/VibeMOPro-Medium SDF\.asset(?:\/|$)/u;
const CAMERA = CAMERA_MANAGER_SOURCE;
const SCENE = "Assets/AddressableResources/Scene/Live.unity";
const INTRO = /^Assets\/AddressableResources\/Band\/\d+\/timeline\/(?:live_start_playable_timeline\.prefab|live_start_timeline_asset\.playable|UILiveStartCanvas_(?:hide|show)\.anim|live_game_view_(?:in|init)\.anim|camera_track\.anim|moving_light_root\.anim|live_background_view\.anim|live_game_lane_effect_(?:in|init)\.anim|[^/]+\.(?:mat|png))(?:\/|$)/u;
const JUDGEMENT = /\/JudgementAtlas\/judgment_(?:just|perfect|great|good|bad|miss|fast|late)\.png$/u;
const COMBO = /\/LiveComboAtlas\/SP_combo_(?:normal|perfect)(?:_\d)?\.png$/u;
const RANK = /\/scorerank_(?:d|c|b|a|s|ss)_ingame\.png$/u;

function renderSource(path: string): boolean {
  const source = path.replace(/^Packages\/com\.fromtokyo\.sirius-asset\/AddressableResources\//u, "Assets/AddressableResources/");
  return source.startsWith(LIVE) || source.startsWith(EFFECT) || source.startsWith(FONT)
    || source === CAMERA || source.startsWith(`${CAMERA}/`)
    || source === SCENE || source.startsWith(`${SCENE}/`) || INTRO.test(source)
    || /^Assets\/AddressableResources\/Band\/\d+\/live_stage\//u.test(source)
    || source.startsWith("Assets/RawData/AtlasReferences/Live/")
    || (source.startsWith("Assets/") && (FONT_ASSET.test(source) || JUDGEMENT.test(source) || COMBO.test(source) || RANK.test(source)));
}
export function publicChartAsset(path: string): boolean {
  if (path.startsWith("runtime/note-se/")) return true;
  if (path.startsWith("assets/")) return renderSource(path.slice(7));
  for (const prefix of ["runtime/unity/", "runtime/unity-json/"]) {
    if (path.startsWith(prefix)) return renderSource(path.slice(prefix.length));
  }
  return false;
}
export async function chartAssets(
  tree: unknown,
  read: (source: string) => Promise<unknown>,
  bandId?: number,
) {
  const files: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "number") { if (renderSource(path)) files.push(path); }
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) walk(child, path ? `${path}/${name}` : name);
    }
  };
  walk(tree, "");
  if (!files.some(path => path.endsWith("/CameraManager.prefab"))) files.push(CAMERA);
  files.sort();
  const find = (suffix: string) => {
    const found = files.filter(path => path.endsWith(`/${suffix}`));
    if (found.length !== 1) throw new Error(`Chart asset missing: ${suffix}`);
    return found[0]!;
  };
  const names = [find("LiveAtlas.spriteatlasv2"), find("VibeMOPro-Medium SDF.asset"),
    find("JudgementAtlas.spriteatlasv2"), find("LiveComboAtlas.spriteatlasv2")];
  for (const name of ["LiveComboNAtlas.spriteatlasv2", "LiveComboFCAtlas.spriteatlasv2", "LiveComboAPAtlas.spriteatlasv2", "SP_combo_fc_glow.png", "SP_combo_ap_glow.png"]) {
    const source = files.find(path => path.endsWith(`/${name}`));
    if (source) names.push(source);
  }
  if (bandId !== undefined) {
    const band = files.includes(`Assets/AddressableResources/Band/${bandId}/timeline/live_start_playable_timeline.prefab`) ? bandId : 0;
    const prefix = `Assets/AddressableResources/Band/${band}/timeline/`;
    names.push(...files.filter(path => (path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      || path === SCENE || path === `${LIVE}Images/NonAtlas/LiveStartAnim/lane_mesh.fbx`
      || path === `${LIVE}Materials/LiveStartAnim/white_line.mat` || path === `${LIVE}Materials/LiveStartAnim/white_star.mat`));
  }
  const descriptors = await Promise.all(names.map(async source => {
    const value = await read(source);
    const rows = value && typeof value === "object" && "outputs" in value ? value.outputs : null;
    if (!Array.isArray(rows)) throw new Error(`Chart descriptor missing: ${source}`);
    const fields = value as Record<string, unknown>;
    const descriptor = {
      sourcePath: source,
      outputs: rows.flatMap(row => row && typeof row === "object"
      && typeof row.type === "string" && typeof row.path === "string"
        ? [{ type: row.type, path: row.path,
          ...(typeof row.objectId === "string" || typeof row.objectId === "number" ? { objectId: row.objectId } : {}),
          ...(typeof row.serializedFile === "string" ? { serializedFile: row.serializedFile } : {}) }] : []),
      runtimeObjects: Array.isArray(fields.runtimeObjects) ? fields.runtimeObjects.flatMap(row => row && typeof row === "object"
        && typeof row.type === "string" && typeof row.path === "string" ? [{ type: row.type, path: row.path }] : []) : [],
      ...(typeof fields.serializedFile === "string" ? { serializedFile: fields.serializedFile } : {}),
      ...(typeof fields.runtimeProjectionPolicy === "string" ? { runtimeProjectionPolicy: fields.runtimeProjectionPolicy } : {}),
      ...(Array.isArray(fields.preloadObjectReferences) ? { preloadObjectReferences: fields.preloadObjectReferences.flatMap(row =>
        row && typeof row === "object" && typeof row.serializedFile === "string" && typeof row.pathId === "string"
          ? [{ serializedFile: row.serializedFile, pathId: row.pathId }] : []) } : {}),
    } satisfies HaneokaChartAssetSource;
    return [source, descriptor] as const;
  }));
  return { files, sources: Object.fromEntries(descriptors) };
}
