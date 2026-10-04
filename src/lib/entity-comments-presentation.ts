import type { EntityCommentsPresentation } from "./community-view-contract";
let presentation: EntityCommentsPresentation | undefined;
/** Astra registers the view; the entity controller owns reads, mutations and intent state. */
export function registerEntityCommentsPresentation(view: EntityCommentsPresentation): void {
  presentation = view;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("haneoka:entity-comments-presentation-ready"));
}
export function entityCommentsPresentation(): EntityCommentsPresentation | undefined {
  return presentation;
}
