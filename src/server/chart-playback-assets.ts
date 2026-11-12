// Build-time chart playback data.
// Input: 公开 server 的固定 release、chart-assets 乐队投影及其声明的 unity-json 记录。
// Output: 每个开场乐队一个内容寻址 playback-data 包、release 清单和页面元数据。
// Pos: [Map](L2-2.md)；谱面播放器开场／HUD 原始记录的构建期合包。
// Effects/Dependencies: 经 static-catalog-source 读取（捕获／冻结重放并校验摘要）；写入或核对 .generated-public/playback-data。
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HANEOKA_CHART_ASSETS_PROJECTION,
  type HaneokaChartAssets,
  type HaneokaChartAssetSource,
} from "../../packages/api-client/src/chart-assets";
import {
  fetchStaticApplicationJson,
  fetchStaticReleaseJson,
  staticCatalogRelease,
  type StaticCatalogRelease,
} from "../lib/static-catalog-source";

export const CHART_PLAYBACK_DATA_SCHEMA = "haneoka-chart-playback-data-v1";
export const CHART_PLAYBACK_DATA_ELEMENT_ID = "chart-playback-data";

export interface ChartPlaybackPack {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly records: number;
}
export interface ChartPlaybackData {
  readonly schema: typeof CHART_PLAYBACK_DATA_SCHEMA;
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
  /** Keyed by the intro band the player resolves from `files` (band 0 when a band has no timeline). */
  readonly packs: Readonly<Record<string, ChartPlaybackPack>>;
}

const LIVE = "Assets/AddressableResources/Live/";
const INTRO_SHARED = new Set([
  "Assets/AddressableResources/Scene/Live.unity",
  `${LIVE}Images/NonAtlas/LiveStartAnim/lane_mesh.fbx`,
  `${LIVE}Materials/LiveStartAnim/white_line.mat`,
  `${LIVE}Materials/LiveStartAnim/white_star.mat`,
]);
const COMBO_TIERS = [
  "LiveComboNAtlas.spriteatlasv2",
  "LiveComboFCAtlas.spriteatlasv2",
  "LiveComboAPAtlas.spriteatlasv2",
  "SP_combo_fc_glow.png",
  "SP_combo_ap_glow.png",
];
const timeline = (band: number) => `Assets/AddressableResources/Band/${band}/timeline/`;
const director = (band: number) => `${timeline(band)}live_start_playable_timeline.prefab`;

const generatedRoot = () => path.resolve(".generated-public");
const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");
let activeReads = 0;
const waitingReads: Array<() => void> = [];
async function runtimeJson(relative: string, release: StaticCatalogRelease): Promise<unknown> {
  if (activeReads >= 8) await new Promise<void>((resolve) => waitingReads.push(resolve));
  else activeReads++;
  try {
    return await fetchStaticReleaseJson(relative, release.server, release);
  } finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}

async function bandAssets(release: StaticCatalogRelease, band: number): Promise<HaneokaChartAssets> {
  const assets = (await fetchStaticApplicationJson(
    `/api/v1/servers/${encodeURIComponent(release.server)}/chart-assets?projection=${HANEOKA_CHART_ASSETS_PROJECTION}&bandId=${band}`,
    release,
  )) as HaneokaChartAssets;
  const { identity } = assets;
  if (
    assets.schema !== "haneoka-chart-assets-v1" ||
    identity.server !== release.server ||
    identity.releaseId !== release.releaseId ||
    identity.sourceId !== release.sourceId
  )
    throw new Error(`Chart assets identity differs from ${release.server}/${release.releaseId}`);
  return assets;
}

/** The runtime records the player reads one by one: combo-tier HUD geometry and the band's intro. */
function packedSources(assets: HaneokaChartAssets, band: number): HaneokaChartAssetSource[] {
  const sources = Object.values(assets.sources);
  const combo = sources.filter((source) => COMBO_TIERS.some((name) => source.sourcePath.endsWith(`/${name}`)));
  if (assets.sources[director(band)]?.runtimeProjectionPolicy !== "live-intro-data-v4") return combo;
  const prefix = timeline(band);
  const intro = sources.filter(
    ({ sourcePath }) =>
      (sourcePath.startsWith(prefix) && !sourcePath.includes("/", prefix.length)) || INTRO_SHARED.has(sourcePath),
  );
  return [...combo, ...intro];
}

function writeOrVerify(relative: string, body: Buffer): void {
  const file = path.join(generatedRoot(), relative);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(body)) throw new Error(`Playback data differs from the frozen build: ${relative}`);
    return;
  }
  if (process.env.STATIC_BUILD_INPUT_MODE === "frozen") throw new Error(`Frozen playback data is missing: ${relative}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, body, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function bandPack(
  release: StaticCatalogRelease,
  band: number,
  directory: string,
): Promise<ChartPlaybackPack | undefined> {
  const assets = await bandAssets(release, band);
  const paths = [
    ...new Set(
      packedSources(assets, band).flatMap((source) =>
        source.runtimeObjects.flatMap((entry) => (entry.path.startsWith("runtime/unity-json/") ? [entry.path] : [])),
      ),
    ),
  ].sort();
  if (!paths.length) return undefined;
  const values = await Promise.all(paths.map((relative) => runtimeJson(relative, release)));
  const body = Buffer.from(
    JSON.stringify({
      schema: CHART_PLAYBACK_DATA_SCHEMA,
      identity: { server: release.server, releaseId: release.releaseId, sourceId: release.sourceId },
      band,
      records: Object.fromEntries(paths.map((relative, index) => [relative, values[index]])),
    }),
  );
  const digest = sha256(body);
  const name = `${directory}/band-${band}.${digest.slice(0, 20)}.json`;
  writeOrVerify(name, body);
  return { url: `/${name}`, sha256: digest, bytes: body.length, records: paths.length };
}

async function produce(server: string): Promise<ChartPlaybackData> {
  const release = await staticCatalogRelease(server);
  const directory = `playback-data/v1/${release.server}/${release.releaseId}`;
  const { files } = await bandAssets(release, 0);
  const bands = [
    0,
    ...files.flatMap((file) => {
      const match = /^Assets\/AddressableResources\/Band\/([1-9]\d*)\/timeline\/live_start_playable_timeline\.prefab$/u.exec(file);
      return match ? [Number(match[1])] : [];
    }),
  ].sort((a, b) => a - b);
  const packs = await Promise.all(bands.map((band) => bandPack(release, band, directory)));
  const data: ChartPlaybackData = {
    schema: CHART_PLAYBACK_DATA_SCHEMA,
    server: release.server,
    releaseId: release.releaseId,
    sourceId: release.sourceId,
    packs: Object.fromEntries(bands.flatMap((band, index) => (packs[index] ? [[String(band), packs[index]]] : []))),
  };
  writeOrVerify(`${directory}/manifest.json`, Buffer.from(`${JSON.stringify(data, null, 2)}\n`));
  return data;
}

const produced = new Map<string, Promise<ChartPlaybackData>>();
/** One producer run per server and process; prepare writes the packs, frozen renders verify them. */
export function chartPlaybackData(server: string): Promise<ChartPlaybackData> {
  let pending = produced.get(server);
  if (!pending) {
    pending = produce(server);
    produced.set(server, pending);
    pending.catch(() => produced.delete(server));
  }
  return pending;
}
