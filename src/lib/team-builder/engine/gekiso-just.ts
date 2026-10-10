/** Player accuracy and skill conversion are different quantities. Bonus JUST counts are not note judgements. */
import type { GekisoChart, GekisoContext } from "./gekiso";

export interface GekisoJustSummary {
  eligible: number;
  baselineHits: number;
  effectiveHits: number;
  convertedHits: number;
  /** Null when this chart has no eligible JUST notes. Fractions, not percentages. */
  baselineRate: number | null;
  effectiveRate: number | null;
}

export function gekisoJustSummary(
  chart: Pick<GekisoChart, "notes" | "play" | "judgements">,
  context: Pick<GekisoContext, "judgement">,
): GekisoJustSummary {
  if (context.judgement.length !== chart.notes.length || chart.judgements.length !== chart.notes.length)
    throw new Error("gekiso-just-note-mismatch");
  const eligible = new Set(chart.play.justEligibleIds);
  let baselineHits = 0,
    effectiveHits = 0,
    convertedHits = 0;
  let count = 0;
  chart.notes.forEach((note, index) => {
    if (!eligible.has(note.id)) return;
    count++;
    const before = chart.judgements[index] === 6;
    const after = context.judgement[index] === 6;
    if (before) baselineHits++;
    if (after) effectiveHits++;
    if (after && !before) convertedHits++;
  });
  return {
    eligible: count,
    baselineHits,
    effectiveHits,
    convertedHits,
    baselineRate: count ? baselineHits / count : null,
    effectiveRate: count ? effectiveHits / count : null,
  };
}
