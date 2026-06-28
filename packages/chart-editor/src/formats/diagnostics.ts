import type { Project } from "../model";
import type { FormatWarning } from "./shared";

export type ExportFormat = "project" | "ss" | "usc";

const warning = (code: string, path: string, message: string): FormatWarning => ({ code, path, message });

const hasUnsupportedMeta = (project: Project, format: Exclude<ExportFormat, "project">): boolean => {
  const meta = project.meta;
  if (meta.title || meta.artist || meta.charter || meta.difficulty || meta.level || meta.tags?.length) return true;
  if (meta.source && meta.source !== format) return true;
  const supportedExtra = format === "ss" ? new Set(["ssVersion"]) : new Set<string>();
  return Object.keys(meta.extra ?? {}).some((key) => !supportedExtra.has(key));
};

const hasNonDefaultMeter = (project: Project): boolean =>
  project.meters.length !== 1 ||
  project.meters[0]?.tick !== 0 ||
  project.meters[0]?.numerator !== 4 ||
  project.meters[0]?.denominator !== 4;

const hasExtensions = (project: Project): boolean => Object.keys(project.extensions).length > 0;

/** Report canonical project data that the selected external format cannot carry. */
export const getExportDiagnostics = (project: Project, format: ExportFormat): FormatWarning[] => {
  if (format === "project") return [];
  const warnings: FormatWarning[] = [];

  if (hasUnsupportedMeta(project, format)) {
    warnings.push(
      warning(
        `${format}.export.metaUnsupported`,
        "$.meta",
        `${format.toUpperCase()} does not carry the project's descriptive metadata`,
      ),
    );
  }
  if (hasExtensions(project)) {
    warnings.push(
      warning(
        `${format}.export.extensionsUnsupported`,
        "$.extensions",
        `${format.toUpperCase()} does not carry canonical format extensions`,
      ),
    );
  }
  if (project.laneBasis !== 24) {
    warnings.push(
      warning(
        `${format}.export.laneBasisNormalized`,
        "$.laneBasis",
        `${format.toUpperCase()} retains relative geometry but not the canonical ${project.laneBasis}-lane basis`,
      ),
    );
  }

  if (format === "ss") {
    if (project.audioOffset !== 0) {
      warnings.push(warning("ss.export.audioOffsetUnsupported", "$.audioOffset", "SS does not carry audio offset"));
    }
    if (project.timeScales.length) {
      warnings.push(
        warning("ss.export.timeScalesUnsupported", "$.timeScales", "SS does not carry USC/SUS time-scale changes"),
      );
    }
    return warnings;
  }

  if (hasNonDefaultMeter(project)) {
    warnings.push(
      warning(
        "usc.export.metersUnsupported",
        "$.meters",
        "USC does not carry meter changes; only the implicit default 4/4 meter remains",
      ),
    );
  }
  if (project.markers.skill.length) {
    warnings.push(warning("usc.export.skillUnsupported", "$.markers.skill", "USC does not carry skill markers"));
  }
  if (project.markers.fever.length) {
    warnings.push(warning("usc.export.feverUnsupported", "$.markers.fever", "USC does not carry fever sections"));
  }
  if (project.markers.call.length) {
    warnings.push(warning("usc.export.callUnsupported", "$.markers.call", "USC does not carry call timing markers"));
  }
  if (project.sourceOrder?.length) {
    warnings.push(
      warning(
        "usc.export.sourceOrderNotSerialized",
        "$.sourceOrder",
        "USC object order is applied, but canonical source-order IDs are not serialized",
      ),
    );
  }
  if (project.lines.some((line) => line.points.some((point) => point.lane === "auto"))) {
    warnings.push(
      warning(
        "usc.export.autoGeometryResolved",
        "$.lines",
        "USC stores resolved line geometry and cannot retain authored SS auto markers",
      ),
    );
  }
  return warnings;
};
