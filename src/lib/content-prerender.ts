// L3 — GEB
// Input: Catalog publication fields, the build cutoff and a synchronous SSR render.
// Output: Complete or published markup with restricted content references.
// Pos: [Map](L2-2.md); publication context for static rendering.
// Effects/Dependencies: Temporarily selects the render context and restores it after rendering.
import type { ContentReference } from "./content-view";
import { contentReference } from "./content-view";
import { contentPublished } from "./content-publication";
import { isModelVisibilityType, type VisibilityType } from "./content-visibility-policy";

let publicView = false;
let references: Map<string, ContentReference> | undefined;
let cutoff: number | undefined;
export function prerenderViewKey(): string {
  return references ? (publicView ? "public" : "full") : "runtime";
}
export function prerenderContentVisible(
  kind: VisibilityType | undefined,
  value: Record<string, unknown>,
  id?: string,
): boolean {
  if (isModelVisibilityType(kind)) return true;
  const published = contentPublished(value, cutoff);
  if (kind && !published) {
    const reference = contentReference(kind, value, id);
    references?.set(JSON.stringify(reference), reference);
  }
  return !publicView || published;
}
export function withPrerenderView<T>(
  publishedOnly: boolean,
  render: () => T,
  now?: number,
): { result: T; references: ContentReference[] } {
  const previous = publicView,
    previousReferences = references,
    previousCutoff = cutoff;
  publicView = publishedOnly;
  references = new Map();
  cutoff = now;
  try {
    return { result: render(), references: [...references.values()] };
  } finally {
    publicView = previous;
    references = previousReferences;
    cutoff = previousCutoff;
  }
}
