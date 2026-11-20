import { html, nothing } from "lit";
import { accordion } from "../ui/accordion";
import { characterPair } from "../ui/character-pair";
import { icon } from "../ui/icon";
import { operationProgress } from "../ui/operation-progress";
import { renderDetailSectionHeading } from "../shared/detail-section-heading";
import { saveEntity, text, type SaveCatalog } from "../../lib/save-workspace/catalog";
import { missionDescription } from "../../lib/mission-description";
import type { SaveCharacter, SaveFriendship, SaveMission, SaveRank } from "../../lib/save-workspace/progress";

type Label = (key: string) => string;
type Growth = ReturnType<typeof import("../../lib/save-workspace/progress").saveAccountProgress>;

export function savePortrait(character?: SaveCharacter) {
  return html`<span class="save-portrait" aria-hidden="true">
    ${character?.image
      ? html`<img src=${character.image} alt="" loading="lazy" width="42" height="42" />`
      : icon("person", 20)}
  </span>`;
}

export function saveRankMeter(rank: SaveRank, t: Label, locale: string) {
  const number = new Intl.NumberFormat(locale);
  return html`
    <span class="save-rank-values">
      <strong>${rank.level ? `Lv. ${number.format(Number(rank.level))}` : "—"}</strong>
      <span>${rank.experience === null ? "—" : number.format(rank.experience)} ${t("experience")}</span>
    </span>
    ${rank.progress === null ? nothing
      : html`<span class="save-meter">${operationProgress(t("experience"), rank.progress / 100)}</span>`}
  `;
}

export function saveGrowthRow(label: string, data: SaveRank, portraits: readonly SaveCharacter[], t: Label, locale: string, onSelect?: () => void, active = false) {
  const content = html`
    <span class="save-row-portraits">${portraits.length ? portraits.map(savePortrait) : savePortrait()}</span>
    <span class="save-growth-row__text"><strong>${label}</strong>${saveRankMeter(data, t, locale)}</span>
    ${onSelect ? icon("chevron_right", 18) : nothing}
  `;
  return onSelect
    ? html`<button class="save-growth-row" type="button" aria-pressed=${String(active)} @click=${onSelect}>${content}</button>`
    : html`<div class="save-growth-row">${content}</div>`;
}

export const saveCharacterName = (character: SaveCharacter, t: Label) => character.name || `${t("id")} ${character.id}`;
export const savePairName = (pair: SaveFriendship, t: Label) =>
  pair.characters.length === 2 ? pair.characters.map(character => saveCharacterName(character, t)).join(" × ") : `${t("id")} ${pair.id}`;

function bandInfo(catalog: SaveCatalog | undefined, id: number, locale: string) {
  const row = saveEntity(catalog, "bands", id);
  return {
    id,
    label: text(row.name ?? row.bandName, locale) || String(id),
    image: typeof (row.icon ?? row.logo) === "string" ? String(row.icon ?? row.logo) : undefined,
  };
}

function missionList(missions: readonly SaveMission[], character: SaveCharacter | undefined, t: Label, locale: string) {
  const number = new Intl.NumberFormat(locale);
  return missions.length
    ? html`<ul class="save-missions" role="list">
        ${missions.map(mission => html`<li class="save-mission">
          <div class="save-mission__head">
            <strong>${mission.name || `${t("_characterMissions")} #${mission.id}`}</strong>
            ${mission.received || mission.completed
              ? html`<span class="chip chip--tonal chip--static">${icon("check", 16)}${t(mission.received ? "_isReceived" : "missionCompleted")}</span>`
              : nothing}
          </div>
          ${mission.description && mission.description !== mission.name ? html`<span>${missionDescription(mission.description, {
            CharacterId: character?.name ?? "",
            AchievementCount: mission.target === null ? "" : number.format(mission.target),
            Value: mission.value,
          })}</span>` : nothing}
          ${mission.progress !== null ? html`
            <span class="tabular">${number.format(mission.progress)}${mission.target === null ? "" : ` / ${number.format(mission.target)}`}</span>
          ` : nothing}
        </li>`)}
      </ul>`
    : html`<p class="save-empty">${t("noRecords")}</p>`;
}

export function saveCharactersView(options: {
  progress: Growth;
  catalog?: SaveCatalog;
  selected: string;
  band: number | null;
  t: Label;
  locale: string;
  onBand: (band: number) => void;
  onSelect: (id: string) => void;
}) {
  const { progress, catalog, t, locale, onBand, onSelect } = options;
  const bands = [...new Set(progress.characters.map(character => character.bandId))].map(id => bandInfo(catalog, id, locale));
  const band = options.band ?? bands[0]?.id;
  const characters = progress.characters.filter(character => character.bandId === band);
  const selected = characters.find(character => character.id === options.selected) ?? characters[0];
  const missions = selected ? progress.missions.get(selected.id) ?? [] : [];
  return html`
    <div class="save-growth-layout">
      <section class="surface stack">
        ${renderDetailSectionHeading(t("_characters"), "characters", { level: 2, count: progress.characters.length })}
        ${bands.length > 1 ? html`
          <div class="cluster save-bands" role="group" aria-label=${t("bands")}>
            ${bands.map(group => html`<button class="chip chip--filter" type="button" aria-pressed=${String(band === group.id)}
              @click=${() => onBand(group.id)}>${group.image ? html`<img src=${group.image} alt="" width="20" height="20" />` : nothing}
              <span class="chip__label">${group.label}</span></button>`)}
          </div>` : nothing}
        <div class="save-growth-list">
          ${characters.length ? characters.map(character =>
            saveGrowthRow(saveCharacterName(character, t), character, [character], t, locale, () => onSelect(character.id), selected?.id === character.id))
          : html`<p class="save-empty">${t("noRecords")}</p>`}
        </div>
      </section>
      <section class="surface stack" aria-live="polite">
        ${selected ? saveGrowthRow(saveCharacterName(selected, t), selected, [selected], t, locale) : nothing}
        ${renderDetailSectionHeading(t("_characterMissions"), "missions", { level: 2, count: missions.length })}
        ${missions.length ? html`
          <dl class="spec-list spec-list--split save-mission-counts">
            <div><dt>${t("missionCompleted")}</dt><dd>${missions.filter(mission => mission.completed).length}</dd></div>
            <div><dt>${t("_isReceived")}</dt><dd>${missions.filter(mission => mission.received).length}</dd></div>
          </dl>` : nothing}
        ${missionList(missions, selected, t, locale)}
      </section>
    </div>
  `;
}

export function saveFriendshipsView(options: {
  progress: Growth;
  catalog?: SaveCatalog;
  first: string;
  second: string;
  open: boolean;
  t: Label;
  locale: string;
  server: string;
  onChange: (first: string, second: string) => void;
  onOpen: (open: boolean) => void;
}) {
  const { progress, catalog, first, second, open, t, locale, server, onChange, onOpen } = options;
  const pairs = progress.friendships.filter(pair =>
    (!first || pair.characters.some(character => character.id === first)) &&
    (!second || pair.characters.some(character => character.id === second)));
  const lead = first || progress.characters[0]?.id || "";
  const bands = [...new Set(progress.characters.map(character => character.bandId))].filter(Boolean).map(id => bandInfo(catalog, id, locale));
  const filtered = progress.characters.filter(character => character.id === lead || progress.friendships.some(pair =>
    pair.characters.some(member => member.id === lead) && pair.characters.some(member => member.id === character.id)));
  return html`<section class="surface stack">
    ${renderDetailSectionHeading(t("_characterFriendships"), "friendships", { level: 2, count: pairs.length })}
    ${progress.characters.length ? accordion({
      id: "save-friendship-picker",
      label: t("selectCharacters"),
      expanded: open,
      onExpandedChange: onOpen,
      content: open ? html`<div class="save-friendship-picker">
        ${characterPair({
          locale, server,
          characters: progress.characters.map(character => ({
            value: character.id, label: saveCharacterName(character, t), image: character.image, bandId: character.bandId,
          })),
          bands, first: lead, second,
          partnerValues: new Set(filtered.map(character => character.id)),
          onFirst: value => onChange(value, ""),
          onSecond: value => onChange(lead, value),
          onSwap: () => onChange(second, lead),
        })}
      </div>` : nothing,
    }) : nothing}
    ${first || second ? html`<button class="button button--text save-clear-filter" type="button" @click=${() => onChange("", "")}>
      ${icon("close", 18)}${t("allRecords")}
    </button>` : nothing}
    <div class="save-pair-list">
      ${pairs.length ? pairs.map(pair => saveGrowthRow(savePairName(pair, t), pair, pair.characters, t, locale))
      : html`<p class="save-empty">${t("noRecords")}</p>`}
    </div>
  </section>`;
}
