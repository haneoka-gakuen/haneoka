import { isEncryptedBox, decryptBox } from "./crypt";
import { losslessJson, decompress, zipEntries, readZipEntry } from "./formats";
import {
  BOX_LIMITS,
  BoxImportError,
  object,
  integer,
  decimal,
  type BoxCandidate,
  type BoxParseOptions,
  type BoxParseResult,
} from "./types";
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  if (value.length > BOX_LIMITS.rowsPerList) throw new BoxImportError("box_row_budget");
  return value;
}
const cardId = (value: unknown) => {
  const id = integer(value);
  return id !== null && id > 0 && id <= 0x7fffffff ? id : null;
};
function project(value: unknown, format: BoxCandidate["format"]): BoxCandidate | null {
  const root = object(value);
  if (!root) return null;
  const compact = integer(root.v) === 1 && (Array.isArray(root.m) || Array.isArray(root.s));
  const player = compact ? root : object(root._player) || object(root.player) || root;
  if (!compact && !Array.isArray(player._memberCards) && !Array.isArray(player._supportCards)) return null;
  const members: BoxCandidate["members"] = [],
    snapshots: BoxCandidate["snapshots"] = [],
    characters: BoxCandidate["characters"] = [],
    bandItems: BoxCandidate["bandItems"] = [];
  for (const value of list(compact ? player.m : player._memberCards)) {
    const row: Record<string, unknown> | null =
      compact && Array.isArray(value)
        ? {
            _masterId: value[0],
            _exp: value[1],
            _awakeCount: value[2],
            _rank: value[3],
            _liveSkillLevel: value[4],
            _performanceSkillLevel: value[5],
          }
        : object(value);
    if (!row) continue;
    const id = cardId(row._masterId);
    if (id === null) continue;
    members.push({
      cardId: id,
      exp: decimal(row._exp),
      awakeCount: integer(row._awakeCount),
      rank: integer(row._rank),
      liveSkillLevel: integer(row._liveSkillLevel),
      performanceSkillLevel: integer(row._performanceSkillLevel),
    });
  }
  for (const value of list(compact ? player.s : player._supportCards)) {
    const row: Record<string, unknown> | null =
      compact && Array.isArray(value) ? { _masterId: value[0], _exp: value[1], _rank: value[2] } : object(value);
    if (!row) continue;
    const id = cardId(row._masterId);
    if (id !== null) snapshots.push({ cardId: id, exp: decimal(row._exp), rank: integer(row._rank) });
  }
  for (const value of list(compact ? player.c : player._characters)) {
    const row: Record<string, unknown> | null =
      compact && Array.isArray(value) ? { _masterId: value[0], _exp: value[1] } : object(value);
    if (!row) continue;
    const id = cardId(row._masterId);
    if (id !== null) characters.push({ id, exp: decimal(row._exp) });
  }
  for (const value of list(compact ? player.b : player._bandItems)) {
    const row: Record<string, unknown> | null =
      compact && Array.isArray(value) ? { _masterId: value[0], _level: value[1] } : object(value);
    if (!row) continue;
    const id = cardId(row._masterId ?? row._id);
    if (id !== null) bandItems.push({ id, level: integer(row._level) });
  }
  // No _name/_accountid/password/token/player id/duplicate counts survive this boundary.
  return { id: crypto.randomUUID(), format: compact ? "onpkg1" : format, members, snapshots, characters, bandItems };
}
const utf8 = (data: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new BoxImportError("box_invalid_utf8");
  }
};
export async function parseBoxText(text: string, options: BoxParseOptions = {}): Promise<BoxParseResult> {
  options.signal?.throwIfAborted();
  if (text.length > BOX_LIMITS.textBytes) throw new BoxImportError("box_text_budget");
  const trimmed = text.trim();
  let decoded = trimmed;
  if (trimmed.startsWith("ONPKG1:")) {
    const base64 = trimmed.slice(7).replace(/\s/g, "");
    if (base64.length > (BOX_LIMITS.inputBytes * 4) / 3 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
      throw new BoxImportError("box_invalid_onpkg");
    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      throw new BoxImportError("box_invalid_onpkg");
    }
    const raw = await decompress(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      "gzip",
      BOX_LIMITS.textBytes,
      options.signal,
    );
    try {
      decoded = utf8(raw);
    } finally {
      raw.fill(0);
    }
  }
  const candidate = project(losslessJson(decoded), "player-json");
  if (!candidate) throw new BoxImportError("box_no_player");
  options.signal?.throwIfAborted();
  return { schema: "haneoka-box-import-v1", candidates: [candidate], ignoredFiles: 0 };
}
async function parseBytes(data: Uint8Array, options: BoxParseOptions): Promise<BoxCandidate | null> {
  options.signal?.throwIfAborted();
  if (isEncryptedBox(data)) {
    const plain = await decryptBox(data, options.signal);
    try {
      return project(losslessJson(utf8(plain)), "encrypted-player");
    } finally {
      plain.fill(0);
    }
  }
  if (data[0] === 0x1f && data[1] === 0x8b) {
    const plain = await decompress(data, "gzip", BOX_LIMITS.textBytes, options.signal);
    try {
      return project(losslessJson(utf8(plain)), "player-json");
    } finally {
      plain.fill(0);
    }
  }
  // Unsupported binary files are ignored; no APK, script or executable is run.
  const prefix = new TextDecoder().decode(data.subarray(0, 64)).trimStart();
  if (!prefix.startsWith("{") && !prefix.startsWith("ONPKG1:")) return null;
  if (prefix.startsWith("ONPKG1:")) return (await parseBoxText(utf8(data), options)).candidates[0]!;
  return project(losslessJson(utf8(data)), "player-json");
}
export async function parseBoxFiles(files: readonly Blob[], options: BoxParseOptions = {}): Promise<BoxParseResult> {
  if (
    !files.length ||
    files.length > BOX_LIMITS.entries ||
    files.reduce((n, f) => n + f.size, 0) > BOX_LIMITS.inputBytes
  )
    throw new BoxImportError("box_input_budget");
  const candidates: BoxCandidate[] = [],
    seen = new Set<string>();
  let ignoredFiles = 0,
    totalExpanded = 0,
    completed = 0;
  const accept = async (data: Uint8Array) => {
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    const candidate = await parseBytes(data, options);
    if (!candidate) {
      ignoredFiles++;
      return;
    }
    if (candidates.length >= BOX_LIMITS.candidates) throw new BoxImportError("box_candidate_budget");
    candidates.push(candidate);
  };
  for (const file of files) {
    options.signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const entries = zipEntries(bytes);
        for (const entry of entries) {
          options.signal?.throwIfAborted();
          totalExpanded += entry.size;
          if (totalExpanded > BOX_LIMITS.expandedBytes) throw new BoxImportError("box_expanded_budget");
          const data = await readZipEntry(bytes, entry, options);
          try {
            await accept(data);
          } finally {
            if (data.buffer !== bytes.buffer) data.fill(0);
          }
        }
      } else {
        if (bytes.length > BOX_LIMITS.fileBytes) throw new BoxImportError("box_file_budget");
        await accept(bytes);
      }
      options.progress?.(++completed, files.length);
    } finally {
      bytes.fill(0);
    }
  }
  if (!candidates.length) throw new BoxImportError("box_no_player");
  return { schema: "haneoka-box-import-v1", candidates, ignoredFiles };
}
