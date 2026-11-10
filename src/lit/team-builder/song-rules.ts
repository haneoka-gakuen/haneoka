// L3 — GEB
// Input: Song-rule drafts, multi-song objective and the current calculation mode.
// Output: Read-only current-rule summary, attribute/three-range overrides and multi-song objective controls.
// Pos: [Map](../L2-2.md); common controls used by Arena, automatic and manual builders.
// Effects/Dependencies: Saves through the owning controller; uses shared Material selects and accordion.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { ORIGINAL_SONG_RULES, type SongRules } from "../../lib/team-builder/arena";
import { segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { icon } from "../ui/icon";

export function songRuleSummary(host: TeamBuilder, rule: SongRules) {
  const catalog = host.catalog!,
    image = catalog.attributeIcon(rule.musicType);
  const missionIcon = (value: number) =>
    value === 1 ? icon("touch_app", 20) : value === 2 ? icon("casino", 20) :
      value === 3 ? icon("center_focus_strong", 20) : icon("music_note", 20);
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
  const option = (value: number, label: string, image?: string) => html`
    <md-select-option value=${String(value)}>
      ${
      image
        ? html`
            <img slot="start" src=${image} width="20" height="20" alt="" />
          `
        : nothing
    }
      <div slot="headline">${label}</div>
    </md-select-option>
  `;
  return html`
    <md-outlined-select
      label=${host.t("arena.attribute", "Song attribute")}
      .value=${String(rule.musicType)}
      @change=${(e: Event) => change({ musicType: Number((e.target as HTMLInputElement).value) })}
    >
      ${option(0, host.t("arena.original", "Original song"))}${[1, 2, 3, 4, 5, 99].map((value) => option(value, catalog.attributeName(value), catalog.attributeIcon(value)))}
    </md-outlined-select>
    ${
      gekiso
        ? html`
            <div class="stack">
              ${rule.missions.map(
                (mission, index) => html`
                  <md-outlined-select
                    label=${host.t("arena.range", "Range {count}", { count: index + 1 })}
                    .value=${String(mission)}
                    @change=${(e: Event) => {
        const missions: SongRules["missions"] = [...rule.missions];
        missions[index] = Number((e.target as HTMLInputElement).value);
        change({ missions });
      }}
                  >
                    ${[0, 1, 2, 3].map((value) => option(value, value === 0 ? host.t("arena.original", "Original song") : ["", "COMBO", "LUCK", "JUST"][value]!))}
                  </md-outlined-select>
                `,
              )}
            </div>
          `
        : nothing
    }
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
