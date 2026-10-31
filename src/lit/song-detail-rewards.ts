import { songDetailSection, songChartSummary } from "./ui/song-summary";
import { difficultyKey, difficultyPicker } from "./ui/difficulty-picker";
import { resolveLocalizedText } from "../lib/localized-text";
import { html, nothing } from "lit";
import { difficultyEstimatesEnabled } from "../lib/difficulty-display";
import "../styles/song-gekisou.css";
import { gekisouMission } from "../lib/gekisou";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { icon, gameGlyph } from "./ui/icon";
import "./song-skill-points";
import type { SongChartReady } from "./song-skill-points";
import type { GekisoTimingSegment } from "../lib/team-builder/gekiso-timing";
import { gekisoTimingView } from "./shared/gekiso-timing";
import { byScoreRank, isSongScoreRank, roomRequiredScore, scoreRankName } from "../lib/chart-rates";
import { clientText } from "../i18n/client";
import { scoreRankIcon } from "./shared/score-rank";
import "./song-room-calculator";
import "./song-score-targets";
import type { ChartRates } from "../lib/chart-rates";
import { formatDate } from "../lib/date-format";

type Item = Record<string, unknown>;

export interface SongRewardRenderOptions {
  item: Item;
  chart: Item;
  server: string;
  label(key: string, fallback: string): string;
  localized(value: unknown): string;
  locale: string;
  /** This song's chart rates by difficulty, and the song analysis address. */
  chartRates?: { greatFactor: number; charts: Record<string, ChartRates> };
  analysisHref?: string;
}

export interface SongSummaryRenderOptions {
  item: Item;
  meta: Item;
  nativeScore?: number | null;
  difficulty: Item[];
  selectedDifficulty: number;
  locale: string;
  /** Gekisou (撃奏) summary: song-level mission pattern and the per-difficulty
   * segment metrics from the song-meta entry. */
  gekisou: Item;
  metaView?: { mode: string; tier: string; band: number };
  chartRates?: { greatFactor: number; charts: Record<string, ChartRates> };
  /** False for a game without BanG Dream scoring: only level and note count apply. */
  scoring?: boolean;
  label(key: string, fallback: string): string;
  detailLabel(key: string): string;
  fieldValue(item: Item, key: string): string;
  selectDifficulty(index: number): void;
  onChartReady?(detail: SongChartReady): void;
}

function estimatedDifficulty(row: Item | undefined, locale: string) {
  if (!difficultyEstimatesEnabled()) return undefined;
  const estimate = row?.difficultyEstimate as Item | undefined;
  const quality = estimate?.quality as Item | undefined;
  const value = estimate?.estimatedConstant;
  if (
    estimate?.target !== "fc-operation-load" ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !["estimated", "low-confidence"].includes(String(quality?.status))
  )
    return undefined;
  return value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function renderSongSummary(options: SongSummaryRenderOptions) {
  const {
    item,
    meta,
    nativeScore,
    difficulty,
    selectedDifficulty,
    locale,
    gekisou,
    label,
    detailLabel,
    fieldValue,
    selectDifficulty,
    metaView,
    scoring = true,
  } = options;
  const percentage = (value: unknown) =>
    value !== null && value !== undefined && Number.isFinite(Number(value))
      ? `${(Number(value) * 100).toLocaleString(locale, { maximumFractionDigits: 0 })}%`
      : "—";
  const decimal = (value: unknown, digits = 0) =>
    value !== null && value !== undefined && Number.isFinite(Number(value))
      ? Number(value).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : "—";
  const duration = (value: unknown) => {
    const seconds = Math.max(0, Math.round(Number(value || 0)));
    return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—";
  };
  const minimum = Number(meta.minBpm ?? meta.firstBpm ?? 0);
  const maximum = Number(meta.maxBpm ?? meta.firstBpm ?? 0);
  const bpm = minimum || maximum ? (minimum === maximum ? String(minimum) : `${minimum}–${maximum}`) : "—";
  const profiles = (meta.profiles as Record<string, Item> | undefined) || {};
  const tier = metaView?.tier || "theory";
  const estimated = metaView?.mode === "gekisou";
  const selected = estimated
    ? gekisou
    : tier === "theory"
      ? meta
      : profiles[tier === "band" ? `band:${metaView?.band || 0}` : "current"] || {};
  const officialLevel =
    meta.displayLevel ??
    difficulty[selectedDifficulty]?.displayLevel ??
    difficulty[selectedDifficulty]?.playLevel ??
    meta.r;
  const estimatedLevel = estimatedDifficulty(difficulty[selectedDifficulty], locale);
  const level: [string, string, string] = [
    "metaOfficialLevel",
    "Official level",
    officialLevel !== null && officialLevel !== undefined && Number.isFinite(Number(officialLevel))
      ? Number(officialLevel).toLocaleString(locale, { maximumFractionDigits: 20 })
      : "—",
  ];
  // Chart figures follow the difficulty picker; the picker already shows the
  // level, so repeating it here would be one figure twice over one control.
  const metrics: Array<[string, string, string]> = !scoring
    ? [level, ["metaN", "Note Count", decimal(meta.n ?? difficulty[selectedDifficulty]?.noteCount)]]
    : [
        ...(estimatedLevel === undefined
          ? []
          : ([["difficultyEstimatedConstant", "Estimated constant", estimatedLevel]] as Array<
              [string, string, string]
            >)),
        ["metaTime", "Song Duration", duration(meta.time)],
        ["metaBpm", "Beats per Minute", bpm],
        ["metaN", "Note Count", decimal(meta.n ?? difficulty[selectedDifficulty]?.noteCount)],
        ["metaNps", "Notes per Second", decimal(meta.nps, 1)],
        ["metaSr", "Skill Coverage Rate", percentage(estimated ? undefined : selected.sr)],
        ["metaScoreFactor", "Factor", percentage(selected.score)],
        ["metaEff", "Efficiency", percentage(selected.eff)],
        ...(nativeScore === undefined
          ? []
          : ([["metaNativeScore", "Score", decimal(nativeScore, 2)]] as Array<[string, string, string]>)),
      ];
  const facts: Array<{ key: string; value: string }> = ["composer", "lyricist", "arranger", "publishedAt"].flatMap(
    (key) => {
      const raw = item[key];
      const timestamp = Number(Array.isArray(raw) ? raw.find((entry) => Number(entry) > 0) : raw || 0);
      const value =
        key === "publishedAt" && timestamp
          ? formatDate(locale, timestamp)
          : fieldValue(item, key);
      return value ? [{ key, value }] : [];
    },
  );
  return html`
    ${
      facts.length
        ? html`
            ${songDetailSection(
              label("details", "Details"),
              "details",
              html`
                <dl class="spec-list spec-list--split">
                  ${facts.map(
                  ({ key, value }) => html`
                    <div>
                      <dt>${detailLabel(key)}</dt>
                      <dd lang=${resolveLocalizedText(item[key], locale).locale}>${value}</dd>
                    </div>
                  `,
                )}
                </dl>
              `,
            )}
          `
        : nothing
    }
    ${songChartSummary({
      title: label("chart", "Chart"),
      difficulty: difficulty.length
        ? difficultyPicker({
            rows: difficulty,
            selected: difficultyKey(difficulty[selectedDifficulty] || {}, selectedDifficulty),
            locale,
            onSelect: (_key, index) => selectDifficulty(index),
          })
        : nothing,
      metrics: metrics.map(([key, fallback, value]) => ({
        label: label(key, fallback),
        value,
        lang: resolveLocalizedText(item[key], locale).locale,
      })),
    })}
    ${renderGekisouStages({ item, gekisou, label, locale })}
    ${
      scoring
        ? html`
            <song-skill-points
              source=${String(difficulty[selectedDifficulty]?.file || "")}
              locale=${locale}
              .rates=${options.chartRates?.charts[`${item.musicId}:${difficulty[selectedDifficulty]?.difficulty}`] ?? null}
              .greatFactor=${options.chartRates?.greatFactor ?? 0.8}
              chartId=${String(difficulty[selectedDifficulty]?.scoreId ?? difficulty[selectedDifficulty]?.id ?? "")}
              @song-chart-ready=${(event: CustomEvent<SongChartReady>) => options.onChartReady?.(event.detail)}
            ></song-skill-points>
          `
        : nothing
    }
  `;
}

/** The song-level Gekisou stage pattern, shown after the chart figures. */
export function renderGekisouStages({
  item,
  gekisou,
  label,
  locale,
}: {
  item: Item;
  gekisou?: Item;
  label(key: string, fallback: string): string;
  locale: string;
}) {
  const itemGekisou = (item.gekisou as Item | undefined) || {};
  const gekisouData = gekisou || {};
  const missionPattern = Array.isArray(gekisouData.missionPattern)
    ? gekisouData.missionPattern
    : Array.isArray(itemGekisou.missionPattern)
      ? itemGekisou.missionPattern
      : [];
  const missionTypes = Array.isArray(gekisouData.missionTypes)
    ? gekisouData.missionTypes
    : Array.isArray(itemGekisou.missionTypes)
      ? itemGekisou.missionTypes
      : missionPattern;
  const missionIcons = (gekisouData.icons || itemGekisou.icons || {}) as Record<string, string>;
  const segments = Array.isArray(gekisouData.segments) ? (gekisouData.segments as Item[]) : [];
  const stageCount = Math.max(missionTypes.length, missionPattern.length, segments.length);
  const stageTypes = Array.from({ length: stageCount }, (_, index) => missionTypes[index] ?? missionPattern[index]);
  const cells = stageTypes.flatMap((type, index) => {
    const mission = gekisouMission(type);
    if (!mission) return [];
    const image = missionIcons[mission.icon];
    return html`
      <li>
        ${image ? gameGlyph(image) : nothing}
        <span>
          <small><span aria-hidden="true">${index + 1}</span><span class="sr-only">${label("gekisouSegment", "Gekisou stage")} ${index + 1}</span></small>
          <strong>${label(mission.key, mission.fallback)}</strong>
          ${mission.icon === "combo" ? html`<span class="song-gekisou-timing-slot">${gekisoTimingView(segments[index]?.timing as GekisoTimingSegment | undefined, locale, label)}</span>` : nothing}
        </span>
      </li>
    `;
  });
  return cells.length
    ? html`
        <section class="detail-section song-detail-section song-gekisou-section">
          ${renderDetailSectionHeading(label("gekisouStages", "Gekisou stages"), "effects")}
          <ol class="song-gekisou-stages">
            ${cells}
          </ol>
        </section>
      `
    : nothing;
}

export function renderSongRewards({
  item,
  chart,
  server,
  label,
  localized,
  locale,
  chartRates,
  analysisHref,
}: SongRewardRenderOptions) {
  const rates = chartRates?.charts[String(chart.difficulty ?? "")] ?? null;
  const targets = rates
    ? html`
        <song-score-targets
          .rates=${rates}
          .greatFactor=${chartRates!.greatFactor}
          server=${server}
          locale=${locale}
          href=${analysisHref ?? ""}
        ></song-score-targets>
      `
    : nothing;
  const ranks = byScoreRank(
    (Array.isArray(item.scoreRanks) ? (item.scoreRanks as Item[]) : []).filter((rank) =>
      isSongScoreRank(Number(rank.scoreRank || 0)),
    ),
    (rank) => Number(rank.scoreRank),
  );
  const scoreRewards = byScoreRank(Array.isArray(item.scoreRewards) ? (item.scoreRewards as Item[]) : [], (reward) =>
    Number(reward.liveScoreRank || 99),
  );
  const comboRewards = item.comboRewards && typeof item.comboRewards === "object" ? (item.comboRewards as Item) : {};
  const active = String(chart.difficultyName || "").toLowerCase();
  const rewardValue = (reward: Item) => {
    const resolved = (reward.resolved as Item | undefined) || {};
    return {
      image: String(resolved.image || ""),
      name: localized(resolved.name) || String(reward.resourceTypeName || "Reward"),
      count: Number(reward.resourceCount || 0).toLocaleString(),
    };
  };
  const combo = Object.entries(comboRewards)
    .filter(([difficulty]) => !active || difficulty.toLowerCase() === active)
    .flatMap(([, value]) => (Array.isArray(value) ? (value as Item[]) : []));
  const scoreRankIds = byScoreRank(
    [
      ...new Set([
        ...ranks.map((rank) => Number(rank.scoreRank)),
        ...scoreRewards.map((reward) => Number(reward.liveScoreRank)),
      ]),
    ].filter(isSongScoreRank),
    (rank) => rank,
  );
  const scoreLabel = clientText(locale, "catalog.analysis.fields.rankScore", "Score");
  const comboLabel = clientText(locale, "catalog.items.combo", "Combo");
  const renderReward = (reward: Item) => {
    const value = rewardValue(reward);
    // The icon slot is always present (26dp) so reward names form one
    // column whether or not a reward has artwork, and nothing reflows as
    // the artwork arrives.
    const image = value.image
      ? html`
          <img src=${value.image} alt="" width="26" height="26" decoding="async" />
        `
      : html`
          <span class="song-reward-value__placeholder" aria-hidden="true">${icon("redeem", 18)}</span>
        `;
    return html`
      <span class="song-reward-value">
        ${image}
        <span>
          ${value.name}
          <b>×${value.count}</b>
        </span>
      </span>
    `;
  };
  const comboPercentages = [25, 50, 75, 100];
  const roomRanks = byScoreRank(
    ranks.filter((rank) => Number(rank.battleLiveRequiredScore || 0) > 0),
    (rank) => Number(rank.scoreRank),
  );
  const players = [1, 2, 3, 4, 5];
  const hasScore = scoreRankIds.length > 0;
  const hasCombo = combo.length > 0;
  const scoreList = hasScore
    ? html`
        <div class="stack stack--tight">
          <h4 class="song-detail-subheading">${scoreLabel}</h4>
          <ul class="song-reward-list">
            ${scoreRankIds.map((rankId) => {
              const rank = ranks.find((entry) => Number(entry.scoreRank) === rankId);
              const rewards = scoreRewards.filter((entry) => Number(entry.liveScoreRank) === rankId);
              return html`
                <li>
                  ${scoreRankIcon(server, rankId)}
                  <span class="song-reward-list__condition">
                    <strong>${rank ? Number(rank.requiredScore || 0).toLocaleString() : scoreRankName(rankId)}</strong>
                  </span>
                  <div>${rewards.map(renderReward)}</div>
                </li>
              `;
            })}
          </ul>
        </div>
      `
    : nothing;
  const comboList = hasCombo
    ? html`
        <div class="stack stack--tight">
          <h4 class="song-detail-subheading">${comboLabel}</h4>
          <ul class="song-reward-list song-combo-list">
            ${combo.map((reward) => {
              const value = rewardValue(reward);
              const percentage = comboPercentages[Number(reward.comboRateType || 0)] || 0;
              const count =
                Number(reward.comboCount || 0) ||
                (percentage && Number(chart.noteCount) ? Math.ceil((Number(chart.noteCount) * percentage) / 100) : 0);
              return html`
                <li>
                  <span class="song-reward-list__condition">
                    <strong>${percentage === 100 ? "FULL COMBO" : `${percentage}%`}</strong>
                    <small>${count ? count.toLocaleString() : "—"} ${label("notes", "notes")}</small>
                  </span>
                  <span class="song-reward-value">
                    ${
                      value.image
                        ? html`
                            <img src=${value.image} alt="" width="26" height="26" decoding="async" />
                          `
                        : html`
                            <span class="song-reward-value__placeholder" aria-hidden="true">${icon("redeem", 18)}</span>
                          `
                    }
                    <span>
                      ${value.name}
                      <b>×${value.count}</b>
                    </span>
                  </span>
                </li>
              `;
            })}
          </ul>
        </div>
      `
    : nothing;
  const rooms = roomRanks.length
    ? html`
        <section class="detail-section song-detail-section song-room-section">
          ${renderDetailSectionHeading(label("catalog.analysis.fields.gekisouRoomScores", "Gekisou room scores"), "characters")}
          <div
            class="table-scroll"
            role="region"
            tabindex="0"
            aria-label=${label("catalog.analysis.fields.gekisouRoomScores", "Gekisou room scores")}
            data-scroll-region
          >
            <table class="data-table song-room-table">
              <thead>
                <tr>
                  <th scope="col">${label("catalog.analysis.fields.deckRank", "Target rank")}</th>
                  ${players.map(
                    (count) => html`
                      <th scope="col" class="is-numeric">
                        ${(count === 1 ? label("catalog.analysis.fields.roomPlayer", "1 player") : label("catalog.analysis.fields.roomPlayers", "{count} players")).replace("{count}", String(count))}
                      </th>
                    `,
                  )}
                </tr>
              </thead>
              <tbody>
                ${roomRanks.map((rank) => {
                  return html`
                    <tr>
                      <th scope="row">${scoreRankIcon(server, Number(rank.scoreRank))}</th>
                      ${players.map(
                        (count) => html`
                          <td class="is-numeric tabular">
                            ${roomRequiredScore(Number(rank.battleLiveRequiredScore), count).toLocaleString()}
                          </td>
                        `,
                      )}
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>
          <song-room-calculator
            .ranks=${roomRanks.map((rank) => [Number(rank.scoreRank), Number(rank.battleLiveRequiredScore)] as [number, number])}
            server=${server}
            locale=${locale}
          ></song-room-calculator>
        </section>
      `
    : nothing;
  return html`
    ${
      hasScore || hasCombo
        ? html`
            <section class="detail-section song-detail-section song-rewards-section">
              ${renderDetailSectionHeading(label("rewards", "Rewards"), "rewards", {
                count: scoreRankIds.length + combo.length,
              })}
              <div class=${`song-detail-section__body${hasScore && hasCombo ? " detail-columns" : ""}`}>
                ${scoreList}${comboList}
              </div>
            </section>
          `
        : nothing
    }
    ${targets}${rooms}
  `;
}
