// L3 — GEB
// Input: 冻结的自动／手动配队请求、结果、设置、已存编队槽位与目录。
// Output: 排名卡片、结果／已存队伍共用编队、评分详情、所选技能顺序与导出上下文。
// Pos: [Map](../L2-2.md)；配队结果视图与网页／API 图片共同的展示逻辑。
// Effects/Dependencies: 按请求隔离后台时间线缓存；判定时序在展开时单独计算，顺序列表按需挂载，导出沿用原结果的歌曲及成绩。
import { missionMemberCounts } from "../../lib/team-builder/constraint-feasibility";
import { rewardRankingLabel, rewardLabel } from "./reward-plan-view";
import { cache } from "lit/directives/cache.js";
import { resultMetric } from "./result-metric";
import { repeat } from "lit/directives/repeat.js";
import { actionMenu } from "../ui/action-menu";
import { improvementPercent } from "../../lib/team-builder/engine/execution";
/** Search results: ranked team cards, per-song rankings, plan summary, comparison. */
import { html, nothing, render, type TemplateResult } from "lit";
import type { EngineHit, OrderTiming, SongRef, Timeline, TimingWindow } from "../../lib/team-builder/engine/api";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";
import { downloadBlob } from "../../lib/canvas-capture";
import { accordion } from "../ui/accordion";
import { collectionList } from "../ui/collection-view";
import { skillTimeline } from "../shared/skill-timeline";
import { ORDERS } from "../../lib/team-builder/engine/order-equivalence";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import type { CardGrowth } from "../shared/card-growth";
import { songPerformerAdornment } from "../shared/song-performer-adornment";
import { sectionHeading } from "./catalog";
import { renderChecklist } from "./tool-layout";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { resultRequest, resultSettings, usesPtResults, scoreGoal, scoreProof, manualResultSource, resultOrderIndex, setResultOrder } from "./score-goal";
import { resolveBox } from "../../lib/team-builder/engine/box";
import { effectPercent, resolveSlotSkill } from "../../lib/team-builder/engine/skills";
import { memberEventPercent, snapEventPercent } from "../../lib/team-builder/engine/power";
import { entityHref, resourceCollectionHref } from "../../lib/resource-route";
import type { ReleaseServer } from "../../lib/release-server";
import type { Locale } from "../../i18n/locales";
import { roomRequiredScore, teamPowerNeeded } from "../../lib/chart-rates";
import { specList } from "../ui/spec";
import { dataRows } from "../../lib/team-builder/data";
import "../runtime/timing-chart-preview";

const RANK_NAMES: Record<string, string> = { "1": "E", "2": "D", "3": "C", "4": "B", "5": "A", "6": "S", "7": "SS" };
export function justWindowValue(host: TeamBuilder, window: NonNullable<EngineHit["justWindow"]>): TemplateResult {
  const before = format(host, window.beforeMs, 2), after = format(host, window.afterMs, 2);
  return html`<span class="cluster"><span class="tabular">${before === after ? `±${before} ms` : `−${before} / +${after} ms`}</span>
    ${window.meetsTarget ? nothing : html`<span class="chip">${host.t("justWindowUnmet", "Below the desired window")}</span>`}</span>`;
}
const resultInputs = resultRequest;
function growthPolicyLabel(host: TeamBuilder, settings: BuildSettings): string {
  const input = resultInputs(host);
  if (!input) return "—";
  if (settings.goal === "event" && (settings.rewardMode === "recommendation" || settings.farming.requireGrowth))
    return host.t("farm.requireGrowth", "Complete growth first");
  return input.unknownPolicy === "max"
    ? host.t("unknownMax", "Count as max")
    : host.t("unknownMin", "Count as minimum");
}
function conditionLines(host: TeamBuilder, hit: EngineHit): string[] {
  const s = resultSettings(host, hit),
    input = resultInputs(host, hit);
  const source = hit.song ? host.catalog!.songIdentity(hit.song.songId) : host.catalog!.data.identity;
  return [
    source.server.toUpperCase(),
    ...((usesPtResults(host) ? host.pt.stale : host.stale) ? [host.t("stale", "Conditions changed")] : []),
    `${host.t("unknownPolicy", "Growth")}: ${growthPolicyLabel(host, s)}`,
    `${host.t("scope", "Cards")}: ${s.scope === "theoretical" ? host.t("scopeAll", "All cards, full growth") : host.t("scopeBox", "My cards")}`,
    `${host.t("goal", "Goal")}: ${primary(host, hit).label}`,
    ...(s.goal === "event" || s.goal === "plan"
      ? [
          `${host.t("farm.memory", "Character / song memory bonuses")}: ${s.goal === "plan" || (s.farming.includeMemory && s.rewardMode !== "recommendation") ? host.t("farm.included", "Included") : host.t("farm.excluded", "Excluded")}`,
        ]
      : []),
    ...(hit.event?.rewardPlan ? [
      `${host.t("rewardPlan.order", "Ranking")}: ${rewardRankingLabel(host, hit.event.rewardPlan)}`,
      ...Object.entries(hit.event.rewardValues ?? {}).map(([metric, value]) => `${rewardLabel(host, metric as "points" | "items" | "challenge-points")}: ${format(host, value.value, 4)}`),
    ] : []),
    ...(input?.goal.kind === "event" && input.goal.weights
      ? [
          `${host.t("weightPoints", "Weight per event point")}: ${input.goal.weights.points} / ${host.t("weightItems", "Weight per shop item")}: ${input.goal.weights.items} / ${host.t("weightCp", "Weight per challenge point")}: ${input.goal.weights.challengePoints}`,
        ]
      : []),
    ...(input?.goal.kind === "event" && input.goal.gekiso && input.goal.rewardRoom ? [
      input.goal.rewardRoom.mode === "solo" ? host.t("rewardPlan.solo", "Solo Mission")
        : `${host.t("rewardPlan.battle", "Multiplayer")} / ${host.t("rewardPlan.players", "Players")}: ${input.goal.rewardRoom.players} / ${host.t("rewardPlan.otherScore", "Other players’ average score")}: ${input.goal.rewardRoom.otherAverageScore === undefined ? host.t("rewardPlan.equalScore", "Same score as you") : format(host, input.goal.rewardRoom.otherAverageScore)}`,
    ] : []),
    ...(input?.goal.kind === "score" && input.goal.target
      ? [`${host.t("targetScore", "Target score")}: ${format(host, input.goal.target.score)}`]
      : []),
    ...(input && "play" in input.goal
      ? [
          Object.entries(input.goal.play)
            .map(([key, value]) =>
              key === "cumulativeTiming"
                ? host.t(value === "best" ? "criterionMaxBestTiming" : "criterionMaxWorstTiming", value === "best" ? "Maximum score · best timing" : "Maximum score · worst timing")
                : key === "frameRate"
                ? `${host.t("frameRate", "Game frame rate (FPS)")}: ${value}`
                : key === "missEvery"
                ? `${host.t("missEvery", "Miss every N notes")}: ${value}`
                : `${key.toUpperCase()} ${format(host, value * 100, 2)}%`,
            )
            .join(" / "),
        ]
      : []),
    ...(input?.goal.kind === "gekiso"
      ? [
          `GREAT ${format(host, input.goal.accuracy.great * 100, 2)}% / JUST ${format(host, input.goal.accuracy.just * 100, 2)}% / ${host.t("missEvery", "Miss every N notes")}: ${input.goal.accuracy.missEvery ?? 0}`,
          input.goal.seeds === 0 ? `${host.t("pt.luckSampling", "LUCK calculation")}: ${host.t("luckExpectation", "Probability expectation")}`
            : `${host.t("luckSimulationCount", "Simulation runs")}: ${input.goal.seeds}`,
          `${host.t("gekisoPlacements", "Scoring placements")}: ${input.goal.opponents ? (host.results?.results.find((result) => result.hits.includes(hit))?.placements?.join(" / ") ?? "—") : input.goal.ranks?.join(" / ") ?? input.goal.rank}`,
        ]
      : input?.goal.kind === "event" && input.goal.gekiso && s.route !== "challenge"
        ? [
            `JUST ${format(host, input.goal.gekiso.just * 100, 2)}% / ${host.t("gekisoPlacements", "Scoring placements")}: 1`,
            `${host.t("pt.luckSamples", "Luck samples")}: ${input.goal.gekiso.luckSamples}`,
          ]
        : []),
    ...((s.goal === "event" || s.goal === "plan") && s.eventId !== null
      ? [
          `${s.manualEventEnabled ? host.t("manualEvent.summary", "Manual / Rules") : host.t("event", "Event")}: ${host.catalog!.events().find((event) => event.id === s.eventId)?.name ?? s.eventId}`,
          s.route === "challenge"
            ? host.t("routeChallenge", "Challenge live")
            : s.route === "skip"
              ? host.t("routeSkip", "Skip")
              : host.t("routeLive", "Normal live"),
        ]
      : []),
    ...(s.goal === "event" && s.manualEventEnabled
      ? [
          host.t("manualEvent.attribute", "Bonus attribute") + ": " + (s.manualEvent.attributes?.length ? s.manualEvent.attributes.map(id => host.catalog!.attributeName(id)).join(" / ") : host.t("manualEvent.none", "None")),
          host.t("manualEvent.targets", "Bonus targets") + ": " + (s.manualEvent.targetKind === "none" ? host.t("manualEvent.none", "None") : s.manualEvent.targets.map(id => s.manualEvent.targetKind === "band" ? host.catalog!.bandName(id) : host.catalog!.characterName(id)).join(" / ")),
          ...(["members", "snaps"] as const).flatMap(kind => s.manualEvent[kind].map(row =>
            host.catalog!.cardName(kind, row.cardId) + " / " + JSON.parse(row.tier).filter((effect: [number, number[]]) => effect[0] !== 2).map((effect: [number, number[]]) =>
              host.t(effect[0] === 0 ? "measurePoints" : "measureItems", effect[0] === 0 ? "Event points" : "Shop items") + " +" + effect[1].map(value => value / 100).join("/") + "%").join(" / "))),
        ] : []),
    ...(s.goal === "plan"
      ? [
          `${host.t("planBudget", "Boosts to spend")}: ${s.planBudget} / ${host.t("planStartCp", "Challenge points now")}: ${s.planStartingCp}`,
        ]
      : []),
    ...(s.goal === "event" || s.goal === "plan"
      ? [`${s.route === "challenge" ? "CP" : "Boost"}: ${s.route === "challenge" ? s.challengePoints : s.boosts}`]
      : []),
  ];
}

export function resultSong(host: TeamBuilder, song: SongRef, rule: { musicType?: number } | null = resultSettings(host).arena ?? resultInputs(host)?.songRules ?? null): TemplateResult {
  const catalog = host.catalog!;
  const attribute = rule?.musicType || Number(catalog.song(song.songId).musicType);
  const attributeIcon = catalog.attributeIcon(attribute);
  const title = catalog.songTitle(song.songId);
  const href = entityHref({
    server: catalog.songIdentity(song.songId).server,
    locale: host.locale as Locale,
    kind: "songs",
    id: String(song.songId),
  });
  return html`
    <div class="tb-result-song">
      <a class="tb-result-song__cover" href=${href} aria-label=${title}>
        ${tileMedia({ ...catalog.songOptions(song.songId, song.difficulty), marks: [], serverMark: undefined })}
      </a>
      <div class="stack stack--tight">
        <div class="row tb-result-song__heading">
          ${
          attributeIcon
            ? html`
                <img
                  class="tb-result-song__attribute"
                  src=${attributeIcon}
                  width="24"
                  height="24"
                  alt=${catalog.attributeName(attribute)}
                  title=${catalog.attributeName(attribute)}
                  decoding="async"
                />
              `
            : nothing
        }
          <a href=${href}>${title}</a>
        </div>
        <div class="cluster tb-result-song__meta">
          <span class="supporting-text">${catalog.difficultyLabel(song.songId, song.difficulty)}</span>
          <span class="row tb-result-song__band">
            ${songPerformerAdornment(catalog.songPerformer(song.songId))}
            <span>${catalog.songArtist(song.songId)}</span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function resultGrowth(host: TeamBuilder, kind: "members" | "snaps", key: string) {
  const source = resultInputs(host);
  const input =
    kind === "members" ? source?.members.find((row) => row.key === key) : source?.snaps.find((row) => row.key === key);
  return input && source ? host.catalog!.resolvedGrowth(kind, input, source.unknownPolicy) : null;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function format(host: TeamBuilder, value: number, digits = 0) {
  const key = `${host.locale}:${digits}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits });
    numberFormats.set(key, formatter);
  }
  return formatter.format(value);
}

function eventBonusDetails(host: TeamBuilder, hit: EngineHit): TemplateResult | typeof nothing {
  if (!hit.event) return nothing;
  const input = resultInputs(host, hit), master = host.master;
  let bonuses: [number, number] | null = null;
  if (input && master && (input.goal.kind === "event" || input.goal.kind === "plan")) {
    const effects = (input.goal.kind === "event" ? input.goal.eventEffects : undefined)
      ?? master.events.get(input.goal.eventId)?.effects;
    const snapKeys = hit.snaps.filter((key): key is string => key !== null);
    const box = resolveBox(master,
      input.members.filter((row) => hit.members.includes(row.key)),
      input.snaps.filter((row) => snapKeys.includes(row.key)), input.unknownPolicy);
    if (effects && box.members.length === hit.members.length && box.snaps.length === snapKeys.length)
      bonuses = [0, 1].map((type) => (
        box.members.reduce((sum, member) => sum + memberEventPercent(effects, member, type), 0)
        + box.snaps.reduce((sum, snap) => sum + snapEventPercent(effects, snap, type), 0)
      ) / 100) as [number, number];
  }
  return html`
    <dl class="spec-list spec-list--split spec-list--numeric">
      ${[host.t("pointsBonus", "Point bonus"), host.t("itemsBonus", "Item bonus")].map((label, index) => html`
        <div>
          <dt>${label}</dt>
          <dd>${bonuses ? `${bonuses[index]! >= 0 ? "+" : ""}${format(host, bonuses[index]!, Number.isInteger(bonuses[index]) ? 0 : 2)}%` : "—"}</dd>
        </div>
      `)}
    </dl>
  `;
}

const hitKey = (hit: EngineHit) =>
  `${hit.song ? `${hit.song.songId}:${hit.song.difficulty}` : "-"}|${hit.members.join(",")}|${hit.snaps.join(",")}`;

/** Points and items per play of a weighted-reward hit: the measure is points unless only items carry weight. */
function eventRewards(s: BuildSettings, event: NonNullable<EngineHit["event"]>) {
  const direct = event.directMean ?? event.mean,
    other = event.otherMean ?? 0;
  return s.weightPoints > 0 ? { points: direct, items: other } : { points: other, items: direct };
}

function primary(host: TeamBuilder, hit: EngineHit): { label: string; value: string; unit?: string } {
  const metric = resultMetric(host, hit, resultSettings(host, hit));
  return {
    label: metric.label,
    value: `${format(host, metric.value, metric.digits)}${metric.unit ? ` ${metric.unit}` : ""}`,
  };
}

function chips(host: TeamBuilder, hit: EngineHit, compact = false): TemplateResult[] {
  const s = resultSettings(host, hit);
  const bonusLabel = s.weighted
    ? s.weightPoints > 0
      ? host.t("pointsBonus", "Point bonus")
      : host.t("itemsBonus", "Item bonus")
    : s.measure === "items"
      ? host.t("itemsBonus", "Item bonus")
      : host.t("pointsBonus", "Point bonus");
  const out: TemplateResult[] = [];
  let rankLabel: string | undefined;
  const labels = new Map<TemplateResult, string>();
  const chip = (label: string, value: string | TemplateResult, leading?: TemplateResult) => {
    const result = html`
      <span class="tb-chip">
        ${leading ?? nothing}
        <span class="tb-chip__label">${label}</span>
        <strong class="tabular">${value}</strong>
      </span>
    `;
    labels.set(result, label);
    return result;
  };
  if (hit.aggregate)
    return [chip(host.t("arena.meanPower", "Average power"), format(host, hit.power), icon("bolt", 16))];
  if (s.goal !== "power") out.push(chip(host.t("power", "Power"), format(host, hit.power), icon("bolt", 16)));
  if (hit.score) {
    if ((s.goal !== "score" && s.goal !== "gekiso") || scoreGoal(s) !== "mean")
      out.push(chip(host.t("expectedScore", "Average score"), format(host, hit.score.mean)));
    out.push(
      chip(
        host.t("scoreRange", "Range"),
        html`
          <span class="tb-number">${format(host, hit.score.min)}</span>
          –
          <span class="tb-number">${format(host, hit.score.max)}</span>
        `,
      ),
    );
    const ranks = Object.entries(hit.score.ranks).sort((a, b) => Number(b[0]) - Number(a[0]));
    const top = ranks[0];
    if (top) {
      rankLabel = RANK_NAMES[top[0]] ?? top[0];
      out.push(
        chip(
          s.goal === "score" ? `${rankLabel} ${host.t("rankReachRate", "Clear rate")}` : rankLabel,
          `${format(host, (top[1] / Object.values(hit.score.ranks).reduce((sum, count) => sum + count, 0)) * 100, top[1] === Object.values(hit.score.ranks).reduce((sum, count) => sum + count, 0) ? 0 : 1)}%`,
          icon("workspace_premium", 16),
        ),
      );
    }
  }
  const request = resultRequest(host, hit);
  if (s.goal === "gekiso" && request && host.master) {
    const ids = new Map(request.members.map(member => [member.key, member.cardId]));
    const counts = missionMemberCounts(host.master, hit.members.map(key => ids.get(key)!).filter(id => id !== undefined));
    for (const [index, role] of [[0, "COMBO"], [2, "JUST"], [1, "LUCK"]] as const)
      out.push(chip(host.t("missionMemberCount", "{role} members", { role }), String(counts[index])));
  }
  if (hit.comboBonus != null)
    out.push(chip(host.t("comboBonus", "Base COMBO BONUS"), `×${format(host, hit.comboBonus)}`));
  if (hit.event?.rewardValues) {
    for (const [name, reward] of Object.entries(hit.event.rewardValues)) out.push(chip(rewardLabel(host, name as "points" | "items" | "challenge-points"), format(host, reward.value, 4)));
  } else if (hit.event) {
    if (!(
      s.goal === "event" &&
      ((s.measure === "challenge-points" && !s.weighted) || (s.weighted && s.weightPoints === 0 && s.weightItems === 0))
    ))
      out.push(chip(bonusLabel, `+${format(host, Math.floor(hit.event.bonusPercent), 0)}%`, icon("trending_up", 16)));
    if (s.goal === "event" && s.weighted && (s.weightPoints > 0 || s.weightItems > 0)) {
      const { points, items } = eventRewards(s, hit.event);
      out.push(chip(host.t("pointsPerPlay", "Event points per play"), format(host, points, 1)));
      out.push(chip(host.t("itemsPerPlay", "Items per play"), format(host, items, 1)));
    }
    if (
      (s.goal === "event" || s.goal === "plan") &&
      !s.weighted &&
      s.measure !== "challenge-points" &&
      hit.event.otherMean != null
    )
      out.push(
        chip(
          s.measure === "items"
            ? host.t("pointsPerPlay", "Event points per play")
            : host.t("itemsPerPlay", "Items per play"),
          format(host, hit.event.otherMean, 1),
        ),
      );
    if (hit.event.challengePoints && s.measure !== "challenge-points")
      out.push(chip(host.t("cpPerPlay", "Challenge points per play"), format(host, hit.event.challengePoints, 1)));
  }
  const placements =
    s.goal === "gekiso" && s.gekisoPlacementMode === "opponents"
      ? host.results?.results.find(
          (result) => result.song?.songId === hit.song?.songId && result.song?.difficulty === hit.song?.difficulty,
        )?.placements
      : undefined;
  if (placements)
    out.push(chip(host.t("gekisoPlacements", "Placements"), placements.join(" / "), icon("leaderboard", 16)));
  if (hit.skipScore !== null)
    out.push(chip(host.t("skipScore", "Skip score"), format(host, hit.skipScore), icon("fast_forward", 16)));
  if (hit.potential)
    out.push(chip(host.t("skillCoverage", "Skill coverage"), `${format(host, hit.potential.area * 100, 0)}%·s`));
  if (!compact) return out;
  const selected = hit.event?.rewardPlan
    ? ["PT", "CP", rewardLabel(host, "items")]
    : s.goal === "event" || s.goal === "plan"
      ? [
          s.measure === "items"
            ? host.t("pointsPerPlay", "Event points per play")
            : host.t("itemsPerPlay", "Items per play"),
          hit.comboBonus != null ? host.t("comboBonus", "Base COMBO BONUS") : bonusLabel,
          rankLabel ?? host.t("power", "Power"),
        ]
      : s.goal === "gekiso"
        ? [host.t("comboBonus", "Base COMBO BONUS"), host.t("gekisoPlacements", "Placements"), host.t("power", "Power")]
        : [
            host.t("power", "Power"),
            host.t("scoreRange", "Range"),
            ...(s.goal === "score" && rankLabel ? [`${rankLabel} ${host.t("rankReachRate", "Clear rate")}`] : []),
          ];
  return [
    ...selected.flatMap((label) => out.filter((item) => labels.get(item) === label)),
    ...out.filter((item) => !selected.includes(labels.get(item)!)),
  ].slice(0, 3);
}

interface FormationSlot {
  member: number;
  snap: number | null;
  memberGrowth?: CardGrowth | null;
  snapGrowth?: CardGrowth | null;
  title?: string;
  flag?: TemplateResult;
}

export function teamFormation(host: TeamBuilder, slots: readonly FormationSlot[], leader = 0): TemplateResult {
  const catalog = host.catalog!;
  const order = slots.map((_, index) => index).filter((index) => index !== leader);
  if (leader >= 0) order.splice(Math.min(2, order.length), 0, leader);
  return html`
    <ol class="tb-formation" aria-label=${host.t("formation", "Formation")}>
      ${order.map((index) => {
        const { member, snap, memberGrowth, snapGrowth, title, flag } = slots[index]!;
        const memberOptions = catalog.cardOptions("members", member, memberGrowth);
        const snapOptions = snap !== null ? catalog.cardOptions("snaps", snap, snapGrowth) : null;
        return html`
          <li
            class=${`tb-slot${index === leader ? " is-leader" : ""}`}
            aria-label=${index === leader ? host.t("leader", "Leader") : nothing}
            title=${title ?? catalog.characterName(catalog.member(member)?.characterId ?? 0)}
          >
            <button
              class="tb-slot__member"
              type="button"
              aria-label=${`${host.t("editGrowth", "Edit growth")}: ${memberOptions?.label ?? member}`}
              @click=${() => {
                host.editing = { kind: "members", cardId: member };
                host.requestUpdate();
              }}
            >
              ${memberOptions ? tileMedia(memberOptions) : nothing}
            </button>
            <button
              class="tb-slot__snap"
              type="button"
              ?disabled=${snap === null}
              aria-label=${snapOptions ? `${host.t("editGrowth", "Edit growth")}: ${snapOptions.label}` : host.t("noSnap", "No snap")}
              @click=${() => {
                if (snap !== null) {
                  host.editing = { kind: "snaps", cardId: snap };
                  host.requestUpdate();
                }
              }}
            >
              ${
                snapOptions
                  ? tileMedia(snapOptions)
                  : html`
                      <span class="tb-slot__empty"><small>${host.t("noSnap", "No snap")}</small></span>
                    `
              }
            </button>
            ${flag ?? nothing}
          </li>
        `;
      })}
    </ol>
  `;
}

export function formation(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const catalog = host.catalog!;
  return teamFormation(host, hit.members.map((key, index) => {
    const member = cardIdOf(key);
    const snapKey = hit.snaps[index];
    return {
      member,
      snap: snapKey ? cardIdOf(snapKey) : null,
      memberGrowth: resultGrowth(host, "members", key),
      snapGrowth: snapKey ? resultGrowth(host, "snaps", snapKey) : null,
      title: `${catalog.characterName(catalog.member(member)?.characterId ?? 0)} / ${host.t("slotPower", "Slot power")} ${format(host, hit.slotPowers[index] ?? 0)}`,
      flag: !host.view?.members.has(member) && resultSettings(host).scope === "theoretical"
        ? html`<span class="tb-slot__flag">${host.t("notOwned", "Not owned")}</span>` : undefined,
    };
  }));
}

function distribution(host: TeamBuilder, hit: EngineHit, chart: SongRef | null): TemplateResult {
  const score = hit.score;
  if (!score) return html``;
  const thresholds = chart
    ? (host.master?.scoreRanks.get(host.master.songs.get(chart.songId)?.rankGroup ?? 0) ?? [])
    : [];
  const low = Math.min(
    score.min,
    ...thresholds
      .filter((row) => row.required >= score.min * 0.9 && row.required <= score.max * 1.05)
      .map((row) => row.required),
  );
  const high = Math.max(
    score.max,
    ...thresholds
      .filter((row) => row.required <= score.max * 1.1 && row.required >= score.min)
      .map((row) => row.required),
  );
  const span = Math.max(1, high - low);
  const at = (value: number) => `${(((value - low) / span) * 100).toFixed(2)}%`;
  return html`
    <div
      class="tb-dist"
      role="img"
      aria-label=${`${host.t("scoreRange", "Range")}: ${format(host, score.min)} – ${format(host, score.max)}, ${host.t("median", "median")} ${format(host, score.median)}`}
    >
      <div class="tb-dist__track">
        <span
          class="tb-dist__range"
          style=${`inset-inline-start:${at(score.min)};inset-inline-end:calc(100% - ${at(score.max)})`}
        ></span>
        <span
          class="tb-dist__mark tb-dist__mark--median"
          style=${`inset-inline-start:${at(score.median)}`}
          title=${host.t("median", "median")}
        ></span>
        <span
          class="tb-dist__mark tb-dist__mark--mean"
          style=${`inset-inline-start:${at(score.mean)}`}
          title=${host.t("mean", "mean")}
        ></span>
        ${thresholds
          .filter((row) => row.required > low && row.required < high)
          .map(
            (row) => html`
              <span class="tb-dist__threshold" style=${`inset-inline-start:${at(row.required)}`}>
                <small>${RANK_NAMES[String(row.rank)]}</small>
              </span>
            `,
          )}
      </div>
      <div class="row row--between tb-dist__labels tabular">
        <span>${format(host, score.min)}</span>
        <span>${host.t("median", "median")} ${format(host, score.median)}</span>
        <span>${format(host, score.max)}</span>
      </div>
      <div class="cluster">
        ${Object.entries(score.ranks)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(
            ([rank, count]) => html`
              <span class="tb-chip">
                <span class="tb-chip__label">${RANK_NAMES[rank] ?? rank}</span>
                <strong class="tabular">
                  ${format(host, (count / Object.values(score.ranks).reduce((sum, value) => sum + value, 0)) * 100, count === Object.values(score.ranks).reduce((sum, value) => sum + value, 0) ? 0 : 1)}%
                </strong>
              </span>
            `,
          )}
      </div>
    </div>
  `;
}

/** The power this team needs for each score rank, from its exact score in every skill order (scores scale with
 * power): solo in Live; in Gekisou per room size, every player scoring alike, at the engine's expected luck. */
function powerNeeded(host: TeamBuilder, hit: EngineHit, chart: SongRef | null): TemplateResult {
  const score = hit.score;
  const song = chart ? host.master?.songs.get(chart.songId) : undefined;
  if (!score?.orders.length || !song || !hit.power) return html``;
  const notes = song.difficulties.find((row) => row.difficulty === chart!.difficulty)?.noteCount ?? 0;
  const ranks = (host.master?.scoreRanks.get(song.rankGroup) ?? [])
    .filter((row) => row.rank >= 3)
    .sort((a, b) => b.rank - a.rank);
  if (!ranks.length) return html``;
  const need = (target: number) => teamPowerNeeded(target, score.orders, hit.power, notes);
  const gekisou = resultSettings(host, hit).goal === "gekiso";
  const players = [1, 2, 3, 4, 5];
  return html`
    <div
      class="table-scroll"
      role="region"
      tabindex="0"
      aria-label=${host.t("powerNeeded", "Power needed")}
      data-scroll-region
    >
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">${host.t("powerNeeded", "Power needed")}</th>
            ${
              gekisou
                ? players.map(
                    (count) => html`
                      <th scope="col" class="is-numeric">
                        ${(count === 1 ? host.t("roomPlayer", "1 player") : host.t("roomPlayers", "{count} players")).replace("{count}", String(count))}
                      </th>
                    `,
                  )
                : html`
                    <th scope="col" class="is-numeric">${host.t("averageOrder", "Average of the orders")}</th>
                    <th scope="col" class="is-numeric">${host.t("everyOrder", "Every order")}</th>
                    <th scope="col" class="is-numeric">${host.t("bestOrder", "Best order")}</th>
                  `
            }
          </tr>
        </thead>
        <tbody>
          ${ranks.map(
            (row) => html`
              <tr>
                <th scope="row">${RANK_NAMES[String(row.rank)]}</th>
                ${
                  gekisou
                    ? players.map(
                        (count) => html`
                          <td class="is-numeric tabular">
                            ${format(host, need(Math.ceil(roomRequiredScore(row.battleRequired, count) / count)).mean)}
                          </td>
                        `,
                      )
                    : (() => {
                        const value = need(row.required);
                        return html`
                          <td class="is-numeric tabular">${format(host, value.mean)}</td>
                          <td class="is-numeric tabular">${format(host, value.every)}</td>
                          <td class="is-numeric tabular">${format(host, value.best)}</td>
                        `;
                      })()
                }
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

const ORDER_INDEX = new Map(ORDERS.map((order, index) => [order.join(","), index]));
interface DetailState {
  id: number;
  swapPick: Map<string, number>;
  firingOrder: Map<string, number[]>;
  shownTimeline: Map<string, Timeline>;
  timelines: Map<string, Timeline | "loading" | "error">;
}
const detailStates = new WeakMap<object, DetailState>();
let timelineEpoch = 0;
function detailState(host: TeamBuilder, hit: EngineHit): DetailState {
  const source = manualResultSource(hit)?.input ?? resultInputs(host) ?? host;
  let state = detailStates.get(source);
  if (!state) {
    state = { id: ++timelineEpoch, swapPick: new Map(), firingOrder: new Map(), shownTimeline: new Map(), timelines: new Map() };
    detailStates.set(source, state);
  }
  return state;
}
function timelineKey(host: TeamBuilder, hit: EngineHit) {
  return `${detailState(host, hit).id}|${resultSettings(host, hit).route}|${hitKey(hit)}`;
}

function orderTimeline(host: TeamBuilder, hit: EngineHit, index: number, withTiming = false) {
  const { timelines } = detailState(host, hit);
  const key = `${timelineKey(host, hit)}|${index}|${withTiming ? "timing" : "chart"}`;
  const value = timelines.get(key);
  if (value) return value;
  const request = resultInputs(host, hit);
  const engine = host.engine;
  if (request && engine && hit.song && !host.running && !host.manualBusy) {
    timelines.set(key, "loading");
    const current = () => host.isConnected && host.engine === engine;
    void engine
      .explain({
        songRules: request.songRules,
        ...(request.goal.kind === "gekiso" && request.goal.arena ? { arena: request.goal.arena } : {}),
        members: request.members,
        snaps: request.snaps,
        unknownPolicy: request.unknownPolicy,
        team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! },
        song: hit.song,
        eventOrder: ORDERS[index]!.map((slot) => hit.members[slot]!),
        play: "play" in request.goal ? request.goal.play : { great: 0, good: 0, bad: 0, miss: 0 },
        ...(withTiming && (request.goal.kind === "score" || request.goal.kind === "event")
          ? {
              timing: {
                player: request.player,
                play: request.goal.play,
                challengeEventId:
                  request.goal.kind === "score" ? request.goal.challengeEventId : request.goal.route === "challenge" ? request.goal.eventId : null,
              },
            }
          : {}),
      })
      .then((timeline) => {
        if (current()) timelines.set(key, timeline);
        else timelines.delete(key);
      })
      .catch((error: unknown) => {
        if (current() && !(error instanceof DOMException && error.name === "AbortError")) timelines.set(key, "error");
        else timelines.delete(key);
      })
      .finally(() => {
        if (current()) host.requestUpdate();
      });
  }
  return "loading" as const;
}

function memberFace(host: TeamBuilder, hit: EngineHit, slot: number) {
  const catalog = host.catalog!;
  const card = catalog.member(cardIdOf(hit.members[slot]!));
  const character = card?.characterId ?? 0;
  const image = card?.image || catalog.characterFace(character);
  return { character, name: catalog.characterName(character), card: image, color: catalog.characterColor(character) };
}

/** An order as numbered character faces in firing order. */
function orderFaces(host: TeamBuilder, hit: EngineHit, index: number, firing: readonly number[]) {
  const names = firing.map((event) => memberFace(host, hit, ORDERS[index]![event]!).name);
  return html`
    <ol class="tb-order-faces" aria-label=${names.map((name, position) => `${position + 1} ${name}`).join(", ")}>
      ${firing.map((event, position) => {
        const member = memberFace(host, hit, ORDERS[index]![event]!);
        return html`
          <li title=${`${position + 1} / ${member.name}`} style=${`--member-color:${member.color}`}>
            <img src=${host.catalog!.characterFace(member.character)} alt="" width="28" height="28" loading="lazy" decoding="async" />
            <span aria-hidden="true">${position + 1}</span>
          </li>
        `;
      })}
    </ol>
  `;
}

/** The order's score with the timed notes hit early. */
function timingRow(host: TeamBuilder, timing: OrderTiming | null | undefined, reserve = false, fallback?: number, advanceMs = 17) {
  if (!timing && !reserve) return nothing;
  const plain = timing === null ? fallback : undefined;
  const text = (value: number | undefined) => value === undefined ? "—" : format(host, value);
  const gain = timing ? timing.best - timing.score : timing === null ? 0 : undefined;
  return html`
    <div><dt>${host.t("worstTimingScore", "Worst-timing score")}</dt><dd>${text(timing?.worst ?? plain)}</dd></div>
    <div><dt>${host.t("nominalTimingScore", "Nominal-timing score")}</dt><dd>${text(timing?.score ?? plain)}</dd></div>
    <div><dt>${host.t("bestTimingScore", "Best-timing score")}</dt><dd>${text(timing?.optimal ?? plain)}</dd></div>
    <div>
      <dt>${host.t("timingFramePlanScore", "{ms} ms plan", { ms: timing?.advanceMs ?? advanceMs })}</dt>
      <dd>${text(timing?.best ?? plain)} <span class="tb-delta" data-sign=${gain === undefined ? "" : gain >= 0 ? "up" : "down"}>${gain === undefined ? " " : `${gain >= 0 ? "+" : ""}${format(host, gain)}`}</span></dd>
    </div>
  `;
}
const chartClock = (ms: number) => {
  const seconds = ms / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};
/** One counting window as a strip of its counted notes, the step notes marked, then the step list. */
function timingWindow(host: TeamBuilder, hit: EngineHit, order: number, window: TimingWindow, guideExpanded = true) {
  const member = memberFace(host, hit, ORDERS[order]![window.event]!);
  const span = Math.max(1, window.endMs - window.startMs);
  const at = (ms: number) => `${(((ms - window.startMs) / span) * 100).toFixed(2)}%`;
  const marked = new Set(window.steps.map((step) => step.timeMs));
  const previewKey = `${timelineKey(host, hit)}|timing|${order}|${window.event}`;
  const expanded = host.expanded.has(previewKey);
  const catalog = host.catalog!;
  const song = hit.song!;
  const difficulty = dataRows(catalog.data.songs[String(song.songId)]!.difficulty).find(row => Number(row.difficulty) === song.difficulty)!;
  return html`
    <li class="tb-timing__window" style=${`--member-color:${member.color}`}>
      <div class="tb-timing__head">
        <img src=${host.catalog!.characterFace(member.character)} alt="" width="28" height="28" loading="lazy" decoding="async" />
        <span>${member.name}</span>
        <span class="tabular">${chartClock(window.startMs)} – ${chartClock(window.endMs)}</span>
      </div>
      <div class="tb-timing__strip" role="img" aria-label=${window.steps.map((step) => `${host.t("timingStep", "Step {step}", { step: step.step })} ${chartClock(step.timeMs)}`).join(", ")}>
        ${[...new Set(window.notes)].map((ms) => marked.has(ms) ? nothing : html`<span class="tb-timing__note" style=${`inset-inline-start:${at(ms)}`}></span>`)}
        ${window.steps.map(
          (step) => html`
            <span class="tb-timing__step" data-row=${step.step % 2} style=${`inset-inline-start:${at(step.timeMs)}`}><b>${step.step}</b></span>
          `,
        )}
      </div>
      ${accordion({
        id: `tb-timing-${previewKey.replace(/[^a-z0-9]/giu, "-")}`,
        label: host.t("timingChart", "Chart excerpt"),
        expanded,
        onExpandedChange: (open) => {
          if (open) host.expanded.add(previewKey);
          else host.expanded.delete(previewKey);
          host.requestUpdate();
        },
        content: html`<timing-chart-preview
          .source=${{ identity: catalog.songIdentity(song.songId), file: difficulty.file as string }}
          .window=${window} .active=${expanded && guideExpanded} .locale=${host.locale}
          .label=${window.steps.map(step => `${host.t("timingStep", "Step {step}", { step: step.step })} ${chartClock(step.timeMs)}`).join(", ")}
          .errorLabel=${host.t("timingChartFailed", "Chart could not be loaded")}
        ></timing-chart-preview>`,
      })}
      <div class="scroll-x" role="region" tabindex="0" aria-label=${host.t("timingNotes", "Notes to hit early")} data-scroll-region>
      <table class="tb-timing__steps">
        <tbody>
          ${window.steps.map(
            (step) => html`
              <tr>
                <th scope="row"><span class="tb-timing__badge">${step.step}</span>${host.t("timingStep", "Step {step}", { step: step.step })}</th>
                <td class="tabular">${chartClock(step.timeMs)}</td>
                <td>${step.notes > 1 ? html`<span class="tb-timing__chord">${host.t("timingChord", "{count} together", { count: step.notes })}</span>` : nothing}</td>
                <td class="tabular is-numeric">+${format(host, step.gain)}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      </div>
    </li>
  `;
}
/** Which notes to hit early: each step's notes, one frame early, per counting window. */
function timingDetails(host: TeamBuilder, hit: EngineHit, order: number, timing: OrderTiming | null | undefined, reserve = false) {
  if ((!timing || timing.best <= timing.score) && !reserve) return nothing;
  const windows = timing?.windows.filter((window) => window.steps.length) ?? [];
  const key = `timing-guide:${timelineKey(host, hit)}:${order}`;
  return accordion({
    id: `tb-${key.replace(/[^a-z0-9]/giu, "-")}`,
    label: host.t("timingGuide", "Timing guide"),
    disabled: !timing || timing.best <= timing.score,
    expanded: host.expanded.has(key),
    onExpandedChange: (open) => {
      if (open) host.expanded.add(key);
      else host.expanded.delete(key);
      host.requestUpdate();
    },
    content: html`
    <section class="tb-timing stack stack--flex stack--tight">
      <div class="row row--between row--wrap">
        <strong class="tb-subtitle">${host.t("timingNotes", "Notes to hit early")}</strong>
        <span class="tb-timing__advance">${icon("fast_rewind", 16)}${host.t("timingAdvance", "About {ms} ms early", { ms: timing?.advanceMs ?? Math.ceil(1000 / (resultSettings(host, hit).frameRate ?? 60)) })}</span>
      </div>
      <ol class="tb-timing__windows" role="list">${windows.map((window) => timingWindow(host, hit, order, window, host.expanded.has(key)))}</ol>
      <small class="tb-timing__hint">${host.t("timingFirstNotes", "Hit the first notes after activation as usual")}</small>
    </section>
  `,
  });
}

function skillOrderView(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const score = hit.score;
  if (!hit.song || !score?.orders?.length) return html``;
  const key = timelineKey(host, hit);
  const { swapPick, firingOrder, shownTimeline } = detailState(host, hit);
  const ranked = score.orders
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const best = ranked[0]!;
  const current = resultOrderIndex(host, hit);
  const requested = orderTimeline(host, hit, current);
  if (typeof requested === "object") shownTimeline.set(key, requested);
  const timeline = typeof requested === "object" ? requested : (shownTimeline.get(key) ?? requested);
  if (typeof timeline === "object" && !firingOrder.has(key))
    firingOrder.set(
      key,
      [...timeline.windows].sort((a, b) => a.startMs - b.startMs || a.event - b.event).map((window) => window.event),
    );
  const firing = firingOrder.get(key) ?? [0, 1, 2, 3, 4];
  const value = score.orders[current]!;
  const inputs = resultInputs(host, hit);
  const master = host.master;
  const reserveTiming = (inputs?.goal.kind === "score" || inputs?.goal.kind === "event") && !!master && hit.snaps.some(key => {
    const snap = inputs.snaps.find(row => row.key === key);
    return snap && master.snaps.get(snap.cardId)?.supportSkillIds.some(id => master.supportSkills.get(id)?.some(row => row.type === 2001));
  });
  const timingKey = `${key}|timing`;
  const timingOpen = host.expanded.has(timingKey);
  const timingResult = reserveTiming && timingOpen ? orderTimeline(host, hit, current, true) : undefined;
  const timing = typeof timingResult === "object" ? timingResult.timing : undefined;
  const rank = score.orders.filter((other) => other > value).length + 1;
  const gap = (other: number) => (other === best.value ? "±0" : `−${format(host, best.value - other)}`);
  const choose = (index: number) => {
    setResultOrder(host, hit, index);
    swapPick.delete(key);
    host.requestUpdate();
  };
  const picked = swapPick.get(key);
  const pick = (position: number) => {
    if (picked === undefined) swapPick.set(key, position);
    else if (picked === position) swapPick.delete(key);
    else {
      const order = [...ORDERS[current]!];
      const a = firing[picked]!,
        b = firing[position]!;
      [order[a], order[b]] = [order[b]!, order[a]!];
      choose(ORDER_INDEX.get(order.join(","))!);
      return;
    }
    host.requestUpdate();
  };
  const first = firing[0]!;
  const byFirst = [0, 1, 2, 3, 4]
    .filter((slot) => slot < hit.members.length)
    .map((slot) => ranked.find((entry) => ORDERS[entry.index]![first] === slot)!)
    .sort((a, b) => b.value - a.value);
  const topOpen = host.expanded.has(`${key}|orders`);
  const rankOf = (other: number) => score.orders.filter((entry) => entry > other).length + 1;
  return html`
    <section class="tb-order stack stack--flex">
      <div class="row row--wrap row--between">
        <strong class="tb-subtitle">${host.t("skillOrder", "Skill order")}</strong>
        <div class="cluster">
          <button
            class="button button--text button--small"
            type="button"
            ?disabled=${current === best.index}
            @click=${() => choose(best.index)}
          >
            ${host.t("bestOrder", "Best order")}
          </button>
          <button
            class="button button--text button--small"
            type="button"
            ?disabled=${current === ranked.at(-1)!.index}
            @click=${() => choose(ranked.at(-1)!.index)}
          >
            ${host.t("worstOrder", "Worst order")}
          </button>
        </div>
      </div>
      <ol class="tb-order-editor" role="list" aria-label=${host.t("skillOrder", "Skill order")}>
        ${firing.map((event, position) => {
          const member = memberFace(host, hit, ORDERS[current]![event]!);
          return html`
            <li>
              <button
                type="button"
                class="tb-order-slot"
                aria-pressed=${String(picked === position)}
                ?data-swap=${picked !== undefined && picked !== position}
                aria-label=${`${position + 1} / ${member.name}`}
                title=${member.name}
                style=${`--member-color:${member.color}`}
                @click=${() => pick(position)}
              >
                <span class="tb-order-slot__index">${position + 1}</span>
                <img src=${member.card} alt="" width="48" height="64" decoding="async" />
                <span class="tb-order-slot__swap">${icon("swap_horiz", 18)}</span>
              </button>
            </li>
          `;
        })}
      </ol>
      <dl class="spec-list spec-list--split spec-list--numeric">
        <div>
          <dt>${host.t("score", "Score")}</dt>
          <dd>${format(host, value)}</dd>
        </div>
        <div>
          <dt>${host.t("orderRank", "Rank")}</dt>
          <dd>${rank} / ${score.orders.length}</dd>
        </div>
        <div>
          <dt>${host.t("orderGap", "From best")}</dt>
          <dd>${gap(value)}</dd>
        </div>
      </dl>
      ${reserveTiming ? accordion({
        id: `tb-timing-analysis-${key.replace(/[^a-z0-9]/giu, "-")}`,
        label: host.t("timingAnalysis", "Judgement timing"),
        expanded: timingOpen,
        metadata: timingResult === "loading" ? host.common("common.states.loading", "Loading")
          : timingResult === "error" ? host.t("timingFailed", "Timing could not be calculated") : nothing,
        onExpandedChange: (open) => {
          if (open) host.expanded.add(timingKey);
          else host.expanded.delete(timingKey);
          host.requestUpdate();
        },
        content: html`<div class="stack stack--flex">
          <dl class="spec-list spec-list--split spec-list--numeric">
            ${timingRow(host, timing, true, value, Math.ceil(1000 / (resultSettings(host, hit).frameRate ?? 60)))}
          </dl>
          ${timingDetails(host, hit, current, timing, true)}
        </div>`,
      }) : nothing}
      <div class="tb-order__timeline" aria-busy=${String(typeof requested !== "object")}>
        ${
          typeof timeline === "object"
            ? skillTimeline({
                label: host.t("timeline", "Skill timeline"),
                durationMs: timeline.durationMs,
                density: timeline.density,
                fever: timeline.fever,
                feverLabel: (index) => `${host.t("gekiso", "GEKISO")} ${index + 1}`,
                windows: timeline.windows.map((window) => {
                  const member = memberFace(host, hit, hit.members.indexOf(window.member));
                  return {
                    startMs: window.startMs,
                    endMs: window.endMs,
                    color: member.color,
                    image: host.catalog!.characterFace(member.character),
                    label: member.name,
                    value: `+${format(host, window.percent + window.perfectPercent, 0)}%${window.extensionMs ? ` / +${(window.extensionMs / 1000).toFixed(1)}s` : ""}`,
                  };
                }),
              })
            : timeline === "error"
              ? html`
                  <p class="inline-message">${host.t("timelineFailed", "The timeline could not be drawn.")}</p>
                `
              : html`
                  <div
                    class="skill-timeline__plot"
                    aria-label=${host.t("loadingTimeline", "Loading skill timeline")}
                  ></div>
                `
        }
      </div>
      <div class="stack stack--flex stack--tight">
        <strong class="tb-subtitle">${host.t("firstSkill", "Best order by first skill")}</strong>
        ${collectionList(
          byFirst.map((entry) => {
            const member = memberFace(host, hit, ORDERS[entry.index]![first]!);
            return {
              id: String(entry.index),
              title: member.name,
              subtitle: html`
                <span class="tb-order-line">
                  <span class="tabular" title=${format(host, entry.value)}>${gap(entry.value)}</span>
                  ${orderFaces(host, hit, entry.index, firing)}
                </span>
              `,
              media: html`
                <img src=${member.card} alt="" width="42" height="56" decoding="async" />
              `,
              onOpen: () => choose(entry.index),
            };
          }),
        )}
      </div>
      ${accordion({
        id: `tb-orders-${key.replace(/[^a-z0-9]/giu, "-")}`,
        label: host.t("topOrders", "Top orders"),
        metadata: "10",
        expanded: topOpen,
        onExpandedChange: (open) => {
          if (open) host.expanded.add(`${key}|orders`);
          else host.expanded.delete(`${key}|orders`);
          host.requestUpdate();
        },
        content: cache(topOpen ? collectionList(
          ranked.slice(0, 10).map((entry) => ({
            id: String(entry.index),
            title: orderFaces(host, hit, entry.index, firing),
            subtitle: html`
              <span class="tabular">${format(host, entry.value)} / ${gap(entry.value)}</span>
            `,
            media: html`
              <span class="tb-order-rank tabular">${rankOf(entry.value)}</span>
            `,
            onOpen: () => choose(entry.index),
          })),
        ) : nothing),
      })}
    </section>
  `;
}

export function renderResultDetails(host: TeamBuilder, hit: EngineHit): TemplateResult {
  return html`
    <div class="tb-hit__detail stack stack--flex">
      ${host.results && !usesPtResults(host) && !manualResultSource(hit)
        ? html`<span class="tb-results__meta">
            ${host.results.results.some((result) => result.stats.exact > 0)
              ? host.t("resultMeta", "{ms} ms / {exact} teams simulated exactly", { ms: format(host, host.results.elapsedMs), exact: host.results.results.reduce((total, result) => total + result.stats.exact, 0) })
              : host.t("resultElapsed", "{ms} ms", { ms: format(host, host.results.elapsedMs) })}
          </span>` : nothing}
      <div class="cluster">${chips(host, hit)}</div>
      ${eventBonusDetails(host, hit)}
      ${hit.justWindow ? specList([{ label: host.t("justWindowActual", "JUST tap window"), value: justWindowValue(host, hit.justWindow) }]) : nothing}
      ${distribution(host, hit, hit.song)} ${powerNeeded(host, hit, hit.song)} ${skillOrderView(host, hit)}
    </div>
  `;
}

export function resultImageDecorator(host: TeamBuilder, hit: EngineHit, assetsBase = location.href) {
  const input = resultInputs(host, hit);
  const selectedSong = hit.song ?? (input?.goal.kind === "power" ? input.goal.song : input && "songs" in input.goal && input.goal.songs.length === 1 ? input.goal.songs[0]! : null);
  const song = selectedSong ? resultSong(host, selectedSong) : nothing;
  const metrics = chips(host, hit);
  const catalog = host.catalog!;
  const identities = { ...catalog.data.crossServer?.identities, [catalog.data.identity.server]: catalog.data.identity };
  return (card: HTMLElement) => {
    const summary = card.querySelector<HTMLElement>(".tb-hit__chips");
    if (summary) { summary.replaceChildren(); render(metrics, summary); }
    if (selectedSong && !card.querySelector(".tb-result-song")) {
      const header = document.createElement("div"); render(song, header); card.prepend(...Array.from(header.childNodes));
    }
    for (const image of card.querySelectorAll<HTMLImageElement>("img")) {
      const source = image.dataset.src || image.getAttribute("src");
      if (!source || source.startsWith("data:")) continue;
      const url = new URL(source, assetsBase);
      const server = /^\/(?:assets|runtime)\/([^/]+)\//u.exec(url.pathname)?.[1];
      if (server && identities[server]) url.searchParams.set("release", identities[server]!.releaseId);
      if (image.dataset.src) image.dataset.src = url.href;
      else image.src = url.href;
    }
  };
}

async function exportImage(host: TeamBuilder, key: string, hit: EngineHit) {
  const element = [...host.querySelectorAll<HTMLElement>(".tb-hit")].find((card) => card.dataset.resultKey === key);
  if (!element) return;
  try {
    const { renderTeamResultImage } = await import("../shared/team-result-image");
    if (!element.isConnected) return;
    const blob = await renderTeamResultImage(element, { decorate: resultImageDecorator(host, hit) });
    await downloadBlob(blob, "team.png");
  } catch {
    host.error = host.common("common.states.captureFailed", "The image could not be captured. Try again.");
    host.requestUpdate();
  }
}

function copyText(host: TeamBuilder, hit: EngineHit) {
  const catalog = host.catalog!;
  const main = primary(host, hit);
  const lines = [
    hit.song
      ? `${catalog.songTitle(hit.song.songId)} ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}`
      : "",
    `${main.label}: ${main.value} / ${host.t("power", "Power")}: ${format(host, hit.power)}`,
    ...conditionLines(host, hit),
    ...hit.members.map((key, index) => {
      const snap = hit.snaps[index];
      return `${index === 0 ? `[${host.t("leader", "Leader")}] ` : ""}${catalog.cardName("members", cardIdOf(key))} (${catalog.characterName(catalog.member(cardIdOf(key))?.characterId ?? 0)}) + ${snap ? catalog.cardName("snaps", cardIdOf(snap)) : "—"}`;
    }),
  ].filter(Boolean);
  void navigator.clipboard?.writeText(lines.join("\n")).then(() => {
    host.notice = host.t("copied", "Copied");
    host.requestUpdate();
  });
}

export function saveTeam(
  host: TeamBuilder,
  members: number[],
  snaps: (number | null)[],
  song: SongRef | null,
  name?: string,
) {
  const id = (crypto.randomUUID?.() ?? `${Date.now()}`).replace(/[^a-z0-9-]/gu, "").slice(0, 36);
  const catalog = host.catalog!;
  const label =
    name ??
    `${catalog.characterName(catalog.member(members[0]!)?.characterId ?? 0)} / ${song ? catalog.songTitle(song.songId) : host.t("noSong", "No song")}`;
  host.write([
    {
      key: `team.${id}`,
      value: { name: label.slice(0, 80), members, snaps, leader: members[0] ?? null, song, createdAt: Date.now() },
    },
  ]);
  host.notice = host.t("savedTeam", "Saved to Teams");
  host.requestUpdate();
}

/** Song analysis for this team: its power and each member's score and Perfect score skills with their snap extension. */
function songMetaHref(host: TeamBuilder, hit: EngineHit): string | null {
  const inputs = resultInputs(host, hit);
  const master = host.master;
  if (!inputs || !master || hit.members.length !== 5) return null;
  const box = resolveBox(
    master,
    inputs.members.filter((row) => hit.members.includes(row.key)),
    inputs.snaps.filter((row) => hit.snaps.includes(row.key)),
    inputs.unknownPolicy,
  );
  const members = hit.members.map((key) => box.members.find((item) => item.key === key));
  const snaps = hit.snaps.map((key) => (key ? (box.snaps.find((item) => item.key === key) ?? null) : null));
  const slots = members.map((member, slot) => {
    if (!member) return "0:0:0";
    const skill = resolveSlotSkill(master, member, snaps[slot] ?? null);
    return `${effectPercent(skill, 2000)}:${effectPercent(skill, 2004)}:${skill.extensionMs}`;
  });
  const query = new URLSearchParams({ deckPower: String(hit.power), deckSlots: slots.join(",") });
  const settings = resultSettings(host, hit);
  if (settings.arena || inputs.songRules) return null;
  if (settings.manualEventEnabled && settings.goal === "event") return null;
  const event = settings.eventId !== null ? master.events.get(settings.eventId) : undefined;
  if (hit.event && (settings.goal === "event" || settings.goal === "plan") && settings.route !== "challenge" && event) {
    const bonus = (type: number) =>
      Math.floor(
        (members.reduce((sum, member) => sum + (member ? memberEventPercent(event.effects, member, type) : 0), 0) +
          snaps.reduce((sum, snap) => sum + (snap ? snapEventPercent(event.effects, snap, type) : 0), 0)) /
          100,
      );
    // An event live earns both bonuses; `hit.event.bonusPercent` only carries the ranked measure's one.
    query.set("deckPointBonus", String(bonus(0)));
    query.set("deckItemBonus", String(bonus(1)));
    query.set("deckEvent", String(settings.eventId));
    query.set("deckBoosts", String(settings.boosts));
  }
  return (
    resourceCollectionHref(
      `catalog/song-meta?${query}`,
      (hit.song ? host.catalog!.songIdentity(hit.song.songId).server : host.server) as ReleaseServer,
      host.locale as Locale,
    ) ?? null
  );
}

export function renderHit(
  host: TeamBuilder,
  hit: EngineHit,
  index: number,
  options: { rank?: TemplateResult; subtitle?: string; stale?: boolean; content?: TemplateResult } = {},
): TemplateResult {
  const key = hitKey(hit);
  const expanded = host.expanded.has(key);
  const songsKey = `${key}|songs`;
  const songsExpanded = host.expanded.has(songsKey);
  const reference = host.comparison.idFor(host, hit);
  const compared = !!reference && host.comparison.items.some((item) => item.id === reference);
  const stale = options.stale ?? host.stale;
  const analysisHref = songMetaHref(host, hit);
  const main = primary(host, hit);
  return html`
    <article
      data-result-key=${key}
      class=${`card card--outlined tb-hit${index === 0 ? " is-best" : ""}`}
      aria-label=${`${options.subtitle ?? `#${index + 1}`} / ${main.label} ${main.value}`}
    >
      ${hit.song ? resultSong(host, hit.song) : nothing}
      <header class="tb-hit__header">
        <div class="tb-hit__main">
          <span class="tb-hit__label">
            <span class="tb-hit__rank">${options.rank ?? `#${index + 1}`}</span>
            ${main.label}${
              options.subtitle
                ? html`
                    / ${options.subtitle}
                  `
                : nothing
            }
          </span>
          <strong class="tb-hit__value tabular">${main.value}</strong>
        </div>
      </header>
      <div class="cluster tb-hit__chips">${chips(host, hit, true)}</div>
      ${options.content ?? nothing} ${formation(host, hit)}
      ${
        hit.aggregate
          ? accordion({
              id: `tb-songs-${key.replace(/[^a-z0-9]/giu, "-")}`,
              label: host.t("arena.scoreDetails", "Scores by song"),
              metadata: String(hit.aggregate.songs.length),
              expanded: songsExpanded,
              onExpandedChange: (open) => {
                if (open) host.expanded.add(songsKey);
                else host.expanded.delete(songsKey);
                host.requestUpdate();
              },
              content: cache(songsExpanded ? html`<div class="stack">
                ${hit.aggregate.songs.map((part) => {
                  const metric = resultMetric(host, part, resultSettings(host));
                  return html`
            <div class="surface stack">
              ${part.song ? resultSong(host, part.song) : nothing}
              <div class="row row--between row--wrap">
                <span class="supporting-text">${metric.label}</span>
                <strong class="tabular">${format(host, metric.value, metric.digits)}</strong>
              </div>
              <div class="cluster">${chips(host, part, true)}</div>
            </div>
          `;
                })}
              </div>` : nothing),
            })
          : nothing
      }
      <div class="tb-hit__actions">
        ${resultSettings(host, hit).scope !== "theoretical" && resultSettings(host, hit).goal !== "plan" ? html`
          <button class="button button--tonal" type="button" ?disabled=${host.running}
            @click=${() => host.teamGrowth.openResult(hit)}>${host.t("tg.title", "Team growth comparison")}</button>` : nothing}
        <button
          class="button button--tonal"
          ?disabled=${stale}
          @click=${() =>
            saveTeam(
              host,
              hit.members.map(cardIdOf),
              hit.snaps.map((snap) => (snap ? cardIdOf(snap) : null)),
              hit.song,
            )}
        >
          ${host.t("saveTeam", "Save team")}
        </button>
        ${
          resultSettings(host).arena ||
          resultSettings(host).scope === "theoretical" || (usesPtResults(host) && !host.pt.job?.presentation)
            ? nothing
            : html`
                <button
                  class="button button--text"
                  type="button"
                  ?disabled=${stale}
                  @click=${() => {
                    host.songComparison.update({songRules: resultInputs(host)?.songRules});
                    host.openSongComparison({
                      members: hit.members.map(cardIdOf),
                      snaps: hit.snaps.map((snap) => (snap ? cardIdOf(snap) : null)),
                      leader: 0,
                    });
                  }}
                >
                  ${host.t("sc.useTeam", "Compare songs with this team")}
                </button>
              `
        }
        ${
          resultSettings(host).arena || !hit.song || hit.aggregate || (usesPtResults(host) && !host.pt.job?.presentation)
            ? nothing
            : html`
                <button class="button button--text" type="button" ?disabled=${stale || host.running} @click=${() => host.compareTeam(hit)}>
                  ${host.t("editCompare", "Edit and compare")}
                </button>
              `
        }
        ${
          reference
            ? html`
                <button
                  class="button button--text"
                  aria-pressed=${compared}
                  @click=${() => host.comparison.toggle(host, hit)}
                >
                  ${host.t(compared ? "comparisonAdded" : "addComparison", compared ? "Added to comparison" : "Add to comparison")}
                </button>
              `
            : nothing
        }
        ${actionMenu({
          id: `tb-result-actions-${index}`,
          label: host.common("common.actions.moreActions", "More"),
          items: [
            { label: host.t("copyTeam", "Copy as text"), icon: "content_copy", run: () => copyText(host, hit) },
            { label: host.t("saveImage", "Save image"), icon: "image", run: () => void exportImage(host, key, hit) },
            ...(analysisHref
              ? [
                  {
                    label: host.t("songMetaWithTeam", "Song analysis with this team"),
                    icon: "query_stats",
                    href: analysisHref,
                  },
                ]
              : []),
          ],
        })}
      </div>
      ${
        hit.aggregate
          ? nothing
          : accordion({
        id: `tb-detail-${key.replace(/[^a-z0-9]/giu, "-")}`,
        label: host.t("moreDetail", "Details"),
        expanded,
        onExpandedChange: (open) => {
          if (open) host.expanded.add(key);
          else host.expanded.delete(key);
          host.requestUpdate();
        },
        content: cache(
          expanded
            ? html`
                ${renderResultDetails(host, hit)}
              `
            : nothing,
        ),
      })}
    </article>
  `;
}

/** Which single card, raised to full growth, improves the best team most. */
function growthSection(host: TeamBuilder): TemplateResult {
  const catalog = host.catalog!;
  const growth = host.growth?.context === host.calculationContext() ? host.growth : null;
  const upgrades = growth?.result?.upgrades.filter((row) => row.gain > 1e-9).slice(0, 8) ?? [];
  const base = growth?.result?.base ?? 0;
  return html`
    <section class="surface stack tb-growth">
      ${sectionHeading({ icon: "trending_up", label: host.t("growthTitle", "Training priorities") })}
      ${
        growth?.result
          ? upgrades.length
            ? html`
                <ul class="list">
                  ${upgrades.map((row) => {
                    const id = cardIdOf(row.key);
                    return html`
                      <li class="list-item">
                        <span class="list-item__leading tb-suggest__art">
                          ${tileMedia(catalog.cardOptions(row.kind, id)!)}
                        </span>
                        <span class="list-item__body">
                          <strong class="list-item__headline">${catalog.cardName(row.kind, id)}</strong>
                          <span class="list-item__supporting tabular">
                            +${format(host, row.gain, Math.abs(row.gain) < 100 ? 2 : 0)}${base > 0 ? ` (+${format(host, (row.gain / base) * 100, 2)}%)` : ""}
                          </span>
                        </span>
                        <button class="button button--text" type="button" ?disabled=${host.running}
                          @click=${() => { const hit = host.results?.overall[0]; if (hit) host.teamGrowth.openResult(hit, row); }}>
                          ${host.t("tg.title", "Team growth comparison")}
                        </button>
                      </li>
                    `;
                  })}
                </ul>
              `
            : html`
                <p class="supporting-text">${host.t("growthNone", "No single card upgrade improves the best team.")}</p>
              `
          : html`
              <button
                class="button button--tonal"
                type="button"
                ?disabled=${!!growth || host.running}
                @click=${() => void host.recommendGrowth()}
              >
                ${icon("trending_up", 18)}${growth ? host.t("growthProgress", "Checking cards {done}/{total}", { done: growth.done, total: growth.total || "…" }) : host.t("growthRun", "Find the best card to train")}
              </button>
            `
      }
    </section>
  `;
}

export function renderResults(host: TeamBuilder): TemplateResult {
  const results = host.results;
  if (
    !results ||
    ["event", "plan"].includes(host.resultSettings?.goal ?? "score") !== (host.tab === "pt") ||
    (host.tab === "pt" && (host.resultSettings?.goal === "plan") !== (host.settings.rewardMode === "plan"))
  ) {
    return renderChecklist(host);
  }
  const catalog = host.catalog!;
  const stale = host.stale;
  const multi = results.results.length > 1 && resultSettings(host).goal !== "plan";
  const tab = multi ? host.resultTab : "all";
  const shown = results.plan
    ? [results.plan.normal, results.plan.challenge].filter((hit): hit is EngineHit => hit !== null)
    : tab === "overall" || !multi
      ? multi
        ? results.overall
        : (results.results[0]?.hits ?? [])
      : (results.results.find((result) => result.song && `${result.song.songId}:${result.song.difficulty}` === tab)
          ?.hits ?? []);
  const groups =
    multi && tab !== "overall"
      ? results.results.filter((result) => result.song && `${result.song.songId}:${result.song.difficulty}` === tab)
      : results.results;
  const proven = groups.length > 0 && groups.every((result) => result.proven);
  const gap = proven ? null : improvementPercent(groups);
  return html`
    <section class="tb-results stack stack--flex">
      <div class="row row--wrap row--between tb-results__summary">
        <span class=${`tb-proof${proven ? " is-proven" : ""}`}>
          ${icon(proven ? "verified" : "hourglass_bottom", 18)}${scoreProof(host, proven, groups.some(group => group.hits.some(hit => hit.gekiso?.sampled)))}
        </span>
        ${
          gap === null
            ? nothing
            : html`
                <span class="tb-results__meta">
                  ${host.t("improvementBound", "Up to {percent}% improvement", { percent: format(host, gap, 1) })}
                </span>
              `
        }
        ${
          multi
            ? html`
                <md-outlined-select
                  class="tb-results__selector"
                  label=${host.t("songs", "Songs")}
                  .value=${tab}
                  @change=${(event: Event) => {
                    host.resultTab = (event.target as HTMLInputElement).value;
                    host.requestUpdate();
                  }}
                >
                  <md-select-option value="overall">
                    <div slot="headline">${host.t("overall", "Overall")}</div>
                  </md-select-option>
                  ${results.results.map(
                    (result) => html`
                      <md-select-option value=${`${result.song!.songId}:${result.song!.difficulty}`}>
                        <div slot="headline">
                          ${catalog.songTitle(result.song!.songId)}
                          ${catalog.difficultyLabel(result.song!.songId, result.song!.difficulty)}
                        </div>
                      </md-select-option>
                    `,
                  )}
                </md-outlined-select>
              `
            : nothing
        }
      </div>
      ${
        results.unknownCards.length
          ? html`
              <p class="inline-message">
                ${host.t("unknownCards", "{count} saved cards are not in this data release and were skipped.", { count: results.unknownCards.length })}
              </p>
            `
          : nothing
      }
      ${
        results.plan
          ? html`
              <section class="surface surface--tonal stack tb-plan">
                <strong class="tb-subtitle">${host.t("planTotal", "Total event points")}</strong>
                <strong class="tb-hit__value tabular">${format(host, results.plan.eventPoints)}</strong>
                <div class="cluster">
                  <span class="tb-chip">
                    <span class="tb-chip__label">${host.t("normalLives", "Normal lives")}</span>
                    <strong>${results.plan.normalLives}</strong>
                  </span>
                  <span class="tb-chip">
                    <span class="tb-chip__label">${host.t("challengeLives", "Challenge lives")}</span>
                    <strong>
                      ${results.plan.challengeLives.toLocaleString(host.locale, { maximumFractionDigits: 2 })}
                    </strong>
                  </span>
                  <span class="tb-chip">
                    <span class="tb-chip__label">${host.t("cpEarned", "Challenge points earned")}</span>
                    <strong>
                      ${results.plan.challengePointsEarned.toLocaleString(host.locale, { maximumFractionDigits: 2 })}
                    </strong>
                  </span>
                  <span class="tb-chip">
                    <span class="tb-chip__label">${host.t("cpLeft", "Left over")}</span>
                    <strong>
                      ${results.plan.leftoverChallengePoints.toLocaleString(host.locale, { maximumFractionDigits: 2 })}
                    </strong>
                  </span>
                  <span class="tb-chip">
                    <span class="tb-chip__label">${host.t("perBoost", "Per boost")}</span>
                    <strong>${format(host, results.plan.perBoost, 1)}</strong>
                  </span>
                </div>
              </section>
            `
          : nothing
      }
      ${
        results.cpChallenge
          ? renderHit(host, results.cpChallenge, -1, { rank: icon("swords", 18),
              subtitle: host.t("pt.challengeBest", "Challenge team"), stale })
          : nothing
      }
      ${
        shown.length
          ? repeat(shown, hitKey, (hit, index) =>
              renderHit(
                host,
                hit,
                index,
                results.plan
                  ? {
                      stale,
                      subtitle:
                        hit === results.plan.challenge
                          ? host.t("routeChallenge", "Challenge live")
                          : host.t("routeLive", "Normal live"),
                    }
                  : { stale },
              ),
            )
          : html`
              <div class="state">
                <p class="state__title">
                  ${proven ? host.t("noTeams", "No team meets these conditions") : host.t("noCandidate", "No recommendation yet")}
                </p>
              </div>
            `
      }
      ${shown.length && resultSettings(host).goal !== "plan" && resultSettings(host).scope !== "theoretical" && !stale ? growthSection(host) : nothing}
    </section>
  `;
}
