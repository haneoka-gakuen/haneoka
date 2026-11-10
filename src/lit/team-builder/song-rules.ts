// L3 — GEB
// Input: Song-rule drafts, multi-song objective and the current calculation mode.
// Output: Read-only current-rule summary, attribute/three-range overrides and multi-song objective controls.
// Pos: [Map](../L2-2.md); common controls used by Arena, automatic and manual builders.
// Effects/Dependencies: Saves through the owning controller; uses shared segmented controls and accordion.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { ORIGINAL_SONG_RULES, type SongRules } from "../../lib/team-builder/arena";
import { segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { gameGlyph, icon } from "../ui/icon";
import { choiceField } from "./catalog";

export function songRuleSummary(host: TeamBuilder, rule: SongRules) {
  const catalog = host.catalog!,
    image = catalog.attributeIcon(rule.musicType);
  const missionIcon = (value: number) => {
    const source = value ? catalog.missionIcon(value) : "";
    return html`<span class="tb-game-icon">${source ? gameGlyph(source, 20) : nothing}</span>`;
  };
  const label = (value: number) =>
    value ? ["", "COMBO", "LUCK", "JUST"][value] : host.t("arena.original", "Original song");
  const same = rule.missions.every((value) => value === rule.missions[0]);
  return html`
    <div class="cluster" role="group" aria-label=${host.t("arena.current", "Current rules")}>
      <span class="cluster">
        ${image ? html`<img src=${image} width="20" height="20" alt="" />` : icon("music_note", 20)}
        <strong>${rule.musicType ? catalog.attributeName(rule.musicType) : host.t("arena.original", "Original song")}</strong>
      </span>
      ${same
        ? html`<span class="cluster">${missionIcon(rule.missions[0])}<strong>${label(rule.missions[0])} ×3</strong></span>`
        : rule.missions.map((value, index) => html`
          <span class="cluster" aria-label=${`${host.t("arena.range", "Range {count}", { count: index + 1 })} · ${label(value)}`}>
            ${missionIcon(value)}<span>${label(value)}</span>
          </span>
        `)}
    </div>
  `;
}

export function songRuleFields(
  host: TeamBuilder,
  rule: SongRules,
  change: (patch: Partial<SongRules>) => void,
  gekiso = true,
) {
  const catalog = host.catalog!;
  const nativeIcon = (source: string) => html`<span class="tb-game-icon">${source ? gameGlyph(source, 20) : nothing}</span>`;
  const original = host.t("arena.original", "Original song");
  return html`
    ${choiceField({
      type: "select",
      label: host.t("arena.attribute", "Song attribute"),
      value: String(rule.musicType),
      options: [0, 1, 2, 3, 4, 5, 99].map(value => ({
        value: String(value),
        label: value ? catalog.attributeName(value) : original,
        leading: value && catalog.attributeIcon(value)
          ? html`<img src=${catalog.attributeIcon(value)} width="20" height="20" alt="" loading="lazy" />` : undefined,
      })),
      onSelect: value => change({ musicType: Number(value) }),
    })}
    ${gekiso ? rule.missions.map((mission, index) => choiceField({
      type: "select",
      label: host.t("arena.range", "Range {count}", { count: index + 1 }),
      value: String(mission),
      options: [0, 1, 2, 3].map(value => ({
        value: String(value),
        label: value ? ["", "COMBO", "LUCK", "JUST"][value]! : original,
        leading: value ? nativeIcon(catalog.missionIcon(value)) : undefined,
      })),
      onSelect: value => {
        const missions: SongRules["missions"] = [...rule.missions];
        missions[index] = Number(value);
        change({ missions });
      },
    })) : nothing}
  `;
}
export function songRulesControl(
  host: TeamBuilder,
  draft = host.searchSettings.songRules,
  save: (rule: SongRules) => void = (songRules) => host.updateSettings({ songRules }),
  mode?: boolean,
) {
  const s = host.searchSettings;
  const gekiso = mode ?? (s.goal === "gekiso" || (s.goal === "event" && s.ptMode === "gekiso" && s.route === "live"));
  const rule = draft ?? ORIGINAL_SONG_RULES;
  return accordion({
    id: "tb-song-rules",
    label: host.t("songRules", "Song rules"),
    expanded: host.expanded.has("song-rules"),
    onExpandedChange: (open) => {
      if (open) host.expanded.add("song-rules");
      else host.expanded.delete("song-rules");
      host.requestUpdate();
    },
    content: html`
      <div class="stack">${songRuleFields(host, rule, (patch) => save({ ...rule, ...patch }), gekiso)}</div>
    `,
  });
}

export function multiSongControl(host: TeamBuilder) {
  const s = host.searchSettings;
  if (!["score", "gekiso", "event"].includes(s.goal) || (s.goal === "event" && s.route === "skip")) return nothing;
  return segmented({
    label: host.t("arena.objective", "Team objective"),
    value: s.aggregation,
    options: [
      { value: "individual", label: host.t("arena.individual", "A team for each song") },
      { value: "mean", label: host.t("multiSong.mean", "Best average across songs") },
    ],
    onSelect: value => host.tab === "pt"
      ? host.updateFarming({ aggregation: value as "individual" | "mean" })
      : host.updateSettings({ aggregation: value as "individual" | "mean" }),
  });
}
