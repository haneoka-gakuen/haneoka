import { ProjectHistory } from "../history";
import { assertValidProject } from "../validation";
import { structuredCloneValue, type Project } from "../model";
import {
  readAuthorCollections,
  createAuthorCollection,
  renameAuthorCollection,
  reorderAuthorCollection,
  setAuthorLayerVisibility,
  setAuthorGroupSpeed,
  assignAuthorSelection,
  ungroupAuthorSelection,
  deleteAuthorCollection,
  copyAuthorSelection,
  pasteAuthorSelection,
  type CollectionKind,
  type AuthorClipboard,
} from "./collections";

export type AuthorCollectionOperation =
  | { type: "create"; kind: CollectionKind; name: string; forceNoteSpeed?: number; visible?: boolean }
  | { type: "rename"; kind: CollectionKind; id: string; name: string }
  | { type: "reorder"; kind: CollectionKind; id: string; index: number }
  | { type: "visibility"; id: string; visible: boolean }
  | { type: "group-speed"; id: string; speed: number | null }
  | { type: "assign"; ids: readonly string[]; groupId?: string | null; layerId?: string | null }
  | { type: "ungroup"; ids: readonly string[] }
  | { type: "delete"; kind: CollectionKind; id: string; members: "detach" | "delete" }
  | { type: "paste"; clipboard: AuthorClipboard; tick: number };
export function applyAuthorCollectionOperation(
  project: Project,
  operation: AuthorCollectionOperation,
): { project: Project; createdIds: string[] } {
  switch (operation.type) {
    case "create": {
      const result = createAuthorCollection(project, operation.kind, operation.name, {
        ...(operation.forceNoteSpeed === undefined ? {} : { forceNoteSpeed: operation.forceNoteSpeed }),
        ...(operation.visible === undefined ? {} : { visible: operation.visible }),
      });
      return { project: result.project, createdIds: [result.id] };
    }
    case "rename":
      return { project: renameAuthorCollection(project, operation.kind, operation.id, operation.name), createdIds: [] };
    case "reorder":
      return {
        project: reorderAuthorCollection(project, operation.kind, operation.id, operation.index),
        createdIds: [],
      };
    case "group-speed":
      return { project: setAuthorGroupSpeed(project, operation.id, operation.speed), createdIds: [] };
    case "visibility":
      return { project: setAuthorLayerVisibility(project, operation.id, operation.visible), createdIds: [] };
    case "assign":
      return {
        project: assignAuthorSelection(project, new Set(operation.ids), {
          ...(operation.groupId === undefined ? {} : { groupId: operation.groupId }),
          ...(operation.layerId === undefined ? {} : { layerId: operation.layerId }),
        }),
        createdIds: [],
      };
    case "ungroup":
      return { project: ungroupAuthorSelection(project, new Set(operation.ids)), createdIds: [] };
    case "delete":
      return {
        project: deleteAuthorCollection(project, operation.kind, operation.id, operation.members),
        createdIds: [],
      };
    case "paste": {
      const result = pasteAuthorSelection(project, operation.clipboard, operation.tick);
      return {
        project: result.project,
        createdIds: [...result.ids, ...Object.values(result.groupMap), ...Object.values(result.layerMap)],
      };
    }
  }
}
/** Existing ProjectHistory is the only undo stack. Staging is side-effect free and commits reject stale revisions. */
export class AuthoringProjectController {
  readonly history: ProjectHistory<Project>;
  constructor(initial: Project, capacity = 50) {
    assertValidProject(initial);
    readAuthorCollections(initial);
    this.history = new ProjectHistory(initial, capacity);
  }
  get project() {
    return this.history.value;
  }
  get revision() {
    return this.history.revision;
  }
  stage(operation: AuthorCollectionOperation) {
    return { ...applyAuthorCollectionOperation(this.project, operation), baseRevision: this.revision };
  }
  commit(staged: { project: Project; baseRevision: number }, mergeKey?: string) {
    if (staged.baseRevision !== this.revision) throw new Error("authoring_transaction_conflict");
    assertValidProject(staged.project);
    readAuthorCollections(staged.project);
    this.history.replace(staged.project, mergeKey === undefined ? {} : { mergeKey });
    this.history.endMerge();
    return this.project;
  }
  execute(operation: AuthorCollectionOperation) {
    const staged = this.stage(operation);
    this.commit(staged);
    return { project: this.project, createdIds: staged.createdIds, revision: this.revision };
  }
  undo() {
    return this.history.undo();
  }
  redo() {
    return this.history.redo();
  }
  copy(ids: ReadonlySet<string>) {
    return copyAuthorSelection(this.project, ids);
  }
  /** Adapter calls the real CreationStore save transaction with its own project-id/head/audio/original context. */
  async persist<T>(
    save: (snapshot: Project, revision: number) => Promise<T>,
  ): Promise<{ value: T; snapshot: Project; revision: number; stillCurrent: boolean }> {
    const revision = this.revision,
      snapshot = structuredCloneValue(this.project),
      value = await save(snapshot, revision);
    return { value, snapshot, revision, stillCurrent: revision === this.revision };
  }
}

export interface AuthoringSaveContext<Audio> {
  projectId: string;
  head: number;
  audio: Audio;
  original: Project;
  source?: { name: string; text: string };
}
export interface AuthoringProjectStorePort<Audio, Document extends { head: number }> {
  save(
    id: string,
    head: number,
    chart: Project,
    audio: Audio,
    original: Project,
    source?: { name: string; text: string },
  ): Promise<Document>;
}
/** Direct structural adapter for the existing CreationStore transaction; no second database or fake saving layer. */
export async function saveAuthoringProject<Audio, Document extends { head: number }>(
  controller: AuthoringProjectController,
  store: AuthoringProjectStorePort<Audio, Document>,
  context: AuthoringSaveContext<Audio>,
) {
  const saved = await controller.persist((snapshot) =>
    store.save(context.projectId, context.head, snapshot, context.audio, context.original, context.source),
  );
  return { ...saved, nextContext: { ...context, head: saved.value.head } };
}
