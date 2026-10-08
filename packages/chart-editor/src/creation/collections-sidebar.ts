import type { Project } from "../model";
import { readAuthorCollections, authorSelectionForScope } from "./collections";

export interface AuthorEntityCounts {
  singles: number;
  points: number;
  connectors: number;
  tempos: number;
  meters: number;
  timeScales: number;
}
function counts(project: Project, ids: ReadonlySet<string>): AuthorEntityCounts {
  return {
    singles: project.singles.filter((n) => ids.has(n.id)).length,
    points: project.lines.reduce((sum, line) => sum + line.points.filter((n) => ids.has(n.id)).length, 0),
    connectors: project.lines.filter((line) => ids.has(line.id)).length,
    tempos: project.tempos.filter((n) => ids.has(n.id)).length,
    meters: project.meters.filter((n) => ids.has(n.id)).length,
    timeScales: project.timeScales.filter((n) => ids.has(n.id)).length,
  };
}
/** Stable collection IDs, preserved order and truthful per-kind counts; UI supplies localized labels. */
export function authorCollectionsSidebar(project: Project, scope: { groupId?: string; layerId?: string } = {}) {
  const state = readAuthorCollections(project),
    visibleIds = authorSelectionForScope(project, scope);
  const all = authorSelectionForScope(project, { includeHidden: true });
  const groups = state.groups.map((group) => ({
    ...group,
    selected: scope.groupId === group.id,
    counts: counts(project, authorSelectionForScope(project, { groupId: group.id, includeHidden: true })),
  }));
  const layers = state.layers.map((layer) => ({
    ...layer,
    selected: scope.layerId === layer.id,
    counts: counts(project, authorSelectionForScope(project, { layerId: layer.id, includeHidden: true })),
  }));
  return {
    groups,
    layers,
    allSelected: scope.groupId === undefined && scope.layerId === undefined,
    total: counts(project, all),
    visible: counts(project, visibleIds),
    visibleIds: [...visibleIds],
  };
}
