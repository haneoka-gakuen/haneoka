// L3 — GEB
// Input: Chart theme, skin settings and the host's release-pinned resource loader.
// Output: Native rendering manifest from the public chart-assets projection.
// Pos: [Map](../../L2.md); Haneoka's public native-stage resource adapter.
// Effects/Dependencies: Reads one public metadata payload; resolves media using exact atlas/font outputs without source browsing.
import type { ChartThemeContext } from "./types.js";
import { HANEOKA_CHART_ASSETS_PROJECTION, type HaneokaChartAssets } from "@haneoka/api-client/haneoka";

interface Descriptor {
  outputs?: readonly { readonly type: string; readonly path: string }[];
}
export async function createNativeTheme(
  context: ChartThemeContext & { apiBase: URL; publicBase: URL; server: string },
) {
  const { createOurNotesAssetManifest } = await import("@haneoka/cassiopeia-plugin-our-notes");
  context.signal.throwIfAborted();
  const server = encodeURIComponent(context.server);
  const read = async (url: URL): Promise<unknown> =>
    JSON.parse(new TextDecoder().decode(await context.loader.resourceBytes(url.href, { signal: context.signal })));
  const assetUrl = new URL(`servers/${server}/chart-assets`, context.apiBase);
  assetUrl.searchParams.set("projection", String(HANEOKA_CHART_ASSETS_PROJECTION));
  const projection = await read(assetUrl) as HaneokaChartAssets;
  const files = projection.files;
  const find = (suffix: string, scope = "") => {
    const matches = files.filter((path) => path.endsWith(`/${suffix}`) && path.includes(scope));
    if (matches.length !== 1) throw new Error(`Expected one source for ${suffix}, found ${matches.length}`);
    return matches[0]!;
  };
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  // source descriptors provide exact runtime output identities for atlas sprites and fonts.
  const descriptor = (source: string): Descriptor => projection.sources[source]!;
  const runtime = (path: string) =>
    new URL(`/runtime/${server}/${encodePath(path.replace(/^runtime\//u, ""))}`, context.publicBase).href;
  const asset = (path: string) => new URL(`/assets/${server}/${encodePath(path)}`, context.publicBase).href;
  const live = descriptor(find("LiveAtlas.spriteatlasv2"));
  const font = descriptor(find("VibeMOPro-Medium SDF.asset"));
  const output = (data: Descriptor, type: string, name?: string) => {
    const matches = (data.outputs ?? []).filter(
      (entry) => entry.type === type && (!name || entry.path.split("/").at(-1)?.startsWith(`${name}--${type}-`)),
    );
    if (matches.length !== 1) throw new Error(`Expected one ${type} ${name ?? ""} output`);
    return runtime(matches[0]!.path);
  };
  const hudSprite = (name: string) => output(live, "Sprite", name);
  const combo = (name: string) => asset(find(`${name}.png`, "/LiveComboAtlas/"));
  const fontPath = find("VibeMOPro-Medium SDF.asset");
  const manifest = createOurNotesAssetManifest(
    {
      ...context.skin,
      gekisouLaneAvailable: files.some((path) => path.endsWith("/lane_tap_excellenet_view.prefab")),
      currentQuality: context.skin.currentQuality ?? 0,
      fontAtlasTextureUrl: output(font, "Texture2D"),
      hud: {
        judgementImages: Object.fromEntries(
          ["just", "perfect", "great", "good", "bad", "miss", "fast", "late"].map((name) => [
            name,
            asset(find(`judgment_${name}.png`, "/JudgementAtlas/")),
          ]),
        ) as Record<"just" | "perfect" | "great" | "good" | "bad" | "miss" | "fast" | "late", string>,
        comboLabelUrl: combo("SP_combo_normal"),
        comboDigitUrls: Array.from({ length: 10 }, (_, i) => combo(`SP_combo_normal_${i}`)),
        perfectComboLabelUrl: combo("SP_combo_perfect"),
        perfectComboDigitUrls: Array.from({ length: 10 }, (_, i) => combo(`SP_combo_perfect_${i}`)),
        pauseIconUrl: hudSprite("IconPause_ingame"),
        pauseFrameUrl: hudSprite("FrameNormalButton_H80_ingame"),
        pauseShadowUrl: hudSprite("FrameNormalButton_H80_Shadow_ingame"),
        lifeIconUrls: {
          normal: hudSprite("SP_ingame_icon_life"),
          danger: hudSprite("SP_ingame_icon_life_danger_0"),
          over: hudSprite("SP_ingame_icon_life_over_0"),
        },
        rankIconUrls: Object.fromEntries(
          ["D", "C", "B", "A", "S", "SS"].map((rank) => [
            rank,
            asset(find(`scorerank_${rank.toLowerCase()}_ingame.png`)),
          ]),
        ) as Record<"D" | "C" | "B" | "A" | "S" | "SS", string>,
        rankBaseUrl: hudSprite("SP_ingame_header_rankbase"),
        roundMask14Url: hudSprite("CircleBase14px_Mask_ingame"),
        statusBaseUrl: hudSprite("circle_ingame_half"),
        scoreStarUrl: hudSprite("star_ingame"),
        whiteSpriteUrl: hudSprite("live_game_white"),
      },
    },
    {
      asset: (path) => {
        if (files.includes(path)) return asset(path);
        const scope = path.includes("/NoteEffect/")
          ? "/NoteEffect/"
          : path.includes("/LiveGame/Effect/")
            ? "/LaneEffect/"
            : "";
        return asset(find(path.split("/").at(-1)!, scope));
      },
      runtime: (path) => {
        const marker = "unity-json/";
        if (!path.startsWith(marker)) return runtime(path);
        const slash = path.lastIndexOf("/");
        const source = path.slice(marker.length, slash);
        const leaf = path.slice(slash + 1);
        const current = files.includes(source) ? source : find(source.split("/").at(-1)!);
        return runtime(`${marker}${current}/${leaf}`);
      },
    },
  );
  // Font metadata is keyed by the exact descriptor source, matching its atlas output.
  if (manifest.tmpSdfFont) manifest.tmpSdfFont.metadataUrl = runtime(`unity-json/${fontPath}/MonoBehaviour.json`);
  return manifest;
}
