import { sortProject, structuredCloneValue, type Project } from "../model";
import { assertValidProject } from "../validation";
import { finishImport, jsonInput, type ImportResult } from "./shared";

export interface SerializeProjectOptions {
  pretty?: boolean;
}

export const parseProjectJson = (input: string | Uint8Array | unknown): Project => {
  const value = jsonInput(input, "project");
  assertValidProject(value);
  return sortProject(structuredCloneValue(value));
};

export const importProjectJson = (input: string | Uint8Array | unknown): ImportResult => {
  const project = parseProjectJson(input);
  return finishImport("project", project, []);
};

export const serializeProjectJson = (project: Project, options: SerializeProjectOptions = {}): string => {
  assertValidProject(project);
  return JSON.stringify(sortProject(project), null, options.pretty === false ? undefined : 2);
};
