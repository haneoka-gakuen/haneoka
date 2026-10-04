import type { TeamBuilderData } from "../data";
import type { InventoryKind, InventoryV1 } from "../inventory";
import { previewInventoryList } from "../data/list-import";
import type { BoxPreview, BoxReviewContext } from "./preview";
import { BoxImportError, type BoxParseOptions } from "./types";

export type InventoryListInput = { files: readonly File[] } | { text: string };
const MAX_LIST_BYTES = 1024 * 1024;
const listFile = (file: File) => /\.(csv|tsv)$/iu.test(file.name);

/** JSON and ONPKG keep their existing parser; names/IDs and tables use the local list reader. */
export function isInventoryListInput(input: InventoryListInput): boolean {
  if ("files" in input) return input.files.some(listFile);
  const text = input.text.trim();
  return !!text && !text.startsWith("ONPKG1:") && !/^[{\[]/u.test(text);
}

/** One bounded list document produces the same explicit review/merge contract as Box. */
export async function previewInventoryListInput(
  input: InventoryListInput,
  current: InventoryV1,
  data: TeamBuilderData,
  context: BoxReviewContext,
  defaultKind: InventoryKind,
  options: BoxParseOptions = {},
): Promise<BoxPreview> {
  options.signal?.throwIfAborted();
  let text: string;
  if ("files" in input) {
    const file = input.files[0];
    if (input.files.length !== 1 || !file || !listFile(file) || file.size > MAX_LIST_BYTES)
      throw new BoxImportError("box_invalid_list");
    text = await file.text();
  } else text = input.text;
  options.signal?.throwIfAborted();
  try {
    const { preview } = previewInventoryList(text, current, data, context, defaultKind);
    if (!preview.cards.length) throw new BoxImportError("box_no_player");
    options.signal?.throwIfAborted();
    options.progress?.(1, 1);
    return preview;
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (error instanceof BoxImportError) throw error;
    throw new BoxImportError("box_invalid_list");
  }
}
