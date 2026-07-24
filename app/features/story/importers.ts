import type { StoryImportResult } from "@haneoka/story-editor";

export interface StoryFileImportContext {
  readonly fileName: string;
  readonly parsed: unknown;
  readonly title: string;
  /** Selected Our Notes release used for any imported local runtime assets. */
  readonly releaseServer: string;
}

export interface StoryFileImporter {
  readonly id: string;
  readonly accepts: (context: StoryFileImportContext) => boolean;
  readonly import: (context: StoryFileImportContext) => StoryImportResult;
}

const importers = new Map<string, StoryFileImporter>();

export const registerStoryFileImporter = (importer: StoryFileImporter): void => {
  const id = String(importer.id || "").trim();
  if (!id) throw new TypeError("Story file importer id must not be empty");
  importers.set(id, { ...importer, id });
};

export const importRegisteredStoryFile = (context: StoryFileImportContext): StoryImportResult | undefined => {
  for (const importer of importers.values()) {
    if (importer.accepts(context)) return importer.import(context);
  }
  return undefined;
};
