// L3 — GEB
// Input: Frozen comparison formations and native per-order, per-seed section distributions.
// Output: Shared formation cards, LUCK point summaries and an interactive opponent-point distribution.
// Pos: [Map](../L2-2.md); the LUCK view in the existing result diagnostics dialog.
// Effects/Dependencies: Changes only the dialog's range and threshold; requests stay in ResultAnalysis.
import { html, nothing, svg } from "lit";
import type { TeamBuilder } from "../team-builder";
import type { EngineHit, EngineRequest } from "../../lib/team-builder/engine/api";
import type { SectionMetricDistribution } from "../../lib/team-builder/engine/protocol";
import { segmented } from "../ui/controls";
import { teamFormation } from "./results";

export interface LuckSource { hit: EngineHit; input: EngineRequest; conditions?: string }
export interface LuckState {
  sources: LuckSource[];
  rows: SectionMetricDistribution[][];
  range: number;
  threshold: string;
  samples: number;
  onRange: (range: number) => void;
  onThreshold: (threshold: string) => void;
  action: unknown;
  error: boolean;
  submitted: boolean;
}
export function luckRanges(host: TeamBuilder, source: LuckSource) {
  const goal = source.input.goal;
  if (goal.kind !== "gekiso" && !(goal.kind === "event" && goal.gekiso)) return [];
  const arena = goal.kind === "gekiso" ? goal.arena : undefined;
  const songs = source.hit.aggregate?.songs.flatMap(hit => hit.song ? [hit.song] : []) ?? (source.hit.song ? [source.hit.song] : []);
  return [0, 1, 2].filter(range => songs.some(song =>
    (arena?.missions[range] || source.input.songRules?.missions[range]
      || host.master?.songs.get(song.songId)?.gekisoMissions[range]) === 2));
}
export function luckMass(rows: SectionMetricDistribution[], range: number) {
  const selected = rows.filter(row => row.missions[range] === 2);
  const masses = new Map<number, number>();
  for (const row of selected) for (const { points, count } of row.distributions[range]!)
    masses.set(points, (masses.get(points) ?? 0) + count / row.samples / selected.length);
  return [...masses].sort((a, b) => a[0] - b[0]);
}
export function renderLuckComparison(host: TeamBuilder, state: LuckState) {
  const t = (key: string) => host.t(`analysis.${key}`, key), catalog = host.catalog!;
  const number = (value: number, digits = 1) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(value);
  const distributions = state.sources.map((_, index) => luckMass(state.rows[index] ?? [], state.range));
  const threshold = Number(state.threshold), valid = state.threshold.trim() !== "" && Number.isInteger(threshold) && threshold >= 0 && threshold <= 2147483647;
  const ranges = luckRanges(host, state.sources[0]!);
  const maximum = Math.max(1, ...distributions.flatMap(rows => rows.map(([points]) => points)));
  const lead = (mass: number[][], target: number) => mass.reduce((sum, [points, probability]) => sum + (points! > target ? probability! : 0), 0);
  return html`
    <div class="tb-analysis-controls">
      <div class="tb-analysis-field">
        <span class="tb-field__label">${t("luckSection")}</span>
        ${segmented({ label: t("luckSection"), value: String(state.range), grow: false,
          options: ranges.map(range => ({ value: String(range), label: String(range + 1) })),
          onSelect: value => state.onRange(Number(value)) })}
      </div>
      <md-outlined-text-field type="number" min="0" max="2147483647" step="1" required
        label=${t("luckOpponentPoints")} .value=${state.threshold} .error=${state.submitted && !valid}
        @input=${(event: Event) => state.onThreshold((event.target as HTMLInputElement).value)}
      ></md-outlined-text-field>
      <span class="supporting-text">${t("luckRuns")} ${number(state.samples, 0)}</span>
      ${state.action}
    </div>
    <span class="tb-luck-state supporting-text" role="status">${state.error ? t("failed") : state.submitted && !valid ? t("luckThresholdInvalid") : "\u00a0"}</span>
    <figure class="tb-luck-plot">
      <svg viewBox="0 0 360 144" role="img" aria-label=${t("luckLeadCurve")}>
        <path class="tb-luck-plot__axes" d="M28 8V120H348"></path>
        <text x="24" y="14" text-anchor="end">100%</text><text x="24" y="120" text-anchor="end">0%</text>
        <text x="28" y="140">0</text><text x="348" y="140" text-anchor="end">${number(maximum, 0)}</text>
        ${distributions.map((mass, index) => mass.length ? svg`<polyline class=${`tb-luck-plot__line tb-luck-series-${index}`}
          points=${[[0, lead(mass, 0)], ...mass.flatMap(([points]) => [[points!, lead(mass, points! - 1)], [points!, lead(mass, points!)]])]
            .map(([points, probability]) => `${28 + points! / maximum * 320},${120 - probability! * 112}`).join(" ")}
        ></polyline>` : nothing)}
        ${valid && threshold <= maximum ? svg`<path class="tb-luck-plot__threshold" d=${`M${28 + threshold / maximum * 320} 8V120`}></path>` : nothing}
      </svg>
      <figcaption>${t("luckLeadCurve")}</figcaption>
    </figure>
    <div class="table-scroll" tabindex="0" role="region" aria-label=${t("luckComparison")}>
      <table class="data-table"><thead><tr>
        <th>${t("team")}</th><th>${t("luckMean")}</th><th>${t("luckLowerDecile")}</th><th>${host.t("scoreRange", "Range")}</th>
        <th>${t("luckLead")}</th><th>${t("luckTie")}</th><th>${t("luckBehind")}</th><th>${t("luckMeanScore")}</th>
      </tr></thead><tbody>${state.sources.map((source, index) => {
        const mass = distributions[index]!, mean = mass.reduce((sum, [points, probability]) => sum + points! * probability!, 0);
        let cumulative = 0;
        const decile = mass.find(([, probability]) => (cumulative += probability!) >= .1 - 1e-12)?.[0];
        const ahead = lead(mass, threshold), tied = mass.find(([points]) => points === threshold)?.[1] ?? 0;
        const percent = (value: number) => mass.length && valid ? `${number(Math.max(0, Math.min(1, value)) * 100)}%` : "—";
        return html`<tr><th scope="row"><span class=${`tb-luck-series-${index}`}>#${index + 1}</span></th>
          <td class="tabular">${mass.length ? number(mean) : "—"}</td><td class="tabular">${decile === undefined ? "—" : number(decile, 0)}</td>
          <td class="tabular">${mass.length ? `${number(mass[0]![0]!, 0)} – ${number(mass.at(-1)![0]!, 0)}` : "—"}</td>
          <td class="tabular">${percent(ahead)}</td><td class="tabular">${percent(tied)}</td><td class="tabular">${percent(1 - ahead - tied)}</td>
          <td class="tabular">${source.conditions === state.sources[0]!.conditions && source.hit.score ? number(source.hit.score.mean, 0) : "—"}</td>
        </tr>`;
      })}</tbody></table>
    </div>
    <div class="stack">${state.sources.map((source, index) => html`
      <article class="card card--outlined tb-hit stack stack--tight">
        <strong class=${`tb-luck-series-${index}`}>#${index + 1}</strong>
        ${teamFormation(host, source.hit.members.map((key, slot) => {
          const member = source.input.members.find(row => row.key === key)!, snapKey = source.hit.snaps[slot];
          const snap = source.input.snaps.find(row => row.key === snapKey);
          return { member: member.cardId, snap: snap?.cardId ?? null,
            memberGrowth: catalog.resolvedGrowth("members", member, source.input.unknownPolicy),
            snapGrowth: snap ? catalog.resolvedGrowth("snaps", snap, source.input.unknownPolicy) : null };
        }), 0, false)}
      </article>`)}
    </div>
  `;
}
