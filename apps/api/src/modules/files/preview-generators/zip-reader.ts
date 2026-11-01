import { inflateRawSync } from 'node:zlib';

/**
 * R4 slice 10 — a ZIP reader that looks at the archive's table of contents (the central
 * directory) and nothing else, unless asked for one small named part.
 *
 * Used twice: the ZIP list (`zip_manifest`: names, sizes, dates, nothing extracted) and the
 * Office facts (`office_meta`: a DOCX/PPTX/XLSX is a ZIP; a few XML parts are read). Pure
 * JavaScript plus Node's own zlib, so it runs on Hostinger shared hosting.
 *
 * Bombs are refused before anything is inflated: too many entries, or a declared unpacked total
 * above the cap, is `zip_bomb`. A named part is inflated with an output ceiling, so a part that
 * claims 1 KB and inflates to 1 GB stops at the ceiling.
 */

export interface ZipEntry {
  /** The path inside the archive, `/`-separated; folders end with `/`. */
  readonly path: string;
  readonly folder: boolean;
  readonly sizeBytes: number;
  readonly compressedBytes: number;
  /** Local time stamp as written by the zipping tool, ISO without zone (`2026-10-28T14:05:00`). */
  readonly modifiedAt: string | null;
  readonly encrypted: boolean;
  readonly method: number;
  readonly localHeaderOffset: number;
}

export interface ZipDirectory {
  readonly entries: readonly ZipEntry[];
}

export class ZipReadError extends Error {
  constructor(readonly code: 'zip_unreadable' | 'zip_bomb' | 'zip_part_too_large') {
    super(code);
    this.name = 'ZipReadError';
  }
}

export interface ZipLimits {
  readonly maxEntries: number;
  /** Declared unpacked total, all entries together. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(data: DataView, at: number): number {
  const low = data.getUint32(at, true);
  const high = data.getUint32(at + 4, true);
  return high * 0x1_0000_0000 + low;
}

function findEndRecord(data: DataView): number {
  const last = data.byteLength - 22;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let at = last; at >= first; at -= 1) {
    if (data.getUint32(at, true) === EOCD) return at;
  }
  return -1;
}

function dosDate(date: number, time: number): string | null {
  if (date === 0) return null;
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = time >> 11;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(Math.min(seconds, 59))}`;
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/** Reads the central directory. Throws {@link ZipReadError} for a broken or bomb-shaped archive. */
export function readZipDirectory(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipDirectory {
  if (bytes.byteLength < 22) throw new ZipReadError('zip_unreadable');
  const data = view(bytes);
  const end = findEndRecord(data);
  if (end < 0) throw new ZipReadError('zip_unreadable');

  let count = data.getUint16(end + 10, true);
  let offset = data.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || data.getUint32(locator, true) !== ZIP64_LOCATOR) {
      throw new ZipReadError('zip_unreadable');
    }
    const record = u64(data, locator + 8);
    if (record + 56 > bytes.byteLength || data.getUint32(record, true) !== ZIP64_EOCD) {
      throw new ZipReadError('zip_unreadable');
    }
    count = u64(data, record + 32);
    offset = u64(data, record + 48);
  }
  if (count > limits.maxEntries) throw new ZipReadError('zip_bomb');

  const entries: ZipEntry[] = [];
  let total = 0;
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.byteLength || data.getUint32(at, true) !== CENTRAL) {
      throw new ZipReadError('zip_unreadable');
    }
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const time = data.getUint16(at + 12, true);
    const date = data.getUint16(at + 14, true);
    let compressed = data.getUint32(at + 20, true);
    let size = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    let local = data.getUint32(at + 42, true);
    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > bytes.byteLength) throw new ZipReadError('zip_unreadable');

    // ZIP64 sizes live in extra field 0x0001, in this order, only for the values that overflowed.
    if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) {
      let cursor = extraStart;
      while (cursor + 4 <= extraStart + extraLength) {
        const id = data.getUint16(cursor, true);
        const length = data.getUint16(cursor + 2, true);
        if (id === 0x0001) {
          let field = cursor + 4;
          if (size === 0xffffffff && field + 8 <= cursor + 4 + length) {
            size = u64(data, field);
            field += 8;
          }
          if (compressed === 0xffffffff && field + 8 <= cursor + 4 + length) {
            compressed = u64(data, field);
            field += 8;
          }
          if (local === 0xffffffff && field + 8 <= cursor + 4 + length) local = u64(data, field);
          break;
        }
        cursor += 4 + length;
      }
    }

    const rawName = bytes.subarray(nameStart, extraStart);
    const path = ((flags & 0x0800) !== 0 ? utf8 : latin1).decode(rawName).replace(/\\/g, '/');
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipReadError('zip_bomb');
    entries.push({
      path,
      folder: path.endsWith('/'),
      sizeBytes: size,
      compressedBytes: compressed,
      modifiedAt: dosDate(date, time),
      encrypted: (flags & 0x0001) !== 0,
      method,
      localHeaderOffset: local,
    });
    at = next;
  }
  return { entries };
}

/**
 * Inflates one named part (stored or deflated), at most `maxBytes` long. `null` when the part is
 * not in the archive. Throws {@link ZipReadError} when it is encrypted, broken, or too large.
 */
export function readZipPart(
  bytes: Uint8Array,
  directory: ZipDirectory,
  path: string,
  maxBytes: number,
): Uint8Array | null {
  const entry = directory.entries.find((candidate) => candidate.path === path);
  if (!entry) return null;
  if (entry.encrypted) throw new ZipReadError('zip_unreadable');
  if (entry.sizeBytes > maxBytes) throw new ZipReadError('zip_part_too_large');
  const data = view(bytes);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.byteLength || data.getUint32(at, true) !== LOCAL) {
    throw new ZipReadError('zip_unreadable');
  }
  const start = at + 30 + data.getUint16(at + 26, true) + data.getUint16(at + 28, true);
  const stop = start + entry.compressedBytes;
  if (stop > bytes.byteLength) throw new ZipReadError('zip_unreadable');
  const body = bytes.subarray(start, stop);
  if (entry.method === 0) return body;
  if (entry.method !== 8) throw new ZipReadError('zip_unreadable');
  try {
    return inflateRawSync(body, { maxOutputLength: maxBytes });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new ZipReadError('zip_part_too_large');
    throw new ZipReadError('zip_unreadable');
  }
}

/** A part as UTF-8 text (an Office XML part), or `null` when it is absent. */
export function readZipText(
  bytes: Uint8Array,
  directory: ZipDirectory,
  path: string,
  maxBytes: number,
): string | null {
  const part = readZipPart(bytes, directory, path, maxBytes);
  return part === null ? null : utf8.decode(part);
}
