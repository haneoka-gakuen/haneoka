// L3 — GEB
// Input: Catalog publication fields and a synchronous SSR render.
// Output: Complete or published markup with restricted content references.
// Pos: [Map](L2-2.md); publication context for static rendering.
// Effects/Dependencies: Temporarily selects the render context and restores it after rendering.
import type { ContentReference } from "./content-view";
import { contentReference } from "./content-view";
import { contentPublished } from "./content-publication";
import type { VisibilityType } from "./content-visibility-policy";

let publicView = false;
let references: Map<string, ContentReference> | undefined;
export function prerenderContentVisible(
  kind: VisibilityType | undefined,
  value: Record<string, unknown>,
  id?: string,
): boolean {
  if (kind && !contentPublished(value)) {
    const reference = contentReference(kind, value, id);
    references?.set(JSON.stringify(reference), reference);
  }
  return !publicView || contentPublished(value);
}
export function withPrerenderView<T>(
  publishedOnly: boolean,
  render: () => T,
): { result: T; references: ContentReference[] } {
  const previous = publicView,
    previousReferences = references;
  publicView = publishedOnly;
  references = new Map();
  try {
    return { result: render(), references: [...references.values()] };
  } finally {
    publicView = previous;
    references = previousReferences;
  }
}
