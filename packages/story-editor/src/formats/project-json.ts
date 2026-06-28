import type { JsonValue, StoryProject } from "../model.js";
import { assertValidStoryProject } from "../validation.js";
import { jsonInput, stringifyStoryJson, type StoryImportResult } from "./shared.js";

export interface StoryJsonSerializeOptions {
  pretty?: boolean;
}

export const parseStoryProjectJson = (input: string | Uint8Array | unknown): StoryProject => {
  const value = jsonInput(input, "story project");
  assertValidStoryProject(value);
  return value;
};

export const importStoryProjectJson = (input: string | Uint8Array | unknown): StoryImportResult => ({
  format: "project-json",
  project: parseStoryProjectJson(input),
  diagnostics: [],
});

export const serializeStoryProjectJson = (project: StoryProject, options: StoryJsonSerializeOptions = {}): string => {
  assertValidStoryProject(project);
  return stringifyStoryJson(project as unknown as JsonValue, options.pretty !== false);
};
