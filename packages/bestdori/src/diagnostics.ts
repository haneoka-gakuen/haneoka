export type BestdoriDiagnosticSeverity = "info" | "warning" | "error";

export interface BestdoriDiagnostic {
  severity: BestdoriDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
}

export const bestdoriDiagnostic = (
  severity: BestdoriDiagnosticSeverity,
  code: string,
  path: string,
  message: string,
): BestdoriDiagnostic => ({ severity, code, path, message });

export class BestdoriFormatError extends TypeError {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BestdoriFormatError";
    this.code = code;
    this.path = path;
  }
}
