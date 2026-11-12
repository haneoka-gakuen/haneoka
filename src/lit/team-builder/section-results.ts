// L3 — GEB
// Input: Frozen native section summaries, the common score reference and its formation view.
// Output: Shared specification rows, section tables and an expandable reference team.
// Pos: [Map](../L2-2.md); Arena section-first result presentation.
// Effects/Dependencies: Shared Material disclosures and tables; reads no current scoring settings and starts no engine calls.
import { html, nothing, type TemplateResult } from "lit";
import type { EngineHit } from "../../lib/team-builder/engine/api";
import type { TeamBuilder } from "../team-builder";
import { accordion } from "../ui/accordion";
import { collectionTable } from "../ui/collection-view";
import { specList } from "../ui/spec";
import { resultRequest } from "./score-goal";

export function sectionResults(host: TeamBuilder, hit: EngineHit, reference: TemplateResult) {
  const value = hit.sectionPerformance;
  if (!value) return nothing;
  const t = (key: string, fallback: string) => host.t(`arena.sections.${key}`, fallback);
  const number = (value: number, digits = 0) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(value);
  const percent = (value: number) => `${number(value * 100, 2)}%`;
  const delta = (value: number) => `${value > 0 ? "+" : ""}${percent(value)}`;
  const input = resultRequest(host, hit);
  const goal = input?.goal;
  const missions = goal?.kind === "gekiso" ? goal.arena?.missions : [];
  const range = (index: number) => `${host.t("gekisoRange", "Section {n}", { n: index + 1 })} ${["", "COMBO", "LUCK", "JUST"][missions?.[index] ?? 0]}`;
  const charts = hit.aggregate?.songs.flatMap(part => part.song ? [part.song] : []) ?? (hit.song ? [hit.song] : []);
  const id = `section-${hit.song?.songId ?? "all"}-${hit.members.join("-")}`;
  const fold = (suffix: string, label: string, content: unknown) => accordion({ id: `${id}-${suffix}`, label,
    expanded: host.expanded.has(`${id}-${suffix}`), onExpandedChange: expanded => {
      if (expanded) host.expanded.add(`${id}-${suffix}`); else host.expanded.delete(`${id}-${suffix}`); host.requestUpdate();
    }, content });
  return html`<div class="stack">
    ${specList([
      { label: t("baseScore", "Base score"), value: number(value.baseMean) },
      { label: t("referenceBase", "Reference base score"), value: number(value.referenceBaseMean) },
      { label: t("baseChange", "Base score change"), value: delta(value.referenceBaseMean ? value.baseMean / value.referenceBaseMean - 1 : 0) },
      { label: t("rankingBonus", "Placement bonus"), value: number(value.bonusMean) },
      { label: host.t("expectedScore", "Average score"), value: number(value.totalMean) },
      value.allWin === null ? null : { label: t("allWin", "All three sections won"), value: percent(value.allWin) },
    ], { numeric: true })}
    ${collectionTable(t("performance", "Section performance"), [t("section", "Section"), value.versus ? t("winRate", "Scenario win rate") : t("change", "Improvement")],
      value.ranges.map((score, index) => [range(index), value.versus ? percent(score) : delta(score - 1)]), { numeric: true })}
    ${fold("details", t("details", "Section details"), collectionTable(t("details", "Section details"),
      [host.t("song", "Song"), t("section", "Section"), t("metric", "Task count"), t("reference", "Reference"), t("low", "10th percentile"), t("range", "Range"), ...(value.versus ? [t("winRate", "Scenario win rate")] : [])],
      value.songs.flatMap((summary, song) => summary.metrics.map((metric, index) => [
        charts[song] ? host.catalog!.songTitle(charts[song]!.songId) : "—", range(index), number(metric, 1), number(value.baseline[song]!.metrics[index]!, 1),
        number(summary.lowerDecile[index]!, 1), `${number(summary.minimum[index]!, 1)} – ${number(summary.maximum[index]!, 1)}`,
        ...(summary.wins ? [percent(summary.wins[index]!)] : []),
      ])), { numeric: true }))}
    ${fold("reference", t("referenceTeam", "Score reference team"), reference)}
  </div>`;
}
