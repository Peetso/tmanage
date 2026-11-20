import { PLAN_LIMITS, readPlanId } from '../billing/plan-catalog.js';
import { FAMILIES, normalizeMediaType } from './content-signature.js';
import { CONTRACT_MAX_SIZE_BYTES } from './upload-input.js';

/**
 * 56-06 — file safety, the one shared module (R19-e).
 *
 * Every door a file comes in through asks this module the same question before a byte is
 * stored: the studio and portal uploads (`files.service.ts`), a public form's attachment
 * (`public-forms.service.ts`, 52-20a) and inbound mail (54-12a, once that module exists). A doc
 * test (`file-safety.consumers.test.ts`) holds each consumer to importing it, so the rule can
 * never be copied and drift.
 *
 * Pure over names, a declared type, a size and (when the caller has them) the first bytes. It
 * never reads a database or a store. The deeper byte judgement — the signature allowlist, the
 * markup refusal, the whole-object text rule — stays `content-signature.ts`'s, run by the
 * verifier once the bytes exist; this module decides what may be *attempted* at all.
 *
 * ## What is refused, in order
 *
 * 1. **Executables** — a Windows PE (`MZ`), ELF (`7F 45 4C 46`) or Mach-O head; an executable
 *    name (`.exe`, `.msi`, `.jar`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.vbs`, `.js`, …) or an
 *    executable declared type. A name with an earlier extension (`invoice.pdf.exe`) is refused
 *    as `double_extension` — the disguise is the finding.
 * 2. **Macro Office** — `.docm/.xlsm/.pptm` (and their template/add-in kin), a declared
 *    `…macroEnabled…` type, or a `vbaProject.bin` entry name inside a ZIP head (only a door that
 *    has the head — inbound mail; the member and client doors classify before any byte exists,
 *    and the verifier reads the whole ZIP directory instead, below).
 * 3. **Size** — the caller's cap (the plan's, never above the contract's 5 GiB); a client is
 *    capped at 100 MB whatever the plan says.
 * 4. **Type** — the extension (or, with no known extension, the declared type) must fall in one
 *    of the organization's enabled presets. Archives are a preset of their own, ON by default
 *    since FIX5 (an organization that switched them off is refused with `archive_off`).
 * 5. **Channel** — a public form admits images and PDF only; inbound mail admits images, PDF and
 *    macro-free OOXML; neither ever admits an archive, whatever the presets say
 *    (56 §11.6: archives and Office never from anonymous visitors).
 *
 * The refusal is a closed reason token. The detection detail (which magic, which name) is never
 * part of the answer a caller sends back.
 */

/** The type presets an organization switches on or off (Security → File safety). */
export const FILE_TYPE_PRESETS = ['documents', 'images', 'design', 'video', 'archives'] as const;
export type FileTypePreset = (typeof FILE_TYPE_PRESETS)[number];

/**
 * Every preset, archives included. FIX5 item 3 (live check fd145807, B-N3): agencies send ZIPs
 * all the time and no screen could switch archives on, so every ZIP was refused. A ZIP is never
 * accepted from a public form or inbound mail (rule 5), and opens in the listing viewer. An
 * organization that saved a preset list without archives keeps its choice.
 *
 * What is *inside* a ZIP is judged once the bytes exist, by the verifier (`file-verifier.ts`,
 * `archive-inspection.ts`, security review FIX5 M2 and L3): it reads the central directory of
 * every ZIP and OOXML upload (member and client doors alike) and refuses the file when an entry
 * fails {@link archiveEntryFinding} or is named `vbaProject.bin`. This module's own head check
 * ({@link zipHeadNamesMacros}) runs only where a caller has the head before storing (inbound mail).
 */
export const DEFAULT_PRESETS: readonly FileTypePreset[] = [
  'documents',
  'images',
  'design',
  'video',
  'archives',
];

/** The door a file arrives through. */
export type UploadChannel = 'member' | 'client' | 'public_form' | 'inbound_mail';

/** The client door's own ceiling: 100 MB, below every paid plan's. */
export const CLIENT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** How many files one client user may upload per UTC day through the portal. */
export const CLIENT_DAILY_UPLOAD_LIMIT = 20;

export type FileSafetyReason =
  | 'executable'
  | 'macro_office'
  | 'archive_off'
  | 'double_extension'
  | 'type_not_allowed'
  | 'too_large'
  | 'channel_forbids';

export type ClassifyResult =
  | {
      readonly ok: true;
      readonly normalizedName: string;
      readonly family: FileTypePreset;
      readonly extension: string | null;
    }
  | { readonly ok: false; readonly reason: FileSafetyReason };

export interface ClassifyInput {
  readonly fileName: string;
  readonly declaredType: string;
  /** The first bytes, when the caller has them (up to 8 KiB is read). Empty before an upload. */
  readonly head?: Buffer;
  readonly sizeBytes: number;
  readonly channel: UploadChannel;
  readonly presets: readonly FileTypePreset[];
  readonly maxBytes: number;
}

interface TypeEntry {
  readonly preset: FileTypePreset;
  /** The canonical declared type, used to find a `content-signature` family for the head check. */
  readonly mime: string;
  /** PDF and images: the only types a public form admits. */
  readonly anonymousSafe?: boolean;
  /** Macro-free OOXML: inbound mail admits it beside images and PDF. */
  readonly officeOpenXml?: boolean;
}

const OOXML = 'application/vnd.openxmlformats-officedocument';

/** Extension → what it is. The one list; widening a preset is one line here. */
const BY_EXTENSION: Readonly<Record<string, TypeEntry>> = {
  // documents
  pdf: { preset: 'documents', mime: 'application/pdf', anonymousSafe: true },
  docx: {
    preset: 'documents',
    mime: `${OOXML}.wordprocessingml.document`,
    officeOpenXml: true,
  },
  xlsx: { preset: 'documents', mime: `${OOXML}.spreadsheetml.sheet`, officeOpenXml: true },
  pptx: {
    preset: 'documents',
    mime: `${OOXML}.presentationml.presentation`,
    officeOpenXml: true,
  },
  odt: { preset: 'documents', mime: 'application/vnd.oasis.opendocument.text' },
  ods: { preset: 'documents', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  odp: { preset: 'documents', mime: 'application/vnd.oasis.opendocument.presentation' },
  txt: { preset: 'documents', mime: 'text/plain' },
  md: { preset: 'documents', mime: 'text/markdown' },
  csv: { preset: 'documents', mime: 'text/csv' },
  // Peter, 2026-11-09: a web page (shown in a script-less sandbox, downloaded as an attachment).
  html: { preset: 'documents', mime: 'text/html' },
  htm: { preset: 'documents', mime: 'text/html' },
  // images
  jpg: { preset: 'images', mime: 'image/jpeg', anonymousSafe: true },
  jpeg: { preset: 'images', mime: 'image/jpeg', anonymousSafe: true },
  png: { preset: 'images', mime: 'image/png', anonymousSafe: true },
  webp: { preset: 'images', mime: 'image/webp', anonymousSafe: true },
  gif: { preset: 'images', mime: 'image/gif', anonymousSafe: true },
  svg: { preset: 'images', mime: 'image/svg+xml', anonymousSafe: true },
  heic: { preset: 'images', mime: 'image/heic', anonymousSafe: true },
  heif: { preset: 'images', mime: 'image/heif', anonymousSafe: true },
  // design
  psd: { preset: 'design', mime: 'image/vnd.adobe.photoshop' },
  psb: { preset: 'design', mime: 'image/vnd.adobe.photoshop' },
  ai: { preset: 'design', mime: 'application/illustrator' },
  eps: { preset: 'design', mime: 'application/postscript' },
  tif: { preset: 'design', mime: 'image/tiff' },
  tiff: { preset: 'design', mime: 'image/tiff' },
  sketch: { preset: 'design', mime: 'application/x-sketch' },
  fig: { preset: 'design', mime: 'application/x-figma' },
  // CAD and BIM (Peter, 2026-11-09). DXF and IFC are text and arrive as `text/plain`.
  dwg: { preset: 'design', mime: 'image/vnd.dwg' },
  dxf: { preset: 'design', mime: 'text/plain' },
  ifc: { preset: 'design', mime: 'text/plain' },
  skp: { preset: 'design', mime: 'application/vnd.sketchup.skp' },
  rvt: { preset: 'design', mime: 'application/vnd.autodesk.revit' },
  rfa: { preset: 'design', mime: 'application/vnd.autodesk.revit' },
  // video and audio
  mp4: { preset: 'video', mime: 'video/mp4' },
  mov: { preset: 'video', mime: 'video/quicktime' },
  webm: { preset: 'video', mime: 'video/webm' },
  mp3: { preset: 'video', mime: 'audio/mpeg' },
  m4a: { preset: 'video', mime: 'audio/mp4' },
  wav: { preset: 'video', mime: 'audio/wav' },
  ogg: { preset: 'video', mime: 'audio/ogg' },
  flac: { preset: 'video', mime: 'audio/flac' },
  // archives — ON by default since FIX5 item 3
  zip: { preset: 'archives', mime: 'application/zip' },
  '7z': { preset: 'archives', mime: 'application/x-7z-compressed' },
  rar: { preset: 'archives', mime: 'application/vnd.rar' },
};

/** Declared type → entry, for a name with no known extension (`brief.bin`, `Atlas`). */
const BY_DECLARED_TYPE: ReadonlyMap<string, TypeEntry> = (() => {
  const map = new Map<string, TypeEntry>();
  for (const entry of Object.values(BY_EXTENSION)) {
    if (!map.has(entry.mime)) map.set(entry.mime, entry);
  }
  // Aliases content-signature already admits.
  for (const family of FAMILIES) {
    for (const member of Object.keys(family.members)) {
      if (map.has(member)) continue;
      const canonical = Object.keys(family.members).find((m) => map.has(m));
      if (canonical) map.set(member, map.get(canonical) as TypeEntry);
    }
  }
  map.set('application/x-zip-compressed', BY_EXTENSION['zip'] as TypeEntry);
  map.set('application/x-rar-compressed', BY_EXTENSION['rar'] as TypeEntry);
  return map;
})();

/** Names a machine will run. Lowercase, without the dot. */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'msi',
  'msp',
  'jar',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'dll',
  'ps1',
  'psm1',
  'sh',
  'bash',
  'vbs',
  'vbe',
  'js',
  'jse',
  'mjs',
  'wsf',
  'wsh',
  'hta',
  'lnk',
  'reg',
  'app',
  'apk',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'run',
  'elf',
  'bin',
]);

/**
 * `.bin` is in the set above only as the *last* extension after another one
 * (`photo.jpg.bin`); a bare `brief.bin` is an unknown extension judged by its declared type.
 */
const AMBIGUOUS_EXECUTABLE: ReadonlySet<string> = new Set(['bin']);

const EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-msi',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/java-archive',
  'application/x-java-archive',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/vnd.microsoft.portable-executable',
  'application/hta',
  'text/vbscript',
]);

const MACRO_EXTENSIONS: ReadonlySet<string> = new Set([
  'docm',
  'dotm',
  'xlsm',
  'xltm',
  'xlam',
  'xlsb',
  'pptm',
  'potm',
  'ppsm',
  'ppam',
  'sldm',
]);

/**
 * Archive names, lowercase, without the dot: an archive inside an uploaded ZIP is refused (one
 * level only — the verifier does not open it, so it could hide anything). OOXML (`docx`, `xlsx`,
 * `pptx`) is not here: Office embeds one document in another, and its parts are judged as names.
 */
export const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip',
  'zipx',
  '7z',
  'rar',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz',
  'lzma',
  'z',
  'cab',
  'iso',
  'img',
  'arj',
  'lzh',
  'lha',
  'ace',
  'war',
  'ear',
  'cpio',
]);

/** What a name inside an archive is, when it is something an upload may not carry. */
export type ArchiveEntryFinding = 'executable' | 'double_extension' | 'macro_office' | 'archive';

/**
 * Judges one entry name of an uploaded ZIP (FIX5 M2) by the same lists the outer name is judged
 * by: an executable or script last extension (`double_extension` when an earlier one disguises
 * it), a macro Office extension, or an archive. `null` for a name that may pass. The caller
 * handles `vbaProject.bin` and encryption; this reads only the name (the part after the last `/`).
 */
export function archiveEntryFinding(entryPath: string): ArchiveEntryFinding | null {
  const base = entryPath.split('/').at(-1) ?? '';
  const extensions = extensionsOf(normalizeFileName(base));
  const last = extensions.at(-1) ?? null;
  if (last === null) return null;
  const earlier = extensions.slice(0, -1);
  if (EXECUTABLE_EXTENSIONS.has(last) && (!AMBIGUOUS_EXECUTABLE.has(last) || earlier.length > 0)) {
    return earlier.length > 0 ? 'double_extension' : 'executable';
  }
  if (MACRO_EXTENSIONS.has(last)) return 'macro_office';
  if (ARCHIVE_EXTENSIONS.has(last)) return 'archive';
  return null;
}

const startsWith = (head: Buffer, bytes: readonly number[]): boolean =>
  head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);

/** PE, ELF, and every Mach-O magic (32/64-bit, both byte orders, and the fat binary). */
export function isExecutableHead(head: Buffer): boolean {
  return (
    startsWith(head, [0x4d, 0x5a]) ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xca, 0xfe, 0xba, 0xbe])
  );
}

const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04] as const;

/** A ZIP-family head that names a `vbaProject.bin` entry inside its first 8 KiB. */
export function zipHeadNamesMacros(head: Buffer): boolean {
  if (!startsWith(head, ZIP_HEAD)) return false;
  return head.subarray(0, 8_192).toString('latin1').toLowerCase().includes('vbaproject.bin');
}

/** Bidi controls a name can use to show `exe.pdf` for `fdp.exe` (the RTLO trick). */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/gu;

/**
 * The name as a file system will treat it: bidi controls removed, and trailing dots and spaces
 * dropped (Windows strips them, so `a.exe.` *is* `a.exe`). Each extension segment is trimmed, so
 * `a.jpg .scr` reads as the extensions `jpg`, `scr`.
 */
export function normalizeFileName(fileName: string): string {
  return fileName
    .replace(BIDI_CONTROLS, '')
    .replace(/[.\s]+$/u, '')
    .split('.')
    .map((segment, index) => (index === 0 ? segment.trimEnd() : segment.trim()))
    .join('.');
}

/** The extensions after the stem, lowercase: `invoice.pdf.exe` → `['pdf', 'exe']`. */
function extensionsOf(normalizedName: string): string[] {
  const segments = normalizedName.split('.');
  if (segments.length < 2) return [];
  return segments
    .slice(1)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment !== '');
}

/** Whether `head` contradicts the type's signature family (where content-signature has one). */
function contradictsSignature(entry: TypeEntry, head: Buffer): boolean {
  if (head.length === 0) return false;
  const family = FAMILIES.find((candidate) => Object.hasOwn(candidate.members, entry.mime));
  // No family (odt, sketch, fig, webm, 7z, rar), or a textual one with no signature to
  // contradict: the verifier's whole-object rule is the judge, not this head check.
  if (!family || family.textual === true) return false;
  return !family.matches(head);
}

function channelAdmits(channel: UploadChannel, entry: TypeEntry): boolean {
  if (channel === 'public_form') return entry.anonymousSafe === true;
  if (channel === 'inbound_mail')
    return entry.anonymousSafe === true || entry.officeOpenXml === true;
  return true;
}

/**
 * The one classification. `ok: true` carries the normalised name (what to store) and the preset
 * the file fell into; `ok: false` carries only the reason token.
 */
export function classifyUpload(input: ClassifyInput): ClassifyResult {
  const head = input.head ?? Buffer.alloc(0);
  const declared = normalizeMediaType(input.declaredType);
  const normalizedName = normalizeFileName(input.fileName);
  const extensions = extensionsOf(normalizedName);
  const last = extensions.at(-1) ?? null;
  const earlier = extensions.slice(0, -1);

  // 1. Executables, by name, by head, by declared type.
  const lastIsExecutable =
    last !== null &&
    EXECUTABLE_EXTENSIONS.has(last) &&
    (!AMBIGUOUS_EXECUTABLE.has(last) || earlier.length > 0);
  if (lastIsExecutable) {
    return { ok: false, reason: earlier.length > 0 ? 'double_extension' : 'executable' };
  }
  if (isExecutableHead(head) || EXECUTABLE_TYPES.has(declared)) {
    return { ok: false, reason: 'executable' };
  }

  // 2. Macro Office.
  if (
    (last !== null && MACRO_EXTENSIONS.has(last)) ||
    declared.includes('macroenabled') ||
    zipHeadNamesMacros(head)
  ) {
    return { ok: false, reason: 'macro_office' };
  }

  // 3. Size.
  const ceiling = Math.min(
    input.maxBytes,
    CONTRACT_MAX_SIZE_BYTES,
    input.channel === 'client' ? CLIENT_MAX_FILE_BYTES : Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes > ceiling) {
    return { ok: false, reason: 'too_large' };
  }

  // 4. Type: the known extension first, then the declaration.
  const entry =
    (last !== null ? BY_EXTENSION[last] : undefined) ?? BY_DECLARED_TYPE.get(declared) ?? null;
  if (entry === null) return { ok: false, reason: 'type_not_allowed' };

  // 5. Channel, then the archive switch, then the presets.
  if (!channelAdmits(input.channel, entry)) return { ok: false, reason: 'channel_forbids' };
  if (entry.preset === 'archives' && !input.presets.includes('archives')) {
    return { ok: false, reason: 'archive_off' };
  }
  // A public form or inbound mail admits its fixed list whatever the presets say (52-20a, 54-12a).
  const presetBound = input.channel === 'member' || input.channel === 'client';
  if (presetBound && !input.presets.includes(entry.preset)) {
    return { ok: false, reason: 'type_not_allowed' };
  }
  if (contradictsSignature(entry, head)) return { ok: false, reason: 'type_not_allowed' };

  return { ok: true, normalizedName, family: entry.preset, extension: last };
}

// ── The plan's per-file cap ─────────────────────────────────────────────────

/**
 * The largest single file a plan accepts: `PLAN_LIMITS[plan].maxFileBytes`, never above the
 * upload contract's 5 GiB ceiling. An unknown or legacy plan id reads as its catalog plan.
 */
export function planMaxFileBytes(plan: string | null | undefined): number {
  const limits = PLAN_LIMITS[readPlanId(plan)];
  return Math.min(limits.maxFileBytes ?? CONTRACT_MAX_SIZE_BYTES, CONTRACT_MAX_SIZE_BYTES);
}

// ── Presets as stored ───────────────────────────────────────────────────────

export function isFileTypePreset(value: string): value is FileTypePreset {
  return (FILE_TYPE_PRESETS as readonly string[]).includes(value);
}

/**
 * Parse the stored `file_safety_presets` csv. Unknown names are dropped; an empty or missing value
 * reads as {@link DEFAULT_PRESETS}, so a damaged row never accepts less than a new organization.
 */
export function parsePresets(stored: string | undefined | null): readonly FileTypePreset[] {
  if (stored === undefined || stored === null || stored.trim() === '') return DEFAULT_PRESETS;
  const chosen = stored
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(isFileTypePreset);
  return chosen.length === 0
    ? DEFAULT_PRESETS
    : FILE_TYPE_PRESETS.filter((p) => chosen.includes(p));
}

/** The canonical csv: catalog order, no duplicates. */
export function presetsToCsv(presets: readonly FileTypePreset[]): string {
  return FILE_TYPE_PRESETS.filter((preset) => presets.includes(preset)).join(',');
}

// ── Honest "scanned by" facts ───────────────────────────────────────────────

export type ScanSource = 'tmanage' | 'provider' | 'none';
export const SCAN_SOURCES: readonly ScanSource[] = ['tmanage', 'provider', 'none'];

/** Object keys under a provider store would carry this prefix. No driver writes one today. */
export const PROVIDER_STORE_PREFIX = 'provider/';

/**
 * Who judged a version's bytes. `tmanage` only for a real engine's verdict (clamav — the `stub`
 * driver is a test double and `none` scans nothing). `provider` is reserved for an object held in
 * a provider store; none exists yet, so nothing answers it today.
 */
export function resolveScanSource(input: {
  readonly scanner: string | null;
  readonly scannerDriver?: string | null;
  readonly storedAt?: string | null;
}): ScanSource {
  if (input.storedAt?.startsWith(PROVIDER_STORE_PREFIX) === true) return 'provider';
  const driver = input.scannerDriver ?? input.scanner;
  return driver === 'clamav' ? 'tmanage' : 'none';
}

export type SafetyChip = 'scanned_tmanage' | 'scanned_provider' | 'not_scanned';

/**
 * The chip a file row shows. A `tmanage` source with a verdict other than `clean` is not
 * "scanned" in the chip's sense (an infected file is never shown as safe).
 */
export function safetyChip(version: {
  readonly scanSource?: string | null;
  readonly scanner?: string | null;
  readonly scanVerdict?: string | null;
  readonly objectKey?: string | null;
}): SafetyChip {
  const source =
    version.scanSource === 'tmanage' ||
    version.scanSource === 'provider' ||
    version.scanSource === 'none'
      ? version.scanSource
      : resolveScanSource({
          scanner: version.scanner ?? null,
          storedAt: version.objectKey ?? null,
        });
  if (source === 'provider') return 'scanned_provider';
  if (source === 'tmanage' && version.scanVerdict === 'clean') return 'scanned_tmanage';
  return 'not_scanned';
}

// ── Why a stored file was blocked (QA-FIX S9) ───────────────────────────────

/**
 * QA-FIX S9 (2026-11-20). The reason a screen gives for a blocked file, by kind. Every refusal used
 * to read "The virus check found a problem", so a `.php.jpg` whose bytes were a PNG (a type
 * mismatch, refused before any scan) was blamed on the virus engine. The closed rejection codes
 * (`content-signature.ts` `RejectionCode`, `archive-inspection.ts` `ArchiveRejectionCode`,
 * `file-scanner.ts` `MALWARE_REJECTION_CODE`) map to four kinds a person can act on; the detection
 * detail itself is never sent.
 */
export type BlockedReason = 'malware' | 'file_type' | 'content' | 'damaged';

export function blockedReasonFor(rejectionCode: string | null | undefined): BlockedReason | null {
  switch (rejectionCode) {
    case undefined:
    case null:
      return null;
    case 'malware_detected':
      return 'malware';
    case 'type_not_allowed':
    case 'type_mismatch':
      return 'file_type';
    case 'hash_mismatch':
      return 'damaged';
    default:
      // `macro_office`, `archive_contains_blocked`, `archive_nested`, `archive_encrypted`,
      // `archive_unreadable`, and any code added later: something inside the file was refused.
      return 'content';
  }
}
