import { difficultyKey, difficultyPicker } from "./ui/difficulty-picker";
import { resolveLocalizedText } from "../lib/localized-text";
import { html, nothing } from "lit";
import { difficultyEstimatesEnabled } from "../lib/difficulty-display";
import "../styles/song-gekisou.css";
import { gekisouMission } from "../lib/gekisou";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { icon } from "./ui/icon";
import "./song-skill-points";

type Item = Record<string, unknown>;

export interface SongRewardRenderOptions {
  item: Item;
  chart: Item;
  server: string;
  label(key: string, fallback: string): string;
  localized(value: unknown): string;
}

export interface SongSummaryRenderOptions {
  item: Item;
  meta: Item;
  nativeScore?: number | null;
  difficulty: Item[];
  selectedDifficulty: number;
  locale: string;
  /** Gekisou (撃奏) summary: song-level mission pattern merged with the
   * per-difficulty segment metrics from the song-meta entry. */
  gekisou: Item;
  metaView?: { mode: string; tier: string; band: number };
  label(key: string, fallback: string): string;
  detailLabel(key: string): string;
  fieldValue(item: Item, key: string): string;
  selectDifficulty(index: number): void;
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
  const metrics: Array<[string, string, string]> = [
    [
      "metaOfficialLevel",
      "Official level",
      officialLevel !== null && officialLevel !== undefined && Number.isFinite(Number(officialLevel))
        ? Number(officialLevel).toLocaleString(locale, { maximumFractionDigits: 20 })
        : "—",
    ],
    ...(estimatedLevel === undefined
      ? []
      : ([["difficultyEstimateBeta", "Estimated difficulty · Beta", estimatedLevel]] as Array<[string, string, string]>)),
    ["metaTime", "Song Duration", duration(meta.time)],
    ...(nativeScore === undefined
      ? []
      : ([["metaNativeScore", "Score", decimal(nativeScore, 2)]] as Array<[string, string, string]>)),
    ["metaScoreFactor", label("metaScore", "Factor"), percentage(selected.score)],
    ["metaEff", "Score Efficiency per Minute", percentage(selected.eff)],
    ["metaBpm", "Beats per Minute", bpm],
    ["metaN", "Note Count", decimal(meta.n)],
    ["metaNps", "Notes per Second", decimal(meta.nps, 1)],
    ["metaSr", "Skill Coverage", percentage(estimated ? undefined : selected.sr)],
  ];
  const facts: Array<{ key: string; value: string }> = ["composer", "lyricist", "arranger", "publishedAt"].flatMap(
    (key) => {
      const raw = item[key];
      const timestamp = Number(Array.isArray(raw) ? raw.find((entry) => Number(entry) > 0) : raw || 0);
      const value =
        key === "publishedAt" && timestamp
          ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(
              new Date(timestamp),
            )
          : fieldValue(item, key);
      return value ? [{ key, value }] : [];
    },
  );
  const itemGekisou = (item.gekisou as Item | undefined) || {};
  const missionPattern = Array.isArray(gekisou.missionPattern)
    ? gekisou.missionPattern
    : Array.isArray(itemGekisou.missionPattern)
      ? itemGekisou.missionPattern
      : [];
  const missionTypes = Array.isArray(gekisou.missionTypes)
    ? gekisou.missionTypes
    : Array.isArray(itemGekisou.missionTypes)
      ? itemGekisou.missionTypes
      : missionPattern;
  const missionIcons = (gekisou.icons || itemGekisou.icons || {}) as Record<string, string>;
  const segments = Array.isArray(gekisou.segments) ? (gekisou.segments as Item[]) : [];
  const stageCount = Math.max(missionTypes.length, missionPattern.length, segments.length);
  const stageTypes = Array.from({ length: stageCount }, (_, index) => missionTypes[index] ?? missionPattern[index]);
  const gekisouCells = stageTypes.flatMap((type, index) => {
    const mission = gekisouMission(type);
    if (!mission) return [];
    const image = missionIcons[mission.icon];
    return html`
      <li>
        ${
          image
            ? html`
                <span
                  class="song-gekisou-stage__icon"
                  style=${`mask-image:url("${image}");-webkit-mask-image:url("${image}")`}
                  aria-hidden="true"
                ></span>
              `
            : nothing
        }
        <span>
          <small>${label("gekisouSegment", "Gekisou stage")} ${index + 1}</small>
          <strong>${label(mission.key, mission.fallback)}</strong>
        </span>
      </li>
    `;
  });
  return html`
    <section class="detail-section song-detail-section song-detail-summary">
      ${renderDetailSectionHeading(label("details", "Details"), "details")}
      ${difficulty.length ? difficultyPicker({ rows: difficulty, selected: difficultyKey(difficulty[selectedDifficulty] || {}, selectedDifficulty), locale, onSelect: (_key, index) => selectDifficulty(index) }) : nothing}
      <dl class="song-data-grid song-meta-strip">
        ${metrics.map(
          ([key, fallback, value]) => html`
            <div>
              <dt title=${key === "difficultyEstimateBeta" ? nothing : label(key, fallback)}>
                ${label(key, fallback)}
              </dt>
              <dd lang=${resolveLocalizedText(item[key], locale).locale}>
                ${value}
              </dd>
            </div>
          `,
        )}
      </dl>
      <dl class="song-data-grid song-detail-facts">
        ${facts.map(
          ({ key, value }) => html`
            <div>
              <dt>${detailLabel(key)}</dt>
              <dd lang=${resolveLocalizedText(item[key], locale).locale}>${value}</dd>
            </div>
          `,
        )}
      </dl>
    </section>
    <song-skill-points source=${String(difficulty[selectedDifficulty]?.file || "")} locale=${locale}></song-skill-points>
    ${
      gekisouCells.length
        ? html`
            <section class="detail-section song-detail-section song-gekisou-section">
              ${renderDetailSectionHeading(label("gekisouStages", "Gekisou stages"), "effects")}
              <ol class="song-gekisou-stages">
                ${gekisouCells}
              </ol>
            </section>
          `
        : nothing
    }
  `;
}

export function renderSongRewards({ item, chart, server, label, localized }: SongRewardRenderOptions) {
  const ranks = (Array.isArray(item.scoreRanks) ? (item.scoreRanks as Item[]) : []).filter(
    (rank) => Number(rank.scoreRank || 0) >= 3,
  );
  const scoreRewards = [...(Array.isArray(item.scoreRewards) ? (item.scoreRewards as Item[]) : [])].sort(
    (left, right) => Number(left.liveScoreRank || 99) - Number(right.liveScoreRank || 99),
  );
  const comboRewards = item.comboRewards && typeof item.comboRewards === "object" ? (item.comboRewards as Item) : {};
  if (!ranks.length && !scoreRewards.length && !Object.keys(comboRewards).length) return nothing;
  const names = ["", "E", "D", "C", "B", "A", "S", "SS"];
  const active = String(chart.difficultyName || "").toLowerCase();
  const rankIcon = (rank: string) =>
    `/assets/${server}/Assets/AddressableResources/UI/Texture/BandRank/ImgScorerank_${rank}.png`;
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
  const scoreRankIds = [
    ...new Set([
      ...ranks.map((rank) => Number(rank.scoreRank)),
      ...scoreRewards.map((reward) => Number(reward.liveScoreRank)),
    ]),
  ].sort((a, b) => a - b);
  const renderReward = (reward: Item) => {
    const value = rewardValue(reward);
    // The icon slot is always present (26dp) so reward names form one
    // column whether or not a reward has artwork, and nothing reflows as
    // the artwork arrives.
    const image = value.image
      ? html`
          <img src=${value.image} alt="" width="26" height="26" decoding="async" />
        `
      : html`<span class="song-reward-value__placeholder" aria-hidden="true">${icon("redeem", 18)}</span>`;
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
  return html`
    <section class="detail-section song-detail-section song-rewards-section">
      ${renderDetailSectionHeading(label("rewards", "Rewards"), "rewards", {
        count: ranks.length + scoreRewards.length + combo.length,
      })}
      <div class="song-detail-section__body detail-columns">
        <div class="stack stack--tight">
          <h3 class="song-detail-subheading">${label("score", "Score")}</h3>
          <ul class="song-reward-list">
            ${scoreRankIds.map((rankId) => {
              const rankName = names[rankId] || "—";
              const rank = ranks.find((entry) => Number(entry.scoreRank) === rankId);
              const rewards = scoreRewards.filter((entry) => Number(entry.liveScoreRank) === rankId);
              return html`
                <li>
                  <img src=${rankIcon(rankName)} alt=${rankName} width="28" height="28" decoding="async" />
                  <span class="song-reward-list__condition">
                    <strong>${rank ? Number(rank.requiredScore || 0).toLocaleString() : rankName}</strong>
                    <small>${label("score", "Score")}</small>
                  </span>
                  <div>${rewards.map(renderReward)}</div>
                </li>
              `;
            })}
          </ul>
        </div>
        <div class="stack stack--tight">
          <h3 class="song-detail-subheading">${label("combo", "Combo")}</h3>
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
                        : html`<span class="song-reward-value__placeholder" aria-hidden="true">${icon("redeem", 18)}</span>`
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
      </div>
    </section>
  `;
}
