import { html, nothing } from "lit";

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
      <h3 class="detail-section-title">
        <span>
          <svg class="material-icon" width="18" height="18"><use href="/icons.svg#info"></use></svg>
        </span>
        ${label("details", "Details")}
      </h3>
      ${
        difficulty.length
          ? html`
              <div class="difficulty-segments">
                ${difficulty.map(
                  (row, index) => html`
                    <button
                      class=${`difficulty-${index}`}
                      aria-pressed=${selectedDifficulty === index}
                      aria-label=${`${String(row.difficultyName || "")} ${String(row.displayLevel || "")}`}
                      style=${`--difficulty-color:var(--md-extended-color-difficulty-${String(row.difficultyName || "master").toLowerCase()}, ${["#35a969", "#3c8ed5", "#d99d1e", "#d94e56", "#8c62d6"][index] || "#8c62d6"})`}
                      @click=${() => selectDifficulty(index)}
                    >
                      <b>${row.displayLevel}</b>
                    </button>
                  `,
                )}
              </div>
            `
          : nothing
      }
      <dl class="song-data-grid song-meta-strip">
        ${metrics.map(
          ([key, fallback, value]) => html`
            <div>
              <dt title=${label(key, fallback)}>${label(key, fallback)}</dt>
              <dd>${value}</dd>
            </div>
          `,
        )}
      </dl>
      <dl class="song-data-grid song-detail-facts">
        ${facts.map(
          ({ key, value }) => html`
            <div>
              <dt>${detailLabel(key)}</dt>
              <dd>${value}</dd>
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
      <h3 class="detail-section-title">
        <span>
          <svg class="material-icon" width="18" height="18"><use href="/icons.svg#emoji_events"></use></svg>
        </span>
        ${label("rewards", "Rewards")}
      </h3>
      <div class="song-detail-section__body">
        <dl class="song-data-grid song-score-grid" aria-label=${label("scoreRanks", "Score ranks")}>
          ${ranks.map((rank) => {
            const rankName = names[Number(rank.scoreRank)] || "—";
            return html`
              <div>
                <dt><img class="song-rank-icon" src=${rankIcon(rankName)} alt=${rankName} /></dt>
                <dd>${Number(rank.requiredScore || 0).toLocaleString()}</dd>
              </div>
            `;
          })}
        </dl>
        <dl class="song-data-grid song-reward-items" aria-label=${label("scoreRanks", "Score ranks")}>
          ${scoreRewards.map((reward) => {
            const rankName = names[Number(reward.liveScoreRank)] || "—";
            const value = rewardValue(reward);
            return html`
              <div>
                <dt><img class="song-rank-icon" src=${rankIcon(rankName)} alt=${rankName} /></dt>
                <dd class="song-reward-value">
                  ${
                    value.image
                      ? html`
                          <img src=${value.image} alt="" />
                        `
                      : nothing
                  }
                  <span>${value.name} ×${value.count}</span>
                </dd>
              </div>
            `;
          })}
        </dl>
        <dl class="song-data-grid song-combo-rewards" aria-label=${label("combo", "Combo")}>
          ${combo.map((reward) => {
            const value = rewardValue(reward);
            const index = Number(reward.comboRateType || 0);
            const percentage = comboPercentages[index] || 0;
            const explicit = Number(reward.comboCount || 0);
            const notes = Number(chart.noteCount || 0);
            const count = explicit || (percentage && notes ? Math.ceil((notes * percentage) / 100) : 0);
            return html`
              <div>
                <dt>${count ? count.toLocaleString() : "—"} · ${percentage === 100 ? "FULL" : `${percentage}%`}</dt>
                <dd class="song-reward-value">
                  ${
                    value.image
                      ? html`
                          <img src=${value.image} alt="" />
                        `
                      : nothing
                  }
                  <span>${value.name} ×${value.count}</span>
                </dd>
              </div>
            `;
          })}
        </dl>
      </div>
    </section>
  `;
}
