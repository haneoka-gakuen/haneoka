import { cubismModelMetadata as readMetadata } from "./cubism-model-metadata";
import { staticBuildJson } from "./static-input-store";

export function cubismModelMetadata(...args: Parameters<typeof readMetadata>): ReturnType<typeof readMetadata> {
  const [model, release] = args;
  const runtime =
    model.runtime && typeof model.runtime === "object" ? (model.runtime as Record<string, unknown>) : model;
  return staticBuildJson(
    `cubism-metadata:${release.server}:${release.releaseId}:${release.sourceId}:${String(runtime.moc || "")}`,
    "model-metadata",
    () => readMetadata(...args),
  );
}
