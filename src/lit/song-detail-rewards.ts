import { difficultyKey, difficultyPicker } from "./ui/difficulty-picker";
import { resolveLocalizedText } from "../lib/localized-text";
import { html, nothing } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";

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
  difficulty: Item[];
  selectedDifficulty: number;
  locale: string;
  label(key: string, fallback: string): string;
  detailLabel(key: string): string;
  fieldValue(item: Item, key: string): string;
  selectDifficulty(index: number): void;
}

export function renderSongSummary(options: SongSummaryRenderOptions) {
  const { item, meta, difficulty, selectedDifficulty, locale, label, detailLabel, fieldValue, selectDifficulty } =
    options;
  const percentage = (value: unknown) =>
    value !== null && value !== undefined && Number.isFinite(Number(value))
      ? `${(Number(value) * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`
      : "—";
  const decimal = (value: unknown, digits = 0) =>
    value !== null && value !== undefined && Number.isFinite(Number(value))
      ? Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : "—";
  const duration = (value: unknown) => {
    const seconds = Math.max(0, Math.round(Number(value || 0)));
    return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—";
  };
  const minimum = Number(meta.minBpm ?? meta.firstBpm ?? 0);
  const maximum = Number(meta.maxBpm ?? meta.firstBpm ?? 0);
  const bpm = minimum || maximum ? (minimum === maximum ? String(minimum) : `${minimum}–${maximum}`) : "—";
  const metrics: Array<[string, string, string]> = [
    ["metaR", "Difficulty Rating", decimal(meta.r)],
    ["metaTime", "Song Duration", duration(meta.time)],
    ["metaScore", "Relative Score Factor", percentage(meta.score)],
    ["metaEff", "Score Efficiency per Minute", percentage(meta.eff)],
    ["metaBpm", "Beats per Minute", bpm],
    ["metaN", "Note Count", decimal(meta.n)],
    ["metaNps", "Notes per Second", decimal(meta.nps, 1)],
    ["metaSr", "Skill Coverage", percentage(meta.sr)],
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
  return html`
    <section class="detail-section song-detail-section song-detail-summary">
      ${renderDetailSectionHeading(label("details", "Details"), "details")}
      ${difficulty.length ? difficultyPicker({ rows: difficulty, selected: difficultyKey(difficulty[selectedDifficulty] || {}, selectedDifficulty), locale, onSelect: (_key, index) => selectDifficulty(index) }) : nothing}
      <dl class="song-data-grid song-meta-strip">
        ${metrics.map(
          ([key, fallback, value]) => html`
            <div>
              <dt title=${label(key, fallback)}>${label(key, fallback)}</dt>
              <dd lang=${resolveLocalizedText(item[key], locale).locale}>${value}</dd>
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
  const comboPercentages = [25, 50, 75, 100];
  return html`
    <section class="detail-section song-detail-section song-rewards-section">
      ${renderDetailSectionHeading(label("rewards", "Rewards"), "rewards", {
        count: ranks.length + scoreRewards.length + combo.length,
      })}
      <div class="song-detail-section__body">
        <h3 class="song-detail-subheading">${label("score", "Score")}</h3>
        <ul class="song-reward-list">
          ${[
            ...new Set([
              ...ranks.map((rank) => Number(rank.scoreRank)),
              ...scoreRewards.map((reward) => Number(reward.liveScoreRank)),
            ]),
          ]
            .sort((a, b) => a - b)
            .map((rankId) => {
              const rankName = names[rankId] || "—";
              const rank = ranks.find((entry) => Number(entry.scoreRank) === rankId);
              const rewards = scoreRewards.filter((entry) => Number(entry.liveScoreRank) === rankId);
              return html`
                <li>
                  <img src=${rankIcon(rankName)} alt=${rankName} />
                  <span class="song-reward-list__condition">
                    <strong>${rank ? Number(rank.requiredScore || 0).toLocaleString() : rankName}</strong>
                    <small>${label("score", "Score")}</small>
                  </span>
                  <div>
                    ${rewards.map((reward) => {
                      const value = rewardValue(reward);
                      return html`
                        <span class="song-reward-value">
                          ${
                            value.image
                              ? html`
                                  <img src=${value.image} alt="" />
                                `
                              : nothing
                          }
                          <span>
                            ${value.name}
                            <b>×${value.count}</b>
                          </span>
                        </span>
                      `;
                    })}
                  </div>
                </li>
              `;
            })}
        </ul>
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
                          <img src=${value.image} alt="" />
                        `
                      : nothing
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
    </section>
  `;
}
