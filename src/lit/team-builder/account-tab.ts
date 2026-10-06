/** Account-wide power bonuses: character ranks, band items, TGW card rank. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { sectionHeading } from "./catalog";
import type { TeamBuilder } from "../team-builder";

function stepper(host: TeamBuilder, label: string, value: number | null, min: number, max: number, change: (value: number | null) => void, unit = "") {
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  return html`
    <span class="tb-stepper" role="group" aria-label=${label}>
      ${iconButton({ icon: "remove", label: `${label} −1`, size: 18, className: "icon-button--small", disabled: value !== null && value <= min, onClick: () => change(clamp((value ?? min) - 1)) })}
      <input class="tb-stepper__value" type="number" inputmode="numeric" min=${min} max=${max} aria-label=${label} placeholder="—"
        .value=${live(value === null ? "" : String(value))}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value.trim();
          change(raw === "" ? null : clamp(Math.round(Number(raw)) || min));
        }} />${unit}
      ${iconButton({ icon: "add", label: `${label} +1`, size: 18, className: "icon-button--small", disabled: value !== null && value >= max, onClick: () => change(clamp((value ?? min - 1) + 1)) })}
    </span>
  `;
}

export function renderAccountTab(host: TeamBuilder): TemplateResult {
  const catalog = host.catalog!;
  const master = catalog.master;
  const view = host.view!;
  const player = view.player;
  const characters = [...master.characters.values()].filter((character) => catalog.characterName(character.id));
  const maxRank = master.maxCharacterRank;
  const sum = characters.reduce((total, character) => total + (player.characterRanks[String(character.id)] ?? 1), 0);
  const bands = [...new Set(characters.map((character) => character.bandId))].filter(Boolean);
  const vipRanks = [...master.vipBonus.keys()].sort((a, b) => a - b);
  const maxVip = Math.max(1, ...vipRanks, 1);
  const items = Object.values(catalog.data.bandItems).map((item) => ({
    id: Number(item.bandItemId),
    bandId: Number(item.bandId),
    name: catalog.text(item.name),
    max: Math.max(0, ...((item.levels as { level?: number }[] | undefined) ?? []).map((row) => Number(row.level) || 0)),
  }));
  const setAllRanks = (value: number) => host.write(characters.map((character) => ({ key: `cr.${character.id}`, value })));
  const effectiveTotal = player.characterTotalRank ?? sum;
  return html`
    <div class="tb-account stack stack--loose">
      <section class="surface stack">
        ${sectionHeading({ icon: "trending_up", label: host.t("accountTitle", "Account bonuses") })}
        <div class="tb-account__summary">
          <div class="tb-metric"><span class="tb-metric__label">${host.t("totalRank", "Total character rank")}</span><strong class="tb-metric__value tabular">${effectiveTotal}</strong>
            <span class="tb-metric__detail">${player.characterTotalRank === null ? host.t("totalRankAuto", "Sum of the ranks below") : host.t("totalRankManual", "Entered manually")}</span></div>
          <div class="tb-field">
            <span class="tb-field__label">${host.t("totalRankOverride", "Total rank (enter if some characters are not listed)")}</span>
            ${stepper(host, host.t("totalRank", "Total character rank"), player.characterTotalRank, 0, maxRank * Math.max(characters.length, 1), (value) => host.write([{ key: "p.total", value }]))}
          </div>
          <div class="tb-field">
            <span class="tb-field__label">${host.t("vipRank", "T.G.W card rank")}</span>
            ${stepper(host, host.t("vipRank", "T.G.W card rank"), player.vipRank, 1, maxVip, (value) => host.write([{ key: "p.vip", value }]))}
            ${master.vipBonus.get(player.vipRank ?? 1) ? html`<span class="tb-field__note">+${(master.vipBonus.get(player.vipRank ?? 1)! / 100).toFixed(2)}%</span>` : nothing}
          </div>
        </div>
      </section>
      <section class="surface stack">
        <div class="row row--between row--wrap">
          ${sectionHeading({ icon: "face", label: host.t("characterRanks", "Character ranks") })}
          <div class="cluster">
            <button class="button button--text button--small" type="button" @click=${() => setAllRanks(maxRank)}>${icon("keyboard_double_arrow_up", 18)}${host.t("allMax", "All max")} (${maxRank})</button>
            <button class="button button--text button--small" type="button" @click=${() => host.write(characters.map((character) => ({ key: `cr.${character.id}`, value: null })))}>${host.t("clearAll", "Clear")}</button>
          </div>
        </div>
        ${bands.map(
          (band) => html`
            <div class="tb-band">
              <span class="tb-band__name">${catalog.bandIcon(band) ? html`<img src=${catalog.bandIcon(band)} alt="" />` : nothing}${catalog.bandName(band)}</span>
              <div class="tb-rank-grid">
                ${characters
                  .filter((character) => character.bandId === band)
                  .map(
                    (character) => html`
                      <div class="tb-rank" style=${`--character:${catalog.characterColor(character.id)}`}>
                        ${catalog.characterFace(character.id) ? html`<img class="tb-avatar" src=${catalog.characterFace(character.id)} alt="" loading="lazy" />` : nothing}
                        <span class="tb-rank__name">${catalog.characterName(character.id)}</span>
                        ${stepper(host, catalog.characterName(character.id), player.characterRanks[String(character.id)] ?? null, 1, maxRank, (value) => host.write([{ key: `cr.${character.id}`, value }]))}
                      </div>
                    `,
                  )}
              </div>
            </div>
          `,
        )}
      </section>
      <section class="surface stack">
        <div class="row row--between row--wrap">
          ${sectionHeading({ icon: "piano", label: host.t("bandItems", "Band items") })}
          <button class="button button--text button--small" type="button" @click=${() => host.write(items.map((item) => ({ key: `bi.${item.id}`, value: item.max })))}>${icon("keyboard_double_arrow_up", 18)}${host.t("allMax", "All max")}</button>
        </div>
        ${[...new Set(items.map((item) => item.bandId))].map(
          (band) => html`
            <div class="tb-band">
              <span class="tb-band__name">${catalog.bandIcon(band) ? html`<img src=${catalog.bandIcon(band)} alt="" />` : nothing}${catalog.bandName(band) || host.t("allBands", "All bands")}</span>
              <div class="tb-item-grid">
                ${items
                  .filter((item) => item.bandId === band)
                  .map(
                    (item) => html`
                      <div class="tb-item">
                        <span class="tb-item__name">${item.name}</span>
                        ${stepper(host, item.name, player.bandItems[String(item.id)] ?? null, 0, item.max, (value) => host.write([{ key: `bi.${item.id}`, value }]))}
                      </div>
                    `,
                  )}
              </div>
            </div>
          `,
        )}
      </section>
    </div>
  `;
}
