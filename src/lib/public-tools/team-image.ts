// L3 — GEB
// Input: 实际引擎请求、命中结果、页面设置与固定目录身份。
// Output: 与配队页面相同结果卡片和站点标识的 PNG。
// Pos: [Map](../L2-2.md)；公开图片 API 到配队页面视图的适配。
// Effects/Dependencies: 读取目录／语言／素材，渲染真实结果模板并调用网页 DOM 导出；不连接 Box 或运行搜索。
import { render } from "lit";
import type { Locale } from "@haneoka/i18n";
import type { TeamImageOptions } from "./image-contract";
import type { TeamBuilderData } from "../team-builder/data";
import { compileFromTeamData } from "../team-builder/engine/master";
import { readBox, memberKey, snapKey } from "../team-builder/sync/box-view";
import { fetchCatalogVisuals } from "../catalog-visuals";
import { initializeI18nClient } from "../../i18n/client";
import { extractNamespace, type MainI18nNamespace } from "../../i18n/namespaces";
import type { MessageCatalog } from "@haneoka/i18n";
import { Catalog } from "../../lit/team-builder/catalog";
import { DEFAULT_SETTINGS } from "../../lit/team-builder/types";
import { manualEventFromEffects } from "../team-builder/manual-event";
import { renderHit, resultImageDecorator } from "../../lit/team-builder/results";
import { renderTeamResultImage } from "../../lit/shared/team-result-image";

export async function renderTeamImage(input: TeamImageOptions, options: { apiBase: string; locale: Locale; signal: AbortSignal }) {
  const { apiBase, locale, signal } = options;
  const read = async (path: string) => {
    const response = await fetch(new URL(path, apiBase), { signal });
    if (!response.ok) throw new Error(`Team image resource HTTP ${response.status}`);
    return response.json();
  };
  const data: TeamBuilderData = input.catalog ?? await read(`team-builder/${input.server ?? "intl"}${input.release ? `?release=${encodeURIComponent(input.release)}` : ""}`);
  const languages = new Map<string, Promise<MessageCatalog>>();
  const i18n = initializeI18nClient({ namespaces: ["common", "catalog", "teamBuilder"], load: async (language, namespace) => {
    if (!languages.has(language)) languages.set(language, read(`/i18n/${language}.json`));
    return extractNamespace(await languages.get(language)!, namespace as MainI18nNamespace);
  } });
  await i18n.requestLocale(locale, ["common", "catalog", "teamBuilder"]);
  const { TeamBuilder } = await import("../../lit/team-builder");
  const host = new TeamBuilder();
  host.locale = locale; host.server = data.identity.server;
  host.data = data; host.master = compileFromTeamData(data); host.catalog = new Catalog(host, data, host.master);
  host.catalog.setVisuals(await fetchCatalogVisuals(data.identity, signal, true, false, apiBase));
  host.view = readBox({});
  const goal = input.request.goal;
  host.settings = {
    ...DEFAULT_SETTINGS, goal: goal.kind, unknownPolicy: input.request.unknownPolicy,
    ...("criterion" in goal ? { criterion: goal.criterion } : {}),
    ...("songs" in goal ? { songs: goal.songs } : goal.kind === "power" && goal.song ? { songs: [goal.song] } : {}),
    ...(goal.kind === "score" && goal.target ? { scoreTarget: goal.target.kind, targetRank: "rank" in goal.target ? goal.target.rank : null,
      targetScore: "score" in goal.target ? goal.target.score : null } : {}),
    ...(goal.kind === "event" ? { eventId: goal.eventId, route: goal.route, measure: goal.measure, boosts: goal.consumption, challengePoints: goal.consumption, weighted: !!goal.weights, weightPoints: goal.weights?.points ?? 1, weightItems: goal.weights?.items ?? 0, weightCp: goal.weights?.challengePoints ?? 0 } : {}),
    ...(goal.kind === "event" && goal.eventEffects !== undefined ? { manualEventEnabled: true, manualEvent: manualEventFromEffects(goal.eventId, goal.eventEffects) } : {}),
    ...(goal.kind === "plan" ? { eventId: goal.eventId, planBudget: goal.boostBudget, planStartingCp: goal.startingChallengePoints, planBoostsPerLive: goal.boostsPerLive, challengePoints: goal.challengePointsPerLive, songs: goal.normalSongs, planChallengeSongs: goal.challengeSongs } : {}),
    ...input.settings,
  };
  host.resultSettings = host.settings;
  const members = input.hit.members.map(key => {
    const row = input.request.members.find(row => row.key === key);
    if (!row) throw new TypeError("Unknown member key in hit");
    return { ...row, key: memberKey(row.cardId) };
  });
  const snaps = input.hit.snaps.map(key => {
    if (key === null) return null;
    const row = input.request.snaps.find(row => row.key === key);
    if (!row) throw new TypeError("Unknown Snapshot key in hit");
    return { ...row, key: snapKey(row.cardId) };
  });
  host.resultInputs = { ...input.request, members, snaps: snaps.filter(row => row !== null) };
  const hit = { ...input.hit, members: members.map(row => row.key), snaps: snaps.map(row => row?.key ?? null) };
  const style = document.createElement("link"); style.rel = "stylesheet"; style.crossOrigin = "anonymous";
  style.href = new URL("/tools/team-image.css", apiBase).href;
  const root = document.createElement("div"); root.className = "team-builder tb"; root.lang = locale;
  root.style.width = `${input.width ?? Math.min(960, document.documentElement.clientWidth)}px`;
  document.body.append(root);
  try {
    await new Promise<void>((resolve, reject) => { style.onload = () => resolve(); style.onerror = () => reject(new Error("Team image stylesheet unavailable")); document.head.append(style); });
    render(renderHit(host, hit, 0), root);
    root.querySelectorAll(".card-growth").forEach(overlay => overlay.remove());
    for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
      const source = image.dataset.src || image.getAttribute("src");
      if (!source) continue;
      const url = new URL(source, apiBase);
      const server = /^\/(?:assets|runtime)\/([^/]+)\//u.exec(url.pathname)?.[1];
      const identity = server === data.identity.server ? data.identity : server ? data.crossServer?.identities[server] : undefined;
      if (identity) url.searchParams.set("release", identity.releaseId);
      image.crossOrigin = "anonymous"; image.loading = "eager"; image.srcset = ""; image.src = url.href;
      await image.decode();
      image.removeAttribute("data-src"); image.removeAttribute("data-loading");
      image.classList.add("is-loaded"); image.style.transition = "none";
    }
    for (const use of root.querySelectorAll<SVGUseElement>("svg use")) use.setAttribute("href", new URL(use.getAttribute("href")!, apiBase).href);
    return await renderTeamResultImage(root.querySelector<HTMLElement>(".tb-hit")!, { assetsBase: apiBase, decorate: resultImageDecorator(host, hit, apiBase) });
  } finally { render(null, root); root.remove(); style.remove(); }
}
