/** One card filter surface for the owned library and manual formation picker. */
import { html } from "lit";
import { live } from "lit/directives/live.js";
import { clientText } from "../../i18n/client";
import { CARD_SKILL_FACETS, cardArtwork, cardSkills, skillTypeKey, skillTypeTitle, skillFacetValues, matchesSelections } from "../../lib/catalog-filters";
import { filterDateBound } from "../../lib/filter-date";
import { chooserGroup } from "../ui/chooser-filters";
import { filterChip } from "../ui/controls";
import { cardRarityName } from "../shared/rarity-icon";
import type { TeamBuilder } from "../team-builder";
import type { BoxFilters } from "./types";

export function matchesCardFilters(host: TeamBuilder, kind: "members" | "snaps", id: number, f: BoxFilters): boolean {
  const catalog = host.catalog!;
  const card = kind === "members" ? catalog.member(id) : catalog.snap(id);
  if (!card) return false;
  if (!matchesSelections(catalog.bandIds(kind, id).map(String), f.bands.map(String)) ||
      !matchesSelections(catalog.characterIds(kind, id).map(String), f.characters.map(String)) ||
      !matchesSelections([String(card.attribute)], f.attributes.map(String)) ||
      !matchesSelections([String(card.rarity)], f.rarities.map(String))) return false;
  const item = catalog.cardFilterItem(kind, id);
  for (const facet of CARD_SKILL_FACETS) {
    if (!(facet.kinds as readonly string[]).includes(kind === "members" ? "member" : "support")) continue;
    if (!matchesSelections(skillFacetValues(item, facet.key)!, f.facets[facet.key] || [])) return false;
  }
  if (!matchesSelections([cardArtwork(item) ? "yes" : "no"], f.facets.artwork || [])) return false;
  const total = ["performance", "technique", "visual"].reduce((sum, key) => {
    const stat = (item.stat as Record<string, unknown> | undefined)?.[key];
    // An adapted NaN is an unknown native value, not an absent/zero field.
    const value = typeof stat === "number" && !Number.isFinite(stat) ? stat : stat || item[key] || 0;
    return sum + Number(value);
  }, 0);
  const min = f.facets.minTotal?.[0], max = f.facets.maxTotal?.[0];
  if ((min || max) && (!Number.isFinite(total) || total <= 0 || (min && total < Number(min)) || (max && total > Number(max)))) return false;
  const raw = item.releasedAt;
  const date = Array.isArray(raw) ? Number(raw.find((value) => Number(value) > 0) || 0) : Number(raw || 0);
  const from = filterDateBound(f.facets.releaseFrom?.[0]), to = filterDateBound(f.facets.releaseTo?.[0], true);
  if ((from !== undefined && (!date || date < from)) || (to !== undefined && (!date || date >= to))) return false;
  const query = f.query.normalize("NFKC").toLocaleLowerCase(host.locale).trim();
  const haystack = [`#${id}`, catalog.cardName(kind, id), ...catalog.characterIds(kind, id).map((id) => catalog.characterName(id)), ...catalog.bandIds(kind, id).map((id) => catalog.bandName(id))].join(" ").normalize("NFKC").toLocaleLowerCase(host.locale);
  return !query || haystack.includes(query);
}
export function renderCardFilters(host: TeamBuilder, f: BoxFilters, set: (patch: Partial<BoxFilters>) => void) {
  const catalog = host.catalog!;
  const kind = f.kind;
  const cards = Object.values(kind === "members" ? catalog.data.members : catalog.data.snapshots);
  const label = (key: string) => clientText(host.locale, key, key);
  const all = host.common("all", "All");
  const group = (title: string, values: string[], options: {value: string; label: string; image?: string; imageOnly?: boolean}[], change: (values: string[]) => void) => chooserGroup(title, html`
    ${filterChip({label: all, selected: !values.length, onToggle: () => change([])})}
    ${options.map((option) => filterChip({...option, selected: values.includes(option.value), onToggle: () => change(values.includes(option.value) ? values.filter((value) => value !== option.value) : [...values, option.value])}))}
  `);
  const numeric = (key: "bands" | "characters" | "attributes" | "rarities", title: string, options: {value: string; label: string; image?: string; imageOnly?: boolean}[]) => group(title, f[key].map(String), options, (values) => set({[key]: values.map(Number)}));
  const facetSet = (key: string, values: string[]) => set({ facets: {...f.facets, [key]: values} });
  const role = kind === "members" ? "member" : "support";
  return html`
    ${numeric("bands", label("band"), [...new Set(cards.flatMap((card) => catalog.bandIds(kind, card.id)))].sort((a,b) => a-b).map((id) => ({value:String(id),label:catalog.bandName(id),image:catalog.bandIcon(id) || undefined})))}
    ${numeric("characters", label("character"), [...new Set(cards.flatMap((card) => catalog.characterIds(kind, card.id)))].sort((a,b) => a-b).map((id) => ({value:String(id),label:catalog.characterName(id),image:catalog.characterFace(id) || undefined})))}
    ${numeric("attributes", label("attribute"), [...new Set(cards.map((card) => card.attribute))].filter((id) => id >= 1 && id <= 5).sort().map((id) => ({value:String(id),label:catalog.attributeName(id),image:catalog.attributeIcon(id) || undefined})))}
    ${numeric("rarities", label("rarity"), [...new Set(cards.map((card) => card.rarity))].sort((a,b) => b-a).map((id) => ({value:String(id),label:cardRarityName(id),image:catalog.rarityIcon(id) || undefined,imageOnly:!!catalog.rarityIcon(id)})))}
    ${CARD_SKILL_FACETS.filter((facet) => (facet.kinds as readonly string[]).includes(role)).map((facet) => {
      const options = new Map<string, {value:string;label:string;image?:string}>();
      for (const card of cards) for (const skill of cardSkills(catalog.cardFilterItem(kind, card.id), facet.role)) {
        const value = skillTypeKey(skill);
        if (value && !options.has(value)) options.set(value, {value,label:skillTypeTitle(catalog.text(skill.skillName)),image:String(skill.icon || "") || undefined});
      }
      return group(label(facet.key), f.facets[facet.key] || [], [...options.values()], (values) => facetSet(facet.key, values));
    })}
    ${group(label("availableImage"), f.facets.artwork || [], ["yes","no"].map((value) => ({value,label:label(value)})), (values) => facetSet("artwork", values))}
    ${chooserGroup(label("total"), html`<div class="chooser-filter-options">${["minTotal", "maxTotal"].map((key) => html`<md-outlined-text-field type="number" min="0" label=${label(key.startsWith("min") ? "minimum" : "maximum")} .value=${live(f.facets[key]?.[0] || "")} @input=${(event: Event) => {const value = (event.target as HTMLInputElement).value; facetSet(key, value ? [value] : []);}}></md-outlined-text-field>`)}</div>`)}
    ${chooserGroup(label("release"), html`<div class="chooser-filter-options">${["releaseFrom", "releaseTo"].map((key) => html`<md-outlined-text-field type="date" label=${label(key === "releaseFrom" ? "minimum" : "maximum")} .value=${live(f.facets[key]?.[0] || "")} @input=${(event: Event) => {const value = (event.target as HTMLInputElement).value; facetSet(key, value ? [value] : []);}}></md-outlined-text-field>`)}</div>`)}
    <button class="button button--text" type="button" @click=${() => set({bands:[],characters:[],attributes:[],rarities:[],facets:{}})}>${host.t("clearFilters", "Clear filters")}</button>
  `;
}
