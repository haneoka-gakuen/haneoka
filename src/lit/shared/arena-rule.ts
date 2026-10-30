// L3 — GEB
// Input: An Arena catalogue, its release's UI marks, locale and one rule (stage attribute + three sections).
// Output: The rule's attribute icon, section icons and words (`ALL · JUST×3`), shared by the Arena page and home.
// Pos: [Map](../L2-2.md); the single Arena rule presentation.
// Effects/Dependencies: Image fallback on load error; no I/O.
import { html, type TemplateResult } from "lit";
import { clientText } from "../../i18n/client";
import { gekisouMission } from "../../lib/gekisou";
import type { ArenaCatalog } from "../../lib/arena";
import { gameGlyph } from "../ui/icon";
import "../../styles/components/arena-rule.css";

export interface ArenaRuleView {
  musicType: number;
  missions: readonly number[];
}

export interface ArenaRuleContext {
  locale: string;
  /** Release server whose runtime holds the marks. */
  server: string;
  catalog: ArenaCatalog;
  marks: Record<string, string>;
}

const COLORS = ["", "Red", "Blue", "Green", "Yellow", "Purple"];
const KEYS = ["", "red", "blue", "green", "yellow", "purple"];

export function arenaAttributeLabel(locale: string, value: number) {
  return value === 99
    ? "ALL"
    : value === 0
      ? clientText(locale, "catalog.arena.originalRule", "Original")
      : clientText(locale, `catalog.songs.liveTypes.${KEYS[value]}`, KEYS[value] || String(value));
}

export function arenaMissionLabel(locale: string, value: number) {
  return gekisouMission(value)?.fallback || clientText(locale, "catalog.arena.originalRule", "Original");
}

/** `JUST×3` when the three sections agree, otherwise `COMBO / LUCK / JUST`. */
export function arenaRuleText(locale: string, rule: ArenaRuleView) {
  const same = rule.missions.every((value) => value === rule.missions[0]);
  return same
    ? `${arenaMissionLabel(locale, rule.missions[0]!)}×3`
    : rule.missions.map((value) => arenaMissionLabel(locale, value)).join(" / ");
}

const markUrl = (context: ArenaRuleContext, name: string) => {
  const source = context.marks[name];
  return source
    ? `/runtime/${context.server}/${source.replace(/^runtime\//u, "")}?release=${context.catalog.identity.releaseId}`
    : "";
};

/** The live stage attribute sprite, falling back to the card attribute one where a release lacks it. */
export function arenaAttribute(context: ArenaRuleContext, value: number, size = 24): TemplateResult {
  const color = COLORS[value];
  const fallback = color ? markUrl(context, `CardType-${color}.png`) : "";
  const image = markUrl(context, `sp_icon_live_music_type_${value}.png`) || fallback;
  return image
    ? html`
        <img
          class="arena-attribute"
          src=${image}
          width=${size}
          height=${size}
          alt=""
          @error=${(event: Event) => {
            const element = event.currentTarget as HTMLImageElement;
            if (fallback && element.getAttribute("src") !== fallback) element.src = fallback;
            else element.hidden = true;
          }}
        />
      `
    : html`
        <span class="arena-attribute arena-attribute--text">${arenaAttributeLabel(context.locale, value)}</span>
      `;
}

export function arenaMission(context: ArenaRuleContext, value: number, size = 24): TemplateResult {
  const image = context.catalog.images?.missions[value];
  return image
    ? html`
        <span class="arena-mission" title=${arenaMissionLabel(context.locale, value)}>${gameGlyph(image, size)}</span>
      `
    : html`
        <span class="arena-mission arena-mission--text">${arenaMissionLabel(context.locale, value)}</span>
      `;
}

/** Attribute icon and name, then the section icon(s) and the rule in words. */
export function arenaRuleMarks(context: ArenaRuleContext, rule: ArenaRuleView | undefined, size = 24) {
  if (!rule)
    return html`
      <span class="arena-rule arena-rule--empty">—</span>
    `;
  const same = rule.missions.every((value) => value === rule.missions[0]);
  return html`
    <span class="arena-rule">
      <span class="arena-rule__part">
        ${arenaAttribute(context, rule.musicType, size)}
        <span>${arenaAttributeLabel(context.locale, rule.musicType)}</span>
      </span>
      <span class="arena-rule__part">
        ${same ? arenaMission(context, rule.missions[0]!, size) : rule.missions.map((value) => arenaMission(context, value, size))}
        <strong>${arenaRuleText(context.locale, rule)}</strong>
      </span>
    </span>
  `;
}

