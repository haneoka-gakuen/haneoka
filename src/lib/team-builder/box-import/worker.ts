import { parseBoxFiles, parseBoxText } from "./parser";
import { BoxImportError } from "./types";
self.onmessage = async (event: MessageEvent<{ id: string; files?: Blob[]; text?: string }>) => {
  const { id, files, text } = event.data;
  try {
    const result = files
      ? await parseBoxFiles(files, {
          progress: (completed, total) => self.postMessage({ id, progress: { completed, total } }),
        })
      : await parseBoxText(text || "");
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { code: error instanceof BoxImportError ? error.code : "box_parse_failed" } });
  } finally {
    self.close();
  }
};
