import { Inflate, Gunzip } from "fflate";
import { BOX_LIMITS, BoxImportError, type BoxParseOptions } from "./types";
export function losslessJson(text: string): unknown {
  if (text.length > BOX_LIMITS.textBytes || new TextEncoder().encode(text).length > BOX_LIMITS.textBytes)
    throw new BoxImportError("box_text_budget");
  // Quote numeric tokens only outside strings. No regex replacement inside credentials or escaped text.
  let result = "",
    i = 0,
    depth = 0,
    nodes = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        const c = text[i++];
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === '"') break;
      }
      result += text.slice(start, i);
      continue;
    }
    if (text[i] === "-" || /\d/.test(text[i]!)) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) throw new BoxImportError("box_invalid_json");
      result += JSON.stringify(m[0]);
      i += m[0].length;
    } else {
      const c = text[i++]!;
      if (c === "{" || c === "[") {
        if (++depth > 32 || ++nodes > 100000) throw new BoxImportError("box_json_budget");
      } else if (c === "}" || c === "]") depth--;
      result += c;
    }
  }
  try {
    return JSON.parse(result);
  } catch {
    throw new BoxImportError("box_invalid_json");
  }
}
export async function decompress(
  data: Uint8Array,
  method: "gzip" | "deflate",
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [],
    inflate = method === "gzip" ? new Gunzip(ondata) : new Inflate(ondata);
  let size = 0;
  function ondata(chunk: Uint8Array) {
    size += chunk.length;
    if (size > maximum) throw new BoxImportError("box_expanded_budget");
    chunks.push(chunk);
  }
  try {
    for (let i = 0; i < data.length; i += 1024) {
      signal?.throwIfAborted();
      inflate.push(data.subarray(i, i + 1024), i + 1024 >= data.length);
      if (i % 65536 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } catch (error) {
    if (error instanceof BoxImportError || signal?.aborted) throw error;
    throw new BoxImportError("box_invalid_compression");
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
export interface ZipEntry {
  index: number;
  path: string;
  size: number;
  compressed: number;
  method: number;
  offset: number;
  crc: number;
}
export function zipEntries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (i: number) => view.getUint16(i, true),
    u32 = (i: number) => view.getUint32(i, true);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === data.length) {
      end = i;
      break;
    }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10) || u16(end + 10) > BOX_LIMITS.entries)
    throw new BoxImportError("box_invalid_zip");
  const count = u16(end + 10),
    central = u32(end + 16),
    centralSize = u32(end + 12);
  if (central + centralSize !== end) throw new BoxImportError("box_invalid_zip");
  let offset = central,
    total = 0;
  const entries: ZipEntry[] = [],
    names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new BoxImportError("box_invalid_zip");
    const flags = u16(offset + 8),
      method = u16(offset + 10),
      compressed = u32(offset + 20),
      size = u32(offset + 24),
      nameLen = u16(offset + 28),
      extra = u16(offset + 30),
      comment = u16(offset + 32),
      local = u32(offset + 42),
      attributes = u32(offset + 38);
    if (
      offset + 46 + nameLen + extra + comment > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      ((attributes >>> 16) & 0xf000) === 0xa000
    )
      throw new BoxImportError("box_unsupported_zip");
    const path = new TextDecoder("utf-8", { fatal: true })
      .decode(data.subarray(offset + 46, offset + 46 + nameLen))
      .replace(/\\/g, "/")
      .normalize("NFC");
    if (
      path.length > 240 ||
      path.startsWith("/") ||
      path.includes(":") ||
      /[\u0000-\u001f]/.test(path) ||
      path.split("/").some((p) => p === ".." || p === ".") ||
      names.has(path)
    )
      throw new BoxImportError("box_invalid_zip_path");
    names.add(path);
    offset += 46 + nameLen + extra + comment;
    if (path.endsWith("/")) continue;
    total += size;
    if (size > BOX_LIMITS.fileBytes || total > BOX_LIMITS.expandedBytes || (compressed === 0 && size !== 0))
      throw new BoxImportError("box_expanded_budget");
    if (local + 30 > central || u32(local) !== 0x04034b50 || u16(local + 8) !== method)
      throw new BoxImportError("box_invalid_zip");
    const localNameLength = u16(local + 26),
      localExtra = u16(local + 28);
    if (local + 30 + localNameLength + localExtra > central || u16(local + 6) !== flags)
      throw new BoxImportError("box_invalid_zip");
    const localPath = new TextDecoder("utf-8", { fatal: true })
      .decode(data.subarray(local + 30, local + 30 + localNameLength))
      .replace(/\\/g, "/")
      .normalize("NFC");
    if (localPath !== path) throw new BoxImportError("box_invalid_zip_path");
    const body = local + 30 + localNameLength + localExtra;
    if (body + compressed > central) throw new BoxImportError("box_invalid_zip");
    entries.push({ index, path, size, compressed, method, offset: body, crc: u32(local + 14) });
    // Central CRC is authoritative when a data descriptor follows the body.
    entries[entries.length - 1]!.crc = u32(offset - 46 - nameLen - extra - comment + 16);
  }
  if (offset !== end) throw new BoxImportError("box_invalid_zip");
  return entries;
}
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function readZipEntry(data: Uint8Array, entry: ZipEntry, options: BoxParseOptions): Promise<Uint8Array> {
  const raw = data.subarray(entry.offset, entry.offset + entry.compressed),
    out =
      entry.method === 0
        ? raw
        : await decompress(raw, "deflate", Math.min(BOX_LIMITS.fileBytes, entry.size), options.signal);
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new BoxImportError("box_zip_checksum");
  return out;
}
