import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import type { ObjectStore, TrustZone } from '@tmanage/storage';
import { archiveEntryFinding } from './file-safety.js';
import type { ArchiveEntryFinding } from './file-safety.js';
import {
  readZipDirectory,
  zipDirectoryStart,
  ZipReadError,
} from './preview-generators/zip-reader.js';
import type { ZipDirectory, ZipEntry, ZipLimits } from './preview-generators/zip-reader.js';

/**
 * Security review FIX5, M2 and L3 — what is inside a ZIP.
 *
 * Archives are on by default for members and clients (FIX5 item 3), and every rule that refuses a
 * program, a script, a macro document or a disguised name looked only at the outer name and the
 * first bytes. The verifier now reads the archive's table of contents (the central directory) for
 * every ZIP-family upload — `zip` and the OOXML documents `docx`, `xlsx`, `pptx` — and refuses the
 * file when an entry is one of those. Nothing is inflated or extracted: the directory is read from
 * the object's tail with ranged reads, capped, by the same pure reader the ZIP list uses.
 *
 * ## Refusals (the `rejection_code` the asset gets)
 *
 * - `macro_office` — an OOXML document carrying `vbaProject.bin`: a `.docm` renamed `.docx` (L3).
 * - `archive_contains_blocked` — an entry with an executable or script name (`exe`, `msi`, `bat`,
 *   `cmd`, `ps1`, `scr`, `lnk`, `com`, `pif`, `js`, `jse`, `vbs`, `vbe`, `wsf`, `wsh`, `hta`, … the
 *   whole `EXECUTABLE_EXTENSIONS` list), a double extension ending in one (`invoice.pdf.exe`), a
 *   macro Office name (`MACRO_EXTENSIONS`), or a `vbaProject.bin` inside a plain ZIP.
 * - `archive_nested` — an archive inside the archive. One level only: the inner one is not
 *   opened, so it could hide anything above, and it is refused by name.
 * - `archive_encrypted` — an encrypted entry, **client door only**. The names are still read and
 *   judged (ZIP encrypts contents, not names); a member may send a password-protected ZIP, a
 *   client may not, since nothing could ever look at what a portal user put inside.
 * - `archive_unreadable` — a ZIP-signed object whose directory cannot be read, or one above the
 *   caps below: an archive TManage cannot look inside is not passed on as if it had.
 *
 * Every refusal but `archive_unreadable` names the entry. The name is never in the audit row (it
 * is content); the member's upload answer re-reads it from the quarantined object
 * (`files.service.ts`, `rejectedEntry`), so no column is needed to keep it.
 */

export type ArchiveRejectionCode =
  | 'macro_office'
  | 'archive_contains_blocked'
  | 'archive_nested'
  | 'archive_encrypted'
  | 'archive_unreadable';

/** The codes {@link inspectStoredArchive} can produce — the ones whose entry an answer may name. */
export const ARCHIVE_REJECTION_CODES: ReadonlySet<string> = new Set<ArchiveRejectionCode>([
  'macro_office',
  'archive_contains_blocked',
  'archive_nested',
  'archive_encrypted',
  'archive_unreadable',
]);

export interface ArchiveRefusal {
  readonly code: ArchiveRejectionCode;
  /** The offending entry's path, for the uploader; `null` for `archive_unreadable`. */
  readonly entry: string | null;
  /** What the entry was, a token for the audit row (never the name). */
  readonly finding: ArchiveEntryFinding | 'vba_project' | 'encrypted' | 'unreadable';
}

/** The detected-type tokens whose bytes are a ZIP (`content-signature.ts`). */
export const ZIP_FAMILY_TOKENS: ReadonlySet<string> = new Set([
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'fig',
]);

/** The longest entry path an answer carries; a longer one keeps its end (the file name). */
export const ENTRY_DISPLAY_MAX = 200;

/**
 * The verifier's caps. The declared unpacked total is irrelevant here (nothing is inflated), so
 * only the entry count and the directory's own size bound the work.
 */
export const INSPECTION_LIMITS: ZipLimits = {
  maxEntries: 50_000,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
};

/** The most directory bytes one inspection reads (50 000 entries with long names fit). */
export const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** End record (22) + the longest comment + the ZIP64 locator (20). */
const TAIL_BYTES = 22 + 0xffff + 20;

export type InspectionChannel = 'member' | 'client';

export interface InspectionOptions {
  readonly channel: InspectionChannel;
  /**
   * `true` for a `.fig` (security review L1, 2026-11-14): a ZIP without Figma's `canvas.fig` is not
   * a Figma file, so it cannot pass under the design preset while archives are off.
   */
  readonly figmaFile?: boolean;
  /** `true` for `docx`/`xlsx`/`pptx`: a `vbaProject.bin` there is `macro_office`. */
  readonly officeOpenXml: boolean;
}

/** Bidi and C0/C1 controls, removed from a name before it is shown to anyone. */
const UNSAFE_DISPLAY = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** The entry path as an answer may carry it: no controls, at most {@link ENTRY_DISPLAY_MAX}. */
export function displayEntryPath(path: string): string {
  const clean = path.replace(UNSAFE_DISPLAY, '');
  return clean.length <= ENTRY_DISPLAY_MAX ? clean : `…${clean.slice(-(ENTRY_DISPLAY_MAX - 1))}`;
}

/** The pure judgement over a directory: the first entry that must not pass, or `null`. */
export function judgeArchiveDirectory(
  directory: ZipDirectory,
  options: InspectionOptions,
): ArchiveRefusal | null {
  for (const entry of directory.entries) {
    if (entry.folder) continue;
    const name = entry.path.split('/').at(-1) ?? '';
    const shown = displayEntryPath(entry.path);
    if (name.toLowerCase() === 'vbaproject.bin') {
      return {
        code: options.officeOpenXml ? 'macro_office' : 'archive_contains_blocked',
        entry: shown,
        finding: 'vba_project',
      };
    }
    const finding = archiveEntryFinding(entry.path);
    if (finding === 'archive') return { code: 'archive_nested', entry: shown, finding };
    if (finding !== null) return { code: 'archive_contains_blocked', entry: shown, finding };
    if (entry.encrypted && options.channel === 'client') {
      return { code: 'archive_encrypted', entry: shown, finding: 'encrypted' };
    }
  }
  if (
    options.figmaFile === true &&
    !directory.entries.some((entry) => !entry.folder && entry.path === 'canvas.fig')
  ) {
    return { code: 'archive_unreadable', entry: null, finding: 'unreadable' };
  }
  return null;
}

export interface StoredObjectRef {
  readonly zone: TrustZone;
  readonly objectKey: string;
  readonly sizeBytes: number;
}

/** `fig-kiwi`: the first 8 bytes of every `canvas.fig` Figma writes. */
const FIG_CANVAS_MAGIC = Buffer.from('fig-kiwi', 'latin1');
/** Compressed bytes read to find the first 8 of a deflated `canvas.fig`. */
const FIG_HEADER_PROBE_BYTES = 4096;
/** Of those, the compressed bytes inflated (enough for the first 8 out). */
const FIG_INFLATE_PROBE_BYTES = 256;

/**
 * Re-check of security review L1 (2026-11-14): whether a `canvas.fig` entry starts with Figma's
 * `fig-kiwi` header. `span` holds the archive's bytes from the entry's local header on (at least
 * its header, names and first compressed bytes). Anything else, an empty entry included, is not
 * a Figma canvas.
 */
export function startsAsFigCanvas(span: Uint8Array, entry: ZipEntry): boolean {
  if (entry.encrypted || entry.sizeBytes < FIG_CANVAS_MAGIC.length || span.byteLength < 30) {
    return false;
  }
  const data = new DataView(span.buffer, span.byteOffset, span.byteLength);
  if (data.getUint32(0, true) !== 0x04034b50) return false;
  const start = 30 + data.getUint16(26, true) + data.getUint16(28, true);
  const body = span.subarray(
    start,
    start + Math.min(entry.compressedBytes, FIG_HEADER_PROBE_BYTES),
  );
  let head: Uint8Array;
  if (entry.method === 0) head = body;
  else if (entry.method === 8) {
    try {
      // A cut-off stream: inflate its first bytes only. Deflate expands at most about 1 032 to
      // 1, so 256 bytes in give well under the 512 KiB allowed out.
      head = inflateRawSync(body.subarray(0, FIG_INFLATE_PROBE_BYTES), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: 512 * 1024,
      });
    } catch {
      return false;
    }
  } else return false;
  return FIG_CANVAS_MAGIC.equals(Buffer.from(head.subarray(0, FIG_CANVAS_MAGIC.length)));
}

async function readRange(
  store: ObjectStore,
  object: StoredObjectRef,
  start: number,
): Promise<Buffer> {
  const opened = await store.openObject({
    zone: object.zone,
    objectKey: object.objectKey,
    range: { start, end: object.sizeBytes - 1 },
  });
  const chunks: Buffer[] = [];
  let total = 0;
  const wanted = object.sizeBytes - start;
  for await (const piece of opened.stream) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
    chunks.push(chunk);
    total += chunk.length;
    if (total > wanted) break;
  }
  return Buffer.concat(chunks).subarray(0, wanted);
}

/**
 * The directory of a stored ZIP, from its tail: the end record first, then (when the directory
 * starts before that tail) the bytes from the directory's start to the end. Store errors are the
 * caller's; a broken or oversized directory is {@link ZipReadError}.
 */
export async function readStoredZipDirectory(
  store: ObjectStore,
  object: StoredObjectRef,
  limits: ZipLimits = INSPECTION_LIMITS,
): Promise<ZipDirectory> {
  let base = Math.max(0, object.sizeBytes - TAIL_BYTES);
  let bytes = await readRange(store, object, base);
  // At most twice more: once for a ZIP64 record before the tail, once for its directory.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { start, entries } = zipDirectoryStart(bytes, base);
    if (entries !== null && entries > limits.maxEntries) throw new ZipReadError('zip_bomb');
    if (start >= base) return readZipDirectory(bytes, limits, base);
    if (start < 0 || start >= object.sizeBytes) throw new ZipReadError('zip_unreadable');
    if (object.sizeBytes - start > MAX_DIRECTORY_BYTES) throw new ZipReadError('zip_bomb');
    base = start;
    bytes = await readRange(store, object, base);
  }
  throw new ZipReadError('zip_unreadable');
}

/**
 * Reads and judges a stored ZIP-family object. A directory that cannot be read (or is above the
 * caps) is `archive_unreadable`; a store error is thrown for the caller to classify.
 */
export async function inspectStoredArchive(
  store: ObjectStore,
  object: StoredObjectRef,
  options: InspectionOptions,
): Promise<ArchiveRefusal | null> {
  let directory: ZipDirectory;
  try {
    directory = await readStoredZipDirectory(store, object);
  } catch (error) {
    if (error instanceof ZipReadError) {
      return { code: 'archive_unreadable', entry: null, finding: 'unreadable' };
    }
    throw error;
  }
  const refusal = judgeArchiveDirectory(directory, options);
  if (refusal !== null || options.figmaFile !== true) return refusal;
  const canvas = directory.entries.find((entry) => !entry.folder && entry.path === 'canvas.fig');
  if (!canvas) return { code: 'archive_unreadable', entry: null, finding: 'unreadable' };
  // The local header (30 bytes), its names (at most 2 x 64 KiB) and the first compressed bytes.
  const start = canvas.localHeaderOffset;
  const end = Math.min(object.sizeBytes, start + 30 + 2 * 65_535 + FIG_HEADER_PROBE_BYTES) - 1;
  if (start > end) return { code: 'archive_unreadable', entry: null, finding: 'unreadable' };
  const opened = await store.openObject({
    zone: object.zone,
    objectKey: object.objectKey,
    range: { start, end },
  });
  const chunks: Buffer[] = [];
  for await (const piece of opened.stream) {
    chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string));
  }
  return startsAsFigCanvas(Buffer.concat(chunks), canvas)
    ? null
    : { code: 'archive_unreadable', entry: null, finding: 'unreadable' };
}
