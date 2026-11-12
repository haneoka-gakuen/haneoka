// L3 — GEB
// Input: Frozen native JUST coverage statistics and the workspace locale.
// Output: Shared specification rows and a per-section coverage table.
// Pos: [Map](../L2-2.md); JUST window result presentation.
// Effects/Dependencies: Uses existing specifications and tables; starts no scoring or network requests.
import { html, nothing } from "lit";
import type { JustWindow } from "../../lib/team-builder/engine/api";
import type { TeamBuilder } from "../team-builder";
import { specList } from "../ui/spec";
import { collectionTable } from "../ui/collection-view";

export function justWindowResults(host: TeamBuilder, window: JustWindow) {
  const stats = window.coverage;
  if (!stats) return nothing;
  const ranges = stats.ranges.flatMap((range, index) => (range.notes ? [{ ...range, index }] : []));
  if (!ranges.length) return nothing;
  const t = (key: string, fallback: string) => host.t(`justCoverage.${key}`, fallback);
  const number = (value: number, digits = 2) =>
    new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(value);
  const percent = (value: number) => `${number(value * 100)}%`;
  const seconds = (value: number) => `${number(value / 1000)} s`;
  const peak = Math.max(...ranges.map((range) => range.peakMs));
  return html`
    <div class="stack">
      ${specList(
      [
        { label: t("target", "Target window"), value: `±${number(stats.targetMs)} ms` },
        { label: t("peak", "Effective peak window"), value: `±${number(peak)} ms` },
        {
          label: t("minimumCoverage", "Minimum note coverage"),
          value: percent(Math.min(...ranges.map((range) => range.minimumCoverage))),
        },
      ],
      { numeric: true },
    )}
      ${collectionTable(
      t("stats", "Window statistics"),
      [
        host.t("arena.sections.section", "Section"),
        t("peak", "Effective peak window"),
        t("minimumCoverage", "Minimum note coverage"),
        t("minimumDuration", "Minimum total duration"),
        t("minimumContinuous", "Minimum continuous duration"),
      ],
      ranges.map((range) => [
        host.t("gekisoRange", "Section {n}", { n: range.index + 1 }),
        `±${number(range.peakMs)} ms`,
        html`
          ${percent(range.minimumCoverage)}
          <small>${range.minimumCoveredNotes} / ${range.notes}</small>
        `,
        seconds(range.minimumCoveredMs),
        seconds(range.minimumLongestMs),
      ]),
      { numeric: true },
    )}
    </div>
  `;
}
