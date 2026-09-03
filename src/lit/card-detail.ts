import { html, nothing } from "lit";
import "../styles/card-detail.css";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

export function cardControlData(c: Controller, item: Item) {
  const support = c.profile.presentation === "support";
  const view = support ? "support-card-levels" : "member-card-levels";
  const levelGroup = Number(support ? item.supportCardLevelGroup : item.memberCardLevelGroup);
  const levelRows = c
    .itemsFrom(c.detailAux[view])
    .filter((row: Item) => Number(row.group) === levelGroup)
    .sort((a: Item, b: Item) => Number(a.level) - Number(b.level));
  const awakeRows = c
    .progressionRows("memberCardAwake")
    .filter((row: Item) => Number(row._group) === Number(item.memberCardAwakeGroup || 1))
    .sort((a: Item, b: Item) => Number(a._awakeCount) - Number(b._awakeCount));
  const rankRows = c
    .progressionRows("memberCardRanks")
    .filter((row: Item) => Number(row._group) === Number(item.memberCardRankGroup || 1))
    .sort((a: Item, b: Item) => Number(a._rank) - Number(b._rank));
  const supportRankRows = c
    .progressionRows("supportCardRanks")
    .filter((row: Item) => Number(row._group) === Number(item.supportCardRankGroup || item.supportCardLevelGroup))
    .sort((a: Item, b: Item) => Number(a._rank) - Number(b._rank));
  const training = c.uniqueNumbers(awakeRows.map((row: Item) => row._awakeCount));
  const awakening = c.uniqueNumbers(rankRows.map((row: Item) => row._rank));
  const rank = c.uniqueNumbers(supportRankRows.map((row: Item) => row._rank));
  const skill = (name: string) => (item.resolvedSkills as Item | undefined)?.[name] as Item | undefined;
  const skillLevels = (value: Item | undefined) =>
    c.uniqueNumbers((Array.isArray(value?.effects) ? (value.effects as Item[]) : []).map((effect) => effect.level));
  const live = skillLevels(skill("live"));
  const gekisou = skillLevels(skill("gekisou"));
  const stage = c.detailTraining || training.at(-1) || 0;
  const memberCap = c
    .progressionRows("memberCardLevelLimits")
    .find((row: Item) => Number(row._rarity) === Number(item.rarity) && Number(row._awakeCount) === stage)?._limitLevel;
  const supportCap = supportRankRows.find((row: Item) => Number(row._rank) === c.detailRank)?._limitLevel;
  const cap = Number(support ? supportCap || 0 : memberCap || 0);
  const levels = c
    .uniqueNumbers(levelRows.map((row: Item) => row.level))
    .filter((level: number) => !cap || level <= cap);
  return { support, levelRows, awakeRows, rankRows, supportRankRows, training, awakening, rank, live, gekisou, levels };
}

export function initializeCardDetailState(c: Controller, item: Item) {
  if (!["member", "support"].includes(c.profile.presentation)) return;
  const data = cardControlData(c, item);
  c.detailTraining = data.training.at(-1) || 1;
  c.detailAwakening = data.awakening.at(-1) || 1;
  c.detailRank = data.rank.at(-1) || 1;
  c.detailLiveLevel = data.live.at(-1) || 1;
  c.detailGekisouLevel = data.gekisou.at(-1) || 1;
  c.detailLevel = cardControlData(c, item).levels.at(-1) || 1;
}

function renderLevelSwitch(
  c: Controller,
  label: string,
  levels: number[],
  value: number,
  update: (value: number) => void,
) {
  void c;
  if (levels.length < 2) return nothing;
  const index = Math.max(0, levels.indexOf(value));
  return html`
    <div class="detail-level-switch">
      <span class="detail-level-switch__value">
        <small>${label}</small>
        <strong>${value}</strong>
      </span>
      <button
        class="icon-button"
        ?disabled=${index === 0}
        @click=${() => update(levels[index - 1] || value)}
        aria-label=${`${label} ${levels[index - 1] || value}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#remove"></use></svg>
      </button>
      <md-slider
        class="md3-slider"
        min="0"
        max=${levels.length - 1}
        step="1"
        .value=${String(index)}
        @input=${(event: Event) => update(levels[Number((event.target as HTMLElement & { value?: number }).value)] || value)}
        aria-label=${label}
        aria-valuetext=${String(value)}
      ></md-slider>
      <button
        class="icon-button"
        ?disabled=${index === levels.length - 1}
        @click=${() => update(levels[index + 1] || value)}
        aria-label=${`${label} ${levels[index + 1] || value}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#add"></use></svg>
      </button>
    </div>
  `;
}

export function renderCardStats(c: Controller, item: Item) {
  if (!["member", "support"].includes(c.profile.presentation)) return nothing;
  const data = cardControlData(c, item);
  const selected = data.levelRows.find((row: Item) => Number(row.level) === c.detailLevel) || data.levelRows.at(-1);
  const training = data.support
    ? {}
    : data.awakeRows.find((row: Item) => Number(row._awakeCount) === c.detailTraining) || {};
  const awakening = data.support
    ? {}
    : data.rankRows.find((row: Item) => Number(row._rank) === c.detailAwakening) || {};
  const rate = (key: string) => {
    const name = key === "technique" ? "technic" : key;
    return (
      Number(selected?.[`${name}Rate`] || 10000) +
      Number(training[`_${name}Rate`] || 0) +
      Number(awakening[`_${name}Rate`] || 0)
    );
  };
  const value = (key: string) => Math.floor((c.stat(item, key) * rate(key)) / 10000);
  const stats = [value("performance"), value("technique"), value("visual")];
  return html`
    <section class="detail-section card-stat-section">
      ${c.detailSectionTitle(c.label("stats", "Stats"), "monitoring")}
      <div class="card-detail-controls">
        ${renderLevelSwitch(c, c.label("level", "Level"), data.levels, c.detailLevel, (value) => {
          c.detailLevel = value;
          c.persistCardDetailQuery();
        })}${
          data.support
            ? renderLevelSwitch(c, c.label("rank", "Rank"), data.rank, c.detailRank, (value) => {
                c.detailRank = value;
                const next = cardControlData(c, item).levels;
                if (!next.includes(c.detailLevel)) c.detailLevel = next.at(-1) || 1;
                c.persistCardDetailQuery();
              })
            : html`
                <div class="card-detail-controls__pair">
                  ${renderLevelSwitch(c, c.label("training", "Training"), data.training, c.detailTraining, (value) => {
                    c.detailTraining = value;
                    const next = cardControlData(c, item).levels;
                    if (!next.includes(c.detailLevel)) c.detailLevel = next.at(-1) || 1;
                    c.persistCardDetailQuery();
                  })}${renderLevelSwitch(
                    c,
                    c.label("awakening", "Awakening"),
                    data.awakening,
                    c.detailAwakening,
                    (value) => {
                      c.detailAwakening = value;
                      c.persistCardDetailQuery();
                    },
                  )}
                </div>
                <div class="card-detail-controls__pair">
                  ${renderLevelSwitch(c, c.label("liveSkill", "LIVE Skill"), data.live, c.detailLiveLevel, (value) => {
                    c.detailLiveLevel = value;
                    c.persistCardDetailQuery();
                  })}${renderLevelSwitch(
                    c,
                    c.label("gekisouSkill", "Gekisou Skill"),
                    data.gekisou,
                    c.detailGekisouLevel,
                    (value) => {
                      c.detailGekisouLevel = value;
                      c.persistCardDetailQuery();
                    },
                  )}
                </div>
              `
        }
      </div>
      <div class="card-stat-grid">
        ${[
          ["performance", stats[0]],
          ["technique", stats[1]],
          ["visual", stats[2]],
          ...(data.support ? [] : [["total", stats.reduce((sum, stat) => sum + stat, 0)]]),
          ["exp", Number(selected?.exp || 0)],
        ].map(
          ([key, stat]) => html`
            <div>
              <span>${c.label(String(key), String(key))}</span>
              <strong>
                ${data.support && key !== "exp" ? `${(Number(stat) / 100).toFixed(2)}%` : Number(stat).toLocaleString()}
              </strong>
            </div>
          `,
        )}
      </div>
      ${c.renderCardCosts(item, data)}
    </section>
  `;
}

export function renderCardRelations(c: Controller, item: Item) {
  if (!["member", "support"].includes(c.profile.presentation)) return nothing;
  const ids = c.itemCharacterIds(item);
  return ids.length
    ? html`
        <section class="detail-section">
          ${c.detailSectionTitle(c.label("characters", "Characters"), "group")}
          <div class="card-relation-list">
            ${ids.map((id: number) => {
              const character = c.character(id);
              const image = String(character?.faceImage || character?.thumbnailImage || "");
              return html`
                <a
                  href=${`${location.pathname.replace(/\/catalog\/(?:member-cards|support-cards)$/u, "/catalog/characters")}?character=${id}`}
                >
                  ${
                    image
                      ? html`
                          <img src=${image} alt="" />
                        `
                      : nothing
                  }
                  <span>${c.characterName(id)}</span>
                  <svg class="material-icon" width="16" height="16"><use href="/icons.svg#north_east"></use></svg>
                </a>
              `;
            })}
          </div>
        </section>
      `
    : nothing;
}
