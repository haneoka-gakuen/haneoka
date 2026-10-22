import { cache } from "lit/directives/cache.js";
import { resultMetric, chartDuration } from "./result-metric";
import { repeat } from "lit/directives/repeat.js";
import { actionMenu } from "../ui/action-menu";
import { improvementPercent } from "../../lib/team-builder/engine/execution";
/** Search results: ranked team cards, per-song rankings, plan summary, comparison. */
import { html, nothing, type TemplateResult } from "lit";
import type { EngineHit, SongRef, Timeline } from "../../lib/team-builder/engine/api";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";
import { downloadBlob } from "../../lib/canvas-capture";
import { renderTeamResultImage, type ResultImageCard } from "../shared/team-result-image";
import { cardRarityName } from "../shared/rarity-icon";
import { songChartSummary } from "../ui/song-summary";
import { songMissions } from "../../lib/catalog-filters";
import { missionSummary } from "./workspace-state";
import { accordion } from "../ui/accordion";
import { collectionList } from "../ui/collection-view";
import { skillTimeline } from "../shared/skill-timeline";
import { ORDERS } from "../../lib/team-builder/engine/order-equivalence";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import { sectionHeading } from "./catalog";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { resultSettings, usesPtResults, scoreGoal, scoreProof } from "./score-goal";
import { resolveBox } from "../../lib/team-builder/engine/box";
import { effectPercent, resolveSlotSkill } from "../../lib/team-builder/engine/skills";
import { memberEventPercent, snapEventPercent } from "../../lib/team-builder/engine/power";
import { entityHref, resourceCollectionHref } from "../../lib/resource-route";
import type { ReleaseServer } from "../../lib/release-server";
import type { Locale } from "../../i18n/locales";
import { roomRequiredScore, teamPowerNeeded } from "../../lib/chart-rates";

const RANK_NAMES: Record<string, string> = { "1": "E", "2": "D", "3": "C", "4": "B", "5": "A", "6": "S", "7": "SS" };
export const timelines = new Map<string, Timeline | "loading" | "error">();
const resultInputs = (host: TeamBuilder) => (usesPtResults(host) ? (host.pt.job?.request ?? null) : host.resultInputs);
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
    input = resultInputs(host);
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
    ...(input?.goal.kind === "event" && input.goal.weights
      ? [
          `${host.t("weightPoints", "Weight per event point")}: ${input.goal.weights.points} · ${host.t("weightItems", "Weight per shop item")}: ${input.goal.weights.items} · ${host.t("weightCp", "Weight per challenge point")}: ${input.goal.weights.challengePoints}`,
        ]
      : []),
    ...(input?.goal.kind === "score" && input.goal.target
      ? [`${host.t("targetScore", "Target score")}: ${format(host, input.goal.target.score)}`]
      : []),
    ...(input && "play" in input.goal
      ? [
          Object.entries(input.goal.play)
            .map(([key, value]) =>
              key === "missEvery"
                ? `${host.t("missEvery", "Miss every N notes")}: ${value}`
                : `${key.toUpperCase()} ${format(host, value * 100, 2)}%`,
            )
            .join(" · "),
        ]
      : []),
    ...(input?.goal.kind === "gekiso"
      ? [
          `GREAT ${format(host, input.goal.accuracy.great * 100, 2)}% · JUST ${format(host, input.goal.accuracy.just * 100, 2)}% · ${host.t("missEvery", "Miss every N notes")}: ${input.goal.accuracy.missEvery ?? 0}`,
          `${host.t("pt.luckSamples", "Luck samples")}: ${input.goal.seeds}`,
          `${host.t("gekisoPlacements", "Scoring placements")}: ${input.goal.opponents ? (host.results?.results.find((result) => result.hits.includes(hit))?.placements?.join(" / ") ?? "—") : input.goal.rank}`,
        ]
      : input?.goal.kind === "event" && input.goal.gekiso && s.route !== "challenge"
        ? [
            `JUST ${format(host, input.goal.gekiso.just * 100, 2)}% · ${host.t("gekisoPlacements", "Scoring placements")}: 1`,
            `${host.t("pt.luckSamples", "Luck samples")}: ${input.goal.gekiso.luckSamples}`,
          ]
        : []),
    ...((s.goal === "event" || s.goal === "plan") && s.eventId !== null
      ? [
          `${host.t("event", "Event")}: ${host.catalog!.events().find((event) => event.id === s.eventId)?.name ?? s.eventId}`,
          s.route === "challenge"
            ? host.t("routeChallenge", "Challenge live")
            : s.route === "skip"
              ? host.t("routeSkip", "Skip")
              : host.t("routeLive", "Normal live"),
        ]
      : []),
    ...(s.goal === "plan"
      ? [
          `${host.t("planBudget", "Boosts to spend")}: ${s.planBudget} · ${host.t("planStartCp", "Challenge points now")}: ${s.planStartingCp}`,
        ]
      : []),
    ...(s.goal === "event" || s.goal === "plan"
      ? [`${s.route === "challenge" ? "CP" : "Boost"}: ${s.route === "challenge" ? s.challengePoints : s.boosts}`]
      : []),
  ];
}

export function resultSong(host: TeamBuilder, song: SongRef, gekiso = true): TemplateResult {
  const catalog = host.catalog!;
  catalog.loadSongMetadata([song.songId]);
  const metadata = catalog.chartMetadata(song),
    options = catalog.songOptions(song.songId, song.difficulty);
  const seconds = metadata?.time;
  const time = chartDuration(seconds);
  const missions = songMissions(catalog.song(song.songId));
  const task = missionSummary(missions);
  return html`
    <div class="tb-result-song">
      <div class="tb-result-song__image">${tileMedia({ ...options, marks: [] })}</div>
      <div class="stack">
        <a
          href=${entityHref({ server: catalog.songIdentity(song.songId).server, locale: host.locale as Locale, kind: "songs", id: String(song.songId) })}
        >
          ${catalog.songTitle(song.songId)}
        </a>
        <span>${catalog.difficultyLabel(song.songId, song.difficulty)} · ${time}</span>
        <span>
          ${catalog.attributeName(Number(catalog.song(song.songId).musicType))} · ${catalog.songArtist(song.songId)}
        </span>
        ${
          gekiso && task
            ? html`
                <span>${task}</span>
              `
            : nothing
        }
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
    formatter = new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits, minimumFractionDigits: digits });
    numberFormats.set(key, formatter);
  }
  return formatter.format(value);
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
          s.goal === "score" ? `${rankLabel} ${host.t("reachOrders", "Orders reaching rank")}` : rankLabel,
          s.goal === "score"
            ? `${top[1]}/${Object.values(hit.score.ranks).reduce((sum, count) => sum + count, 0)}`
            : `${format(host, (top[1] / Object.values(hit.score.ranks).reduce((sum, count) => sum + count, 0)) * 100, top[1] === Object.values(hit.score.ranks).reduce((sum, count) => sum + count, 0) ? 0 : 1)}%`,
          icon("workspace_premium", 16),
        ),
      );
    }
  }
  if (hit.comboBonus != null)
    out.push(chip(host.t("comboBonus", "Base COMBO BONUS"), `×${format(host, hit.comboBonus)}`));
  if (hit.event) {
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
    s.goal === "gekiso"
      ? (host.results?.results.find(
          (result) => result.song?.songId === hit.song?.songId && result.song?.difficulty === hit.song?.difficulty,
        )?.placements ?? (s.gekisoPlacementMode === "rank" ? [s.gekisoRank, s.gekisoRank, s.gekisoRank] : undefined))
      : undefined;
  if (placements)
    out.push(chip(host.t("gekisoPlacements", "Placements"), placements.join(" · "), icon("leaderboard", 16)));
  if (hit.skipScore !== null)
    out.push(chip(host.t("skipScore", "Skip score"), format(host, hit.skipScore), icon("fast_forward", 16)));
  if (hit.potential)
    out.push(chip(host.t("skillCoverage", "Skill coverage"), `${format(host, hit.potential.area * 100, 0)}%·s`));
  if (!compact) return out;
  const selected =
    s.goal === "event" || s.goal === "plan"
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
            ...(s.goal === "score" && rankLabel
              ? [`${rankLabel} ${host.t("reachOrders", "Orders reaching rank")}`]
              : []),
          ];
  return [
    ...selected.flatMap((label) => out.filter((item) => labels.get(item) === label)),
    ...out.filter((item) => !selected.includes(labels.get(item)!)),
  ].slice(0, 3);
}

export function formation(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const catalog = host.catalog!;
  // The leader stands in the centre, as in the game's formation screen.
  const order = [1, 2, 0, 3, 4].filter((index) => index < hit.members.length);
  return html`
    <ol class="tb-formation" aria-label=${host.t("formation", "Formation")}>
      ${order.map((index) => {
        const member = cardIdOf(hit.members[index]!);
        const snapKey = hit.snaps[index];
        const snap = snapKey ? cardIdOf(snapKey) : null;
        const memberGrowth = resultGrowth(host, "members", hit.members[index]!);
        const snapGrowth = snapKey ? resultGrowth(host, "snaps", snapKey) : null;
        const memberOptions = catalog.cardOptions("members", member, memberGrowth);
        const snapOptions = snap !== null ? catalog.cardOptions("snaps", snap, snapGrowth) : null;
        const owned = host.view?.members.get(member);
        return html`
          <li
            class=${`tb-slot${index === 0 ? " is-leader" : ""}`}
            aria-label=${index === 0 ? host.t("leader", "Leader") : nothing}
            title=${`${catalog.characterName(catalog.member(member)?.characterId ?? 0)} · ${host.t("slotPower", "Slot power")} ${format(host, hit.slotPowers[index] ?? 0)}`}
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
              ${memberOptions ? tileMedia(memberOptions) : nothing}${
                index === 0
                  ? html`
                      <span class="tb-slot__leader">${host.t("leader", "Leader")}</span>
                    `
                  : nothing
              }
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
            ${
              owned
                ? nothing
                : resultSettings(host).scope === "theoretical"
                  ? html`
                      <span class="tb-slot__flag">${host.t("notOwned", "Not owned")}</span>
                    `
                  : nothing
            }
          </li>
        `;
      })}
    </ol>
  `;
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
  const gekisou = resultSettings(host).goal === "gekiso";
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
/** The order chosen in each result's skill-order editor, and the position picked for a swap. */
const orderChoice = new Map<string, number>();
const swapPick = new Map<string, number>();
/** Chart skill events in firing order, learned from the first timeline of each result. */
const firingOrder = new Map<string, number[]>();
/** The timeline on screen, kept while the next order's timeline loads. */
const shownTimeline = new Map<string, Timeline>();
let timelineInputs: ReturnType<typeof resultInputs> = null;
let timelineEpoch = 0;
function timelineKey(host: TeamBuilder, hit: EngineHit) {
  const inputs = resultInputs(host);
  if (inputs !== timelineInputs) {
    timelineInputs = inputs;
    timelineEpoch++;
    timelines.clear();
    orderChoice.clear();
    swapPick.clear();
    firingOrder.clear();
    shownTimeline.clear();
  }
  return `${timelineEpoch}|${hitKey(hit)}`;
}

function orderTimeline(host: TeamBuilder, hit: EngineHit, index: number) {
  const key = `${timelineKey(host, hit)}|${index}`;
  const value = timelines.get(key);
  if (value) return value;
  const request = resultInputs(host);
  const task = request && host.engine && hit.song ? host.acquireTask("timeline") : null;
  if (request && host.engine && hit.song && task) {
    timelines.set(key, "loading");
    void host.engine
      .explain({
        members: request.members,
        snaps: request.snaps,
        unknownPolicy: request.unknownPolicy,
        team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! },
        song: hit.song,
        eventOrder: ORDERS[index]!.map((slot) => hit.members[slot]!),
        play: "play" in request.goal ? request.goal.play : { great: 0, good: 0, bad: 0, miss: 0 },
      })
      .then((timeline) => {
        if (host.ownsTask(task)) timelines.set(key, timeline);
        else timelines.delete(key);
      })
      .catch(() => {
        if (host.ownsTask(task)) timelines.set(key, "error");
        else timelines.delete(key);
      })
      .finally(() => {
        host.releaseTask(task);
        host.requestUpdate();
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

function orderFaces(host: TeamBuilder, hit: EngineHit, index: number, firing: readonly number[]) {
  return html`
    <span class="tb-order-faces">
      ${firing.map((event) => {
        const member = memberFace(host, hit, ORDERS[index]![event]!);
        return html`
          <img
            src=${member.card}
            alt=${member.name}
            title=${member.name}
            width="28"
            height="28"
            loading="lazy"
            decoding="async"
            style=${`--member-color:${member.color}`}
          />
        `;
      })}
    </span>
  `;
}

function skillOrderView(host: TeamBuilder, hit: EngineHit): TemplateResult {
  const score = hit.score;
  if (!hit.song || !score?.orders?.length) return html``;
  const key = timelineKey(host, hit);
  const ranked = score.orders
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const best = ranked[0]!;
  const current = orderChoice.get(key) ?? best.index;
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
  const rank = score.orders.filter((other) => other > value).length + 1;
  const gap = (other: number) => (other === best.value ? "±0" : `−${format(host, best.value - other)}`);
  const choose = (index: number) => {
    orderChoice.set(key, index);
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
    <section class="tb-order stack">
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
                aria-label=${`${position + 1} · ${member.name}`}
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
      <div class="tb-order__timeline" aria-busy=${String(typeof requested !== "object")}>
        ${
          typeof timeline === "object"
            ? skillTimeline({
                label: host.t("timeline", "Skill timeline"),
                durationMs: timeline.durationMs,
                density: timeline.density,
                fever: timeline.fever,
                feverLabel: (index) => `${host.t("gekiso", "Gekisou")} ${index + 1}`,
                windows: timeline.windows.map((window) => {
                  const member = memberFace(host, hit, hit.members.indexOf(window.member));
                  return {
                    startMs: window.startMs,
                    endMs: window.endMs,
                    color: member.color,
                    image: member.card,
                    label: member.name,
                    value: `+${format(host, window.percent + window.perfectPercent, 0)}%${window.extensionMs ? ` · +${(window.extensionMs / 1000).toFixed(1)}s` : ""}`,
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
      <div class="stack stack--tight">
        <strong class="tb-subtitle">${host.t("firstSkill", "Best order by first skill")}</strong>
        ${collectionList(
          byFirst.map((entry) => {
            const member = memberFace(host, hit, ORDERS[entry.index]![first]!);
            return {
              id: String(entry.index),
              title: member.name,
              subtitle: html`
                <span class="tabular" title=${format(host, entry.value)}>${gap(entry.value)}</span>
              `,
              media: html`
                <img src=${member.card} alt="" width="42" height="56" decoding="async" />
              `,
              trailing: orderFaces(host, hit, entry.index, firing),
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
        content: collectionList(
          ranked.slice(0, 10).map((entry) => ({
            id: String(entry.index),
            title: orderFaces(host, hit, entry.index, firing),
            subtitle: html`
              <span class="tabular">${format(host, entry.value)} · ${gap(entry.value)}</span>
            `,
            media: html`
              <span class="tb-order-rank tabular">${rankOf(entry.value)}</span>
            `,
            onOpen: () => choose(entry.index),
          })),
        ),
      })}
    </section>
  `;
}

async function exportImage(host: TeamBuilder, hit: EngineHit) {
  const catalog = host.catalog!;
  const style = getComputedStyle(host);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const card = (kind: "members" | "snaps", key: string, leader: boolean): ResultImageCard => {
    const id = cardIdOf(key);
    const entry = kind === "members" ? catalog.member(id) : catalog.snap(id);
    const characters = catalog.characterIds(kind, id);
    return {
      title: catalog.cardName(kind, id),
      character: characters.map((character) => catalog.characterName(character)).join(" · "),
      image: entry?.image ?? "",
      avatars:
        kind === "members" && entry?.image
          ? [entry.image]
          : characters.map((character) => catalog.characterFace(character)).filter(Boolean),
      attribute: catalog.attributeIcon(entry?.attribute ?? 0) || undefined,
      rarity: catalog.rarityIcon(entry?.rarity ?? 0) || undefined,
      attributeLabel: catalog.attributeName(entry?.attribute ?? 0),
      rarityLabel: cardRarityName(entry?.rarity ?? 0),
      leader,
      growth: resultGrowth(host, kind, key),
      facts: [],
    };
  };
  const main = primary(host, hit);
  const blob = await renderTeamResultImage({
    title: host.t("title", "Team builder"),
    subtitle: hit.song
      ? `${catalog.songTitle(hit.song.songId)} · ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}`
      : "",
    jacket: hit.song ? catalog.songOptions(hit.song.songId, hit.song.difficulty).image : undefined,
    membersLabel: host.t("members", "Members"),
    snapshotsLabel: host.t("snapshots", "Snaps"),
    leaderLabel: host.t("leader", "Leader"),
    emptyLabel: host.t("noSnap", "No snap"),
    allEmptyLabel: host.t("allNoSnaps", "No Snapshots in any of the five slots"),
    imageUnavailableLabel: host.t("imageUnavailable", "Image unavailable"),
    members: hit.members.map((key, index) => card("members", key, index === 0)),
    snapshots: hit.snaps.map((key) => (key ? card("snaps", key, false) : null)),
    metrics: [
      { label: main.label, value: main.value, detail: "" },
      ...(resultSettings(host, hit).goal === "power"
        ? []
        : [{ label: host.t("power", "Power"), value: format(host, hit.power), detail: "" }]),
      ...(hit.score
        ? [
            {
              label: host.t("scoreRange", "Range"),
              value: `${format(host, hit.score.min)} – ${format(host, hit.score.max)}`,
              detail: "",
            },
          ]
        : []),
    ],
    footer: [...conditionLines(host, hit), "haneoka.org"],
    server: (hit.song ? catalog.songIdentity(hit.song.songId) : catalog.data.identity).server,
    releaseId: (hit.song ? catalog.songIdentity(hit.song.songId) : catalog.data.identity).releaseId,
    theme: {
      surface: token("--md-sys-color-surface", "#fff"),
      container: token("--md-sys-color-surface-container", "#f3f3f3"),
      text: token("--md-sys-color-on-surface", "#111"),
      muted: token("--md-sys-color-on-surface-variant", "#555"),
      primary: token("--md-sys-color-primary", "#4455aa"),
      outline: token("--md-sys-color-outline-variant", "#ccc"),
      font: token("--app-font", "sans-serif"),
    },
  });
  downloadBlob(blob, "team.png");
}

function copyText(host: TeamBuilder, hit: EngineHit) {
  const catalog = host.catalog!;
  const main = primary(host, hit);
  const lines = [
    hit.song
      ? `${catalog.songTitle(hit.song.songId)} ${catalog.difficultyLabel(hit.song.songId, hit.song.difficulty)}`
      : "",
    `${main.label}: ${main.value} · ${host.t("power", "Power")}: ${format(host, hit.power)}`,
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
    `${catalog.characterName(catalog.member(members[0]!)?.characterId ?? 0)} · ${song ? catalog.songTitle(song.songId) : host.t("noSong", "No song")}`;
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
  const inputs = resultInputs(host);
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
  const reference = host.comparison.idFor(host, hit);
  const compared = !!reference && host.comparison.items.some((item) => item.id === reference);
  const stale = options.stale ?? host.stale;
  const analysisHref = songMetaHref(host, hit);
  const main = primary(host, hit);
  const catalog = host.catalog!;
  return html`
    <article
      class=${`card card--outlined tb-hit${index === 0 ? " is-best" : ""}`}
      aria-label=${`${options.subtitle ?? `#${index + 1}`} · ${main.label} ${main.value}`}
    >
      ${hit.song ? resultSong(host, hit.song, resultSettings(host, hit).goal === "gekiso" || (resultSettings(host, hit).goal === "event" && resultSettings(host, hit).ptMode === "gekiso")) : nothing}
      <header class="tb-hit__header">
        <div class="tb-hit__main">
          <span class="tb-hit__label">
            <span class="tb-hit__rank">#${options.rank ?? index + 1}</span>
            ${main.label}${
              options.subtitle
                ? html`
                    · ${options.subtitle}
                  `
                : nothing
            }
          </span>
          <strong class="tb-hit__value tabular">${main.value}</strong>
        </div>
      </header>
      <div class="cluster tb-hit__chips">${chips(host, hit, true)}</div>
      ${options.content ?? nothing} ${formation(host, hit)}
      <div class="tb-hit__actions">
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
          resultSettings(host).scope === "theoretical" || (usesPtResults(host) && !host.pt.job?.presentation)
            ? nothing
            : html`
                <button
                  class="button button--text"
                  type="button"
                  ?disabled=${stale}
                  @click=${() => {
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
            { label: host.t("saveImage", "Save image"), icon: "image", run: () => void exportImage(host, hit) },
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
      ${accordion({
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
                <div class="tb-hit__detail stack">
                  ${
                    host.results && !usesPtResults(host)
                      ? html`
                          <span class="tb-results__meta">
                            ${host.results.results.some((result) => result.stats.exact > 0) ? host.t("resultMeta", "{ms} ms · {exact} teams simulated exactly", { ms: format(host, host.results.elapsedMs), exact: host.results.results.reduce((total, result) => total + result.stats.exact, 0) }) : host.t("resultElapsed", "{ms} ms", { ms: format(host, host.results.elapsedMs) })}
                          </span>
                        `
                      : nothing
                  }
                  <div class="cluster">${chips(host, hit)}</div>
                  <div class="cluster">
                    ${conditionLines(host, hit).map(
                      (line) => html`
                        <span class="tb-chip">${line}</span>
                      `,
                    )}
                  </div>
                  ${hit.song ? songChartSummary({ title: catalog.songTitle(hit.song.songId), difficulty: catalog.difficultyLabel(hit.song.songId, hit.song.difficulty), metrics: [{ label: host.common("media.chartPlayer.notes", "Notes"), value: host.master?.songs.get(hit.song.songId)?.difficulties.find((row) => row.difficulty === hit.song!.difficulty)?.noteCount ?? "—" }, ...["time", "bpm", "nps"].map((key) => ({ label: key === "time" ? host.common("common.fields.duration", "Duration") : key === "bpm" ? host.t("initialBpm", "Initial BPM") : host.t("averageNps", "Average NPS"), value: key === "time" ? chartDuration(catalog.chartMetadata(hit.song!)?.time) : (catalog.chartMetadata(hit.song!)?.[key === "bpm" ? "firstBpm" : key] ?? "—") }))] }) : nothing}
                  ${distribution(host, hit, hit.song)} ${powerNeeded(host, hit, hit.song)} ${skillOrderView(host, hit)}
                </div>
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
    const issue = host.inputIssues()[0];
    const emptyBox = issue?.field === "tb-cards" && host.searchSettings.scope === "box" && !host.view?.members.size;
    const missingCards = issue?.field === "tb-cards";
    const missingSong = issue?.field === "tb-songs" || issue?.field === "tb-challenge-songs";
    return html`
      <section class="surface tb-results tb-results--empty">
        <div class="state">
          <span class="state__icon">${icon("groups", 40)}</span>
          <p class="state__title">
            ${emptyBox ? host.t("emptyBoxTitle", "No cards imported yet") : missingCards ? host.t("emptyRangeTitle", "No cards in this range") : (issue?.message ?? host.t("readyToCalculate", "Ready to calculate"))}
          </p>
          ${
            host.inputIssues()[0]
              ? html`
                  <button
                    class="button button--tonal"
                    @click=${async () => {
                      if (emptyBox) {
                        host.imports.openBox();
                        return;
                      }
                      await host.focusInput(issue!.field);
                      if (missingSong)
                        host.querySelector<HTMLButtonElement>(`#${issue!.field} .tb-songs__add`)?.click();
                    }}
                  >
                    ${emptyBox ? host.t("importMyCards", "Import my cards") : missingCards ? host.t("adjustCardRange", "Adjust card range") : missingSong ? host.t("addSongs", "Choose songs") : host.t("adjustConditions", "Adjust conditions")}
                  </button>
                `
              : nothing
          }
        </div>
      </section>
    `;
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
  const stats = results.results.reduce((total, result) => total + result.stats.exact, 0);
  return html`
    <section class="tb-results stack">
      <div class="row row--wrap row--between tb-results__summary">
        <span class=${`tb-proof${proven ? " is-proven" : ""}`}>
          ${icon(proven ? "verified" : "hourglass_bottom", 18)}${scoreProof(host, proven)}${
            gap === null
              ? nothing
              : html`
                  · ${host.t("improvementBound", "Up to {percent}% improvement", { percent: format(host, gap, 1) })}
                `
          }
        </span>
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
      <div class="tb-results__conditions">
        ${
          stale
            ? html`
                <strong role="status">${host.t("stale", "Conditions changed")}</strong>
              `
            : nothing
        }
        <span class="tb-chip">
          ${resultSettings(host).scope === "theoretical" ? host.t("scopeAll", "All cards, full growth") : host.t("scopeBox", "My cards")}
        </span>
        <span class="tb-chip">
          ${host.t("unknownPolicy", "Growth not entered")}: ${growthPolicyLabel(host, resultSettings(host))}
        </span>
        ${
          multi
            ? html`
                <span class="tb-chip">
                  ${host.t("chartCount", "{count} charts", { count: results.results.length })} ·
                  ${host.t("perChartTeams", "Separate team per chart")}
                </span>
              `
            : nothing
        }
      </div>
      ${
        stale
          ? html`
              <details class="tb-calculation-detail">
                <summary>${host.t("originalConditions", "Original result conditions")}</summary>
                <div class="stack">
                  <span>
                    ${stats > 0 ? host.t("resultMeta", "{ms} ms · {exact} teams simulated exactly", { ms: format(host, results.elapsedMs), exact: stats }) : host.t("resultElapsed", "{ms} ms", { ms: format(host, results.elapsedMs) })}
                  </span>
                  ${
                    shown[0]
                      ? conditionLines(host, shown[0]).map(
                          (line) => html`
                            <span>${line}</span>
                          `,
                        )
                      : nothing
                  }
                </div>
              </details>
            `
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
