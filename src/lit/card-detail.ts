import { memberStat, snapshotPercent } from "../lib/card-growth";
import { html, nothing } from "lit";
import "../styles/card-detail.css";
import { renderLevelSwitch } from "./ui/level-switch";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "./character-voices";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

function renderCardVoice(c: Controller, item: Item) {
  const voice = c.detailAux.gachaVoice as Item | undefined;
  if (c.profile.presentation !== "member" || !voice) return nothing;
  return html`
    <character-voices
      compact
      .entries=${[voice]}
      .characters=${c.characters}
      .characterId=${Number(item.characterId)}
      locale=${c.contentLocale}
      .server=${c.contentServer}
    ></character-voices>
  `;
}

export function cardControlData(c: Controller, item: Item) {
  const selectValue = (values: number[], current: unknown) => {
    if (!values.length) {
      const fallback = Number(current);
      return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
    }
    const value = Number(current);
    if (!Number.isFinite(value)) return values.at(-1) || 1;
    if (value <= values[0]) return values[0];
    if (value >= values.at(-1)!) return values.at(-1) || 1;
    return values.includes(value)
      ? value
      : values.reduce((closest, candidate) =>
          Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
        );
  };
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
  // Master progression values are authored as game values (1..N). The
  // slider uses zero-based indices only at render time. Clamp stale query
  // values here so an injected `training=0`, `level=70` at stage 1, etc.
  // cannot select a row outside the card's authored progression.
  c.detailTraining = selectValue(training, c.detailTraining);
  c.detailAwakening = selectValue(awakening, c.detailAwakening);
  c.detailRank = selectValue(rank, c.detailRank);
  c.detailLiveLevel = selectValue(live, c.detailLiveLevel);
  c.detailGekisouLevel = selectValue(gekisou, c.detailGekisouLevel);
  const stage = c.detailTraining || training.at(-1) || 0;
  const memberCap = c
    .progressionRows("memberCardLevelLimits")
    .find((row: Item) => Number(row._rarity) === Number(item.rarity) && Number(row._awakeCount) === stage)?._limitLevel;
  const supportCap = supportRankRows.find((row: Item) => Number(row._rank) === c.detailRank)?._limitLevel;
  const cap = Number(support ? supportCap || 0 : memberCap || 0);
  const levels = c
    .uniqueNumbers(levelRows.map((row: Item) => row.level))
    .filter((level: number) => !cap || level <= cap);
  c.detailLevel = selectValue(levels, c.detailLevel);
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
  const value = (key: string) => {
    const name = key === "technique" ? "technic" : key;
    const maximum = c.stat(item, key);
    const level = Number(selected?.[`${name}Rate`] ?? 10000);
    return data.support ? snapshotPercent(maximum, level) : memberStat(
      maximum, level, Number(training[`_${name}Rate`] ?? 0), Number(awakening[`_${name}Rate`] ?? 0),
    );
  };
  const stats = [value("performance"), value("technique"), value("visual")];
  return html`
    <section class="detail-section card-stat-section">
      ${renderDetailSectionHeading(c.label("stats", "Stats"), "stats")}
      <div class="card-detail-controls">
        ${renderLevelSwitch(c.label("level", "Level"), data.levels, c.detailLevel, (value) => {
          c.detailLevel = value;
          c.persistCardDetailQuery();
        })}${
          data.support
            ? renderLevelSwitch(c.label("rank", "Rank"), data.rank, c.detailRank, (value) => {
                c.detailRank = value;
                const next = cardControlData(c, item).levels;
                if (!next.includes(c.detailLevel)) c.detailLevel = next.at(-1) || 1;
                c.persistCardDetailQuery();
              })
            : html`
                <div class="card-detail-controls__pair">
                  ${renderLevelSwitch(c.label("training", "Training"), data.training, c.detailTraining, (value) => {
                    c.detailTraining = value;
                    const next = cardControlData(c, item).levels;
                    if (!next.includes(c.detailLevel)) c.detailLevel = next.at(-1) || 1;
                    c.persistCardDetailQuery();
                  })}${renderLevelSwitch(
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
                  ${renderLevelSwitch(c.label("liveSkill", "LIVE Skill"), data.live, c.detailLiveLevel, (value) => {
                    c.detailLiveLevel = value;
                    c.persistCardDetailQuery();
                  })}${renderLevelSwitch(
                    c.label("gekisouSkill", "GEKISO Skill"),
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
          ${renderDetailSectionHeading(c.label("characters", "Characters"), "characters", { count: ids.length })}
          <div class="card-relation-list">
            ${ids.map((id: number) => {
              const character = c.character(id);
              const image = String(character?.faceImage || character?.thumbnailImage || "");
              return html`
                <a href=${c.relatedEntityHref("characters", String(id))}>
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
          ${renderCardVoice(c, item)}
        </section>
      `
    : nothing;
}
