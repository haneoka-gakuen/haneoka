export type StoryDiagnosticSeverity = "info" | "warning" | "error";
export type StoryConversionFidelity = "exact" | "approximate" | "unsupported";

export interface StoryDiagnostic {
  severity: StoryDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
  fidelity?: StoryConversionFidelity;
  line?: number;
}

export const storyDiagnostic = (
  severity: StoryDiagnosticSeverity,
  code: string,
  path: string,
  message: string,
  fidelity?: StoryConversionFidelity,
  line?: number,
): StoryDiagnostic => ({
  severity,
  code,
  path,
  message,
  ...(fidelity === undefined ? {} : { fidelity }),
  ...(line === undefined ? {} : { line }),
});
