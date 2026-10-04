import type { Project } from "../model";
import type { FormatWarning } from "./shared";
import { isRecord } from "./shared";
import { ChartFormatError } from "./shared";
import { validateProject } from "../validation";
import { projectToSs, serializeSs } from "./ss";

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

const hasExtensions = (project: Project, format: Exclude<ExportFormat, "project">): boolean =>
  Object.keys(project.extensions).some((key) => format !== "ss" || key !== "ssSource");

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
  if (hasExtensions(project, format)) {
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
    if (project.meta.source && !["ss", "authored"].includes(project.meta.source)) {
      warnings.push(
        warning(
          "ss.export.sourceRulesChanged",
          "$.meta.source",
          "SS carries converted geometry; the original game's judgement rules are not carried",
        ),
      );
    }
    project.singles.forEach((note, index) => {
      if (note.type === "trace" && note.direction !== "none")
        warnings.push(
          warning(
            "ss.export.traceDirectionUnsupported",
            `$.singles[${index}].direction`,
            "OurNotes trace operations ignore flick direction",
          ),
        );
      if (!note.visible)
        warnings.push(
          warning(
            "ss.export.singleVisibilityIgnored",
            `$.singles[${index}].visible`,
            "OurNotes standalone operations remain visible in the current converter",
          ),
        );
    });
    project.lines.forEach((line, index) => {
      if (line.kind === "guide")
        warnings.push(
          warning(
            "ss.export.guideJudgementContext",
            `$.lines[${index}]`,
            "Guide-start judgement depends on a coincident standalone note in OurNotes",
          ),
        );
      line.points.forEach((point, at) => {
        if (line.kind === "long" && at > 0 && at < line.points.length - 1 && point.type === "flick") {
          warnings.push(
            warning(
              "ss.export.midpointFlickUnsupported",
              `$.lines[${index}].points[${at}]`,
              "OurNotes interior long-line nodes use connection judgement rather than flick judgement",
            ),
          );
        }
      });
    });
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
  project.lines.forEach((line, index) => {
    if (line.kind === "guide" && line.points.some((point) => point.visible))
      warnings.push(
        warning(
          "usc.export.guideJudgementsUnsupported",
          `$.lines[${index}]`,
          "Inactive USC connectors use ignored joints; independent authored point judgements are not carried",
        ),
      );
    if (line.kind === "long")
      line.points.slice(0, -1).forEach((point, at) => {
        if (point.type === "flick")
          warnings.push(
            warning(
              "usc.export.nonEndFlickUnsupported",
              `$.lines[${index}].points[${at}]`,
              "USC start and tick connections do not carry flick direction",
            ),
          );
      });
  });
  return warnings;
};

export interface ExportTargetValidation {
  /** Schema/budget compatibility with the named adapter, independently of device gameplay verification. */
  valid: boolean;
  errors: FormatWarning[];
  warnings: FormatWarning[];
}

/** Check Project invariants and the current SS reader's field/budget contract before native compilation. */
export const validateExportTarget = (project: Project, format: ExportFormat): ExportTargetValidation => {
  const canonical = validateProject(project);
  const errors: FormatWarning[] = canonical.errors.map(({ code, path, message }) => ({ code, path, message }));
  if (errors.length) return { valid: false, errors, warnings: [] };
  const warnings = getExportDiagnostics(project, format);
  if (format !== "ss") return { valid: true, errors, warnings };
  const document = projectToSs(project);
  const fail = (code: string, path: string, message: string) => errors.push(warning(code, path, message));
  for (const [key, array] of Object.entries(document.score.events)) {
    if (["bpm", "sig", "fever", "call"].includes(key) && Array.isArray(array) && array.length > 4096)
      fail(
        "ss.target.eventBudget",
        `$.score.events.${key}`,
        "The current OurNotes reader accepts at most 4096 timing entries",
      );
  }
  if (Array.isArray(document.score.events.bpm))
    document.score.events.bpm.forEach((point, index) => {
      if (!isRecord(point)) {
        fail("ss.target.eventObject", `$.score.events.bpm[${index}]`, "SS timing entries must be objects");
        return;
      }
      if (!Number.isFinite(point.bpm) || point.bpm <= 0 || point.bpm > 10000)
        fail(
          "ss.target.bpm",
          `$.score.events.bpm[${index}].bpm`,
          "The current OurNotes reader requires BPM above zero and at most 10000",
        );
    });
  if (Array.isArray(document.score.events.sig))
    document.score.events.sig.forEach((point, index) => {
      if (
        !isRecord(point) ||
        !Array.isArray(point.sig) ||
        point.sig.length < 2 ||
        point.sig.slice(0, 2).some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      )
        fail(
          "ss.target.signature",
          `$.score.events.sig[${index}]`,
          "The current OurNotes reader requires a positive numerator and denominator",
        );
    });
  if (Array.isArray(document.score.events.call))
    document.score.events.call.forEach((point, index) => {
      if (!isRecord(point))
        fail("ss.target.eventObject", `$.score.events.call[${index}]`, "SS timing entries must be objects");
    });
  if (Array.isArray(document.score.events.fever))
    document.score.events.fever.forEach((range, index) => {
      if (!Array.isArray(range) || range.length < 2)
        fail("ss.target.fever", `$.score.events.fever[${index}]`, "SS fever entries must contain at least two values");
    });
  let count = 0;
  const queue = document.score.notes.map((note, index) => ({ note, path: `$.score.notes[${index}]` }));
  for (let index = 0; index < queue.length && count <= 25000; index++) {
    const { note, path } = queue[index]!;
    count++;
    if (!isRecord(note)) {
      fail("ss.target.noteObject", path, "SS notes must be objects");
      continue;
    }
    for (const field of ["pos", "size"] as const) {
      const value = note[field];
      if (typeof value === "number" && !Number.isFinite(Math.fround(value)))
        fail("ss.target.floatGeometry", `${path}.${field}`, "OurNotes geometry must fit a native float field");
    }
    for (const [key, allowed] of [
      ["type", ["tap", "flick", "trace", "long", "guide", "node"]],
      ["dir", ["up", "left", "right", "down"]],
      ["alpha", ["none", "in", "out"]],
    ] as const) {
      const value = note[key];
      if (typeof value === "string" && !(allowed as readonly string[]).includes(value))
        fail("ss.target.enum", `${path}.${key}`, "The current OurNotes reader rejects this source enum");
    }
    if (
      note.ease !== undefined &&
      (Array.isArray(note.ease)
        ? note.ease.length !== 2 || note.ease.some((value) => !["linear", "in", "out"].includes(value))
        : typeof note.ease === "string" && !["linear", "in", "out"].includes(note.ease))
    )
      fail("ss.target.ease", `${path}.ease`, "SS ease must be a known string or two known strings");
    if (note.alpha && note.alpha !== "none")
      warnings.push(
        warning(
          "ss.preview.alphaReserved",
          `${path}.alpha`,
          "Source alpha is retained; the current OurNotes converter reserves its presentation behavior",
        ),
      );
    if (Array.isArray(note.node))
      note.node.forEach((child, at) => queue.push({ note: child, path: `${path}.node[${at}]` }));
  }
  if (count > 25000 || queue.length > 25000)
    fail(
      "ss.target.noteBudget",
      "$.score.notes",
      "The current OurNotes reader accepts at most 25000 source notes including nested nodes",
    );
  return { valid: errors.length === 0, errors, warnings };
};

/** Serialize after the SS adapter contract passes; runtime compilation remains the caller's next step. */
export const serializeSsForTarget = (project: Project, pretty = true): string => {
  const result = validateExportTarget(project, "ss");
  if (!result.valid)
    throw new ChartFormatError("ss", result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return serializeSs(project, pretty);
};
