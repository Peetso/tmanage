/**
 * FILE-002, slice A — the signature allowlist and the one-pass judge.
 *
 * `04-SECURITY-PRIVACY` §6 ("file validation uses content signatures, size/type quotas"),
 * `26-THREAT-MODELS` §79 ("signature allowlist", against "spoofed MIME", "polyglot/malware",
 * "HTML/SVG"), `27-TEST-CATALOG` SEC-06 ("MIME spoof, SVG/HTML, polyglot"). Nothing in the
 * pack enumerates the allowed types — `04` asks for "size/type quotas" and no document names
 * a list — so this file is the list, and it is deliberately short (decision F5, Peter's to
 * widen: one edit to {@link FAMILIES}). A type that is not here is refused as
 * `type_not_allowed` before its bytes are judged; a type that is here must also *look*
 * like itself, or the refusal is `type_mismatch`.
 *
 * ## Families, not types
 *
 * A declared type is compared with the bytes by **family**. Every Office document is a ZIP
 * container, so its first four bytes say `PK\x03\x04` and nothing more; a rule that demanded
 * the bytes to be "a docx" would refuse every legitimate one and pass any ZIP renamed
 * `.docx` just the same. So the ZIP family admits `application/zip` and the three OOXML
 * types, the signature proves the container, and what the container holds is **not
 * inspected here** — that is a scanner's job (slice B) and an archive bomb's home
 * (SEC-06), and `detected_mime_type` must never be read as "the contents were looked at".
 * For that family the recorded detected type is the declared member the signature admits,
 * because the sniff cannot tell the members apart; for every other family it is the
 * family's one canonical type (`image/jpg` is recorded as `image/jpeg`).
 *
 * ## The signature sits at offset zero, and active content is refused first
 *
 * A polyglot is a file whose real header sits somewhere a lenient sniff would still find it
 * — a GIF at byte 0 with `%PDF-` at byte 600. Every signature here is matched at offset 0
 * exactly, so an object has at most one family. And before any family is consulted, the
 * head is checked for **markup**: a first non-blank byte of `<` is refused as
 * `type_not_allowed` whatever was declared, and for the text family — the only one with no
 * signature of its own to contradict a label — `<?xml`, `<svg`, `<html`, `<!doctype` or
 * `<script` anywhere in the window is refused too. (The deeper scan is not applied to a
 * binary family on purpose: a PDF's XMP packet or a compressed stream may legitimately
 * contain those bytes, and its offset-zero signature is what proves it is not markup.) The
 * order matters: an SVG declared as `image/png` is refused for what it *is* (active content
 * reached quarantine — SEC-06), not for a disagreement with its label, and the audit row
 * says so.
 *
 * ## R4: the proofing families, and the one markup exception
 *
 * The proofing viewer (R4, `D:/TManage/work/r4-viewer/SPEC.md` §2) widened the list with
 * SVG, HEIC/HEIF, TIFF, PSD/PSB, Illustrator (PDF-compatible), EPS, MP4/MOV, M4A, MP3, WAV,
 * OGG and FLAC. Every one keeps the offset-zero rule. The ISO media files (MP4, MOV, M4A,
 * HEIC) all carry `ftyp` at byte 4, so they are told apart by the **major brand** at bytes
 * 8–11, and the brand lists below do not overlap: an object still has at most one family.
 * MP4, MOV and M4A share one container family (like the ZIP family, the sniff proves the
 * container and the declared member stands); HEIC/HEIF is its own family.
 *
 * SVG is the one family that **is** markup. Its admission is the only relaxation of the
 * markup refusal, and it is narrow: only a declared `image/svg+xml` skips that refusal, the
 * whole object must still pass the textual rule, the head must open as an SVG document
 * (`<svg`, or an XML declaration / comment / SVG doctype followed by `<svg` in the window),
 * and a head that names `<html` or an HTML doctype is refused all the same. An SVG declared
 * as anything else is still refused as `type_not_allowed`. Admission does **not** make the
 * file safe to show: the original is only ever downloaded as an attachment, and the viewer
 * shows a sanitised derivative (R4 slice 3) under a sandbox CSP (slice 4).
 *
 * ## Textual is a whole-object property
 *
 * `text/plain`, `text/csv` and `text/markdown` have no signature. They are admitted when
 * the **whole object** is valid UTF-8 (a BOM allowed) with no NUL byte, and the head is not
 * markup. The check is incremental — a `TextDecoder` in fatal mode carries at most three
 * bytes of an unfinished sequence between chunks — so it costs no memory beyond the chunk.
 *
 * ## Bounds
 *
 * {@link SIGNATURE_WINDOW_BYTES} is the most the judge ever retains of an object: the first
 * 8 KiB, enough for every signature above plus a BOM and the RIFF/WEBP check at bytes 8–11.
 * Everything else streams through the digest and the textual check and is dropped.
 */

/** The bytes retained for the signature and markup checks. Never grown. */
export const SIGNATURE_WINDOW_BYTES = 8_192;

/** Why a pass refused an object. Recorded on `file_assets.rejection_code` and in the audit row. */
export type RejectionCode = 'hash_mismatch' | 'type_not_allowed' | 'type_mismatch';

/**
 * The token the audit row carries for a detected type. `VALUE_PATTERN` admits no `/`, and
 * an OOXML type is longer than the 64-character cap, so the family name stands in.
 */
export type DetectedTypeToken =
  | 'pdf'
  | 'ai'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'heic'
  | 'heif'
  | 'tiff'
  | 'psd'
  | 'eps'
  | 'mp4'
  | 'mov'
  | 'm4a'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'zip'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text_plain'
  | 'text_csv'
  | 'text_markdown';

const OOXML = 'application/vnd.openxmlformats-officedocument';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * The type recorded on `detected_mime_type` for each token: one canonical spelling, so an
 * alias (`image/jpg`, `audio/x-wav`, `audio/x-m4a`) is recorded as the type it stands for.
 * Illustrator files are recorded as `application/pdf` — the bytes *are* a PDF, and the
 * original name keeps the `.ai` (R4 SPEC §2).
 */
export const MIME_BY_TOKEN: Readonly<Record<DetectedTypeToken, string>> = {
  pdf: 'application/pdf',
  ai: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  psd: 'image/vnd.adobe.photoshop',
  eps: 'application/postscript',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  zip: 'application/zip',
  docx: `${OOXML}.wordprocessingml.document`,
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  pptx: `${OOXML}.presentationml.presentation`,
  text_plain: 'text/plain',
  text_csv: 'text/csv',
  text_markdown: 'text/markdown',
};

interface Family {
  /** The declared types this family admits, normalised (lowercase, no parameters). */
  readonly members: Readonly<Record<string, DetectedTypeToken>>;
  /** Whether the head carries this family's signature at offset zero. */
  readonly matches: (head: Buffer) => boolean;
  /** `true` when the whole-object UTF-8 rule applies (the text family, and SVG). */
  readonly textual?: boolean;
  /**
   * `true` for SVG only: the family is markup, so the markup refusal is not applied to a
   * type declared as one of its members. Its own `matches` is the narrower check.
   */
  readonly markup?: boolean;
}

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0): boolean =>
  head.length >= offset + bytes.length &&
  bytes.every((byte, index) => head[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

/**
 * The ISO base media file header: a box of at least 16 bytes whose type, at bytes 4–7, is
 * `ftyp`, and whose major brand (bytes 8–11) is one of `brands`. The brand is what tells an
 * MP4 from a HEIC photo; the compatible-brand list after it is not read, on purpose — the
 * major brand is the one claim at a fixed offset.
 */
function isoMajorBrand(head: Buffer, brands: ReadonlySet<string>): boolean {
  if (head.length < 16 || !startsWith(head, ascii('ftyp'), 4)) return false;
  if (head.readUInt32BE(0) < 16) return false;
  return brands.has(head.toString('latin1', 8, 12));
}

/** HEIF still images (HEVC-coded or generic HEIF). Disjoint from {@link MEDIA_BRANDS}. */
export const HEIF_BRANDS: ReadonlySet<string> = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

/** MP4 video, QuickTime MOV and M4A/M4B audio. Disjoint from {@link HEIF_BRANDS}. */
export const MEDIA_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'qt  ',
  'M4V ',
  'M4A ',
  'M4B ',
  'f4v ',
]);

/**
 * An MPEG audio frame header (MP3 without an ID3 tag): eleven set sync bits, a version that
 * is not the reserved `01`, and a layer that is not the reserved `00` — which also keeps an
 * AAC ADTS stream (layer `00`) out of the MP3 family. A JPEG's `FF D8` fails the sync bits.
 */
function isMpegAudioFrame(head: Buffer): boolean {
  if (head.length < 2 || head[0] !== 0xff) return false;
  const second = head[1] as number;
  if ((second & 0xe0) !== 0xe0) return false;
  const version = (second >> 3) & 0b11;
  const layer = (second >> 1) & 0b11;
  return version !== 0b01 && layer !== 0b00;
}

/** The first non-blank offset of a head, past a UTF-8 BOM and ASCII whitespace. */
function contentStart(head: Buffer): number {
  let start = startsWith(head, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (start < head.length) {
    const byte = head[start] as number;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c) {
      start += 1;
    } else {
      break;
    }
  }
  return start;
}

/** Whether a head names an HTML document anywhere in the window. */
function namesHtml(head: Buffer): boolean {
  const text = head.toString('latin1').toLowerCase();
  return text.includes('<html') || text.includes('<!doctype html');
}

/**
 * Whether a head opens as an SVG document. The first markup must be the `<svg` root, or one
 * of the prologue forms an SVG editor writes before it (an XML declaration, a comment, an
 * SVG doctype) with an `<svg` element later in the window. A head that names `<html` or an
 * HTML doctype anywhere is never an SVG here: that is a web page with an SVG label.
 */
function opensAsSvg(head: Buffer): boolean {
  if (namesHtml(head)) return false;
  const text = head.toString('latin1', contentStart(head)).toLowerCase();
  const root = /<svg[\s>/]/;
  if (text.startsWith('<svg')) return /^<svg[\s>/]/.test(text);
  const prologue =
    text.startsWith('<?xml') || text.startsWith('<!--') || text.startsWith('<!doctype svg');
  return prologue && root.test(text);
}

/**
 * Decision F5, widened by R4: the allowlist. HTML stays absent on purpose — it is active
 * content in a browser (`27` SEC-06) and is refused whatever it was declared as. SVG is
 * admitted only as itself (see the header). Widening is one edit here.
 */
export const FAMILIES: readonly Family[] = [
  {
    // An Illustrator file saved PDF-compatible is a PDF; one saved without it is PostScript
    // and is refused as a mismatch (rare, and it could not be shown anyway — SPEC §6.3).
    members: {
      'application/pdf': 'pdf',
      'application/illustrator': 'ai',
      'application/vnd.adobe.illustrator': 'ai',
    },
    matches: (head) => startsWith(head, ascii('%PDF-')),
  },
  {
    members: { 'image/png': 'png' },
    matches: (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    members: { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg' },
    matches: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  },
  {
    members: { 'image/gif': 'gif' },
    matches: (head) => startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a')),
  },
  {
    members: { 'image/webp': 'webp' },
    matches: (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  },
  {
    members: { 'image/svg+xml': 'svg' },
    matches: opensAsSvg,
    textual: true,
    markup: true,
  },
  {
    members: { 'image/heic': 'heic', 'image/heif': 'heif' },
    matches: (head) => isoMajorBrand(head, HEIF_BRANDS),
  },
  {
    members: { 'image/tiff': 'tiff', 'image/tif': 'tiff' },
    // Classic TIFF only, little- or big-endian. BigTIFF (`II+\0`) is not admitted.
    matches: (head) =>
      startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    members: {
      'image/vnd.adobe.photoshop': 'psd',
      'image/x-photoshop': 'psd',
      'application/x-photoshop': 'psd',
      'application/photoshop': 'psd',
    },
    // `8BPS`, then version 1 (PSD) or 2 (PSB, the large-document format).
    matches: (head) =>
      startsWith(head, ascii('8BPS')) &&
      (startsWith(head, [0x00, 0x01], 4) || startsWith(head, [0x00, 0x02], 4)),
  },
  {
    members: {
      'application/postscript': 'eps',
      'application/eps': 'eps',
      'application/x-eps': 'eps',
      'image/eps': 'eps',
      'image/x-eps': 'eps',
    },
    // A PostScript header, or the DOS-EPS binary header that wraps one with a preview.
    matches: (head) =>
      startsWith(head, ascii('%!PS-Adobe')) || startsWith(head, [0xc5, 0xd0, 0xd3, 0xc6]),
  },
  {
    members: {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/m4a': 'm4a',
    },
    // The container signature cannot tell video from audio; the declared member stands.
    matches: (head) => isoMajorBrand(head, MEDIA_BRANDS),
  },
  {
    members: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' },
    matches: (head) => startsWith(head, ascii('ID3')) || isMpegAudioFrame(head),
  },
  {
    members: {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/vnd.wave': 'wav',
    },
    matches: (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WAVE'), 8),
  },
  {
    members: { 'audio/ogg': 'ogg' },
    matches: (head) => startsWith(head, ascii('OggS')),
  },
  {
    members: { 'audio/flac': 'flac', 'audio/x-flac': 'flac' },
    matches: (head) => startsWith(head, ascii('fLaC')),
  },
  {
    members: {
      'application/zip': 'zip',
      [`${OOXML}.wordprocessingml.document`]: 'docx',
      [`${OOXML}.spreadsheetml.sheet`]: 'xlsx',
      [`${OOXML}.presentationml.presentation`]: 'pptx',
    },
    // The container signature cannot tell the members apart; the declared member stands.
    // `PK\x03\x04` only. An empty archive (`PK\x05\x06`) holds nothing worth storing and a
    // spanned one (`PK\x07\x08`) is not a document; both are refused as a mismatch.
    matches: (head) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]),
  },
  {
    members: {
      'text/plain': 'text_plain',
      'text/csv': 'text_csv',
      'text/markdown': 'text_markdown',
    },
    matches: () => true,
    textual: true,
  },
];

/** `APPLICATION/PDF; charset=utf-8` → `application/pdf`. What every comparison sees. */
export function normalizeMediaType(declared: string): string {
  const semicolon = declared.indexOf(';');
  return (semicolon === -1 ? declared : declared.slice(0, semicolon)).trim().toLowerCase();
}

function familyFor(normalized: string): Family | null {
  return FAMILIES.find((family) => Object.hasOwn(family.members, normalized)) ?? null;
}

/** `true` when the declared type is in the allowlist at all. Decidable before any byte. */
export function isAllowedMediaType(declared: string): boolean {
  return familyFor(normalizeMediaType(declared)) !== null;
}

const MARKUP_MARKERS = ['<?xml', '<svg', '<html', '<!doctype', '<script'] as const;

/**
 * Whether the head reads as markup — the SEC-06 refusal, made before any family is asked.
 * A leading BOM and ASCII whitespace are skipped; then the first byte being `<` is markup,
 * and with `deep` — the text family — so is any of the markers (case-insensitively)
 * anywhere in the window.
 */
export function looksLikeMarkup(head: Buffer, deep: boolean): boolean {
  const start = contentStart(head);
  if (start < head.length && head[start] === 0x3c) return true;
  if (!deep) return false;
  const text = head.toString('latin1').toLowerCase();
  return MARKUP_MARKERS.some((marker) => text.includes(marker));
}

/**
 * The incremental half of the textual rule: every chunk of the object passes through here,
 * and `ok()` is asked once at the end. UTF-8 validity is checked by a fatal decoder in
 * streaming mode, which keeps at most three bytes of an unfinished sequence between calls
 * and throws on the first sequence that cannot be completed; the decoded text is dropped.
 */
export class TextualCheck {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private valid = true;
  private nul = false;

  update(chunk: Buffer): void {
    if (!this.valid) return;
    if (!this.nul && chunk.includes(0x00)) this.nul = true;
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.valid = false;
    }
  }

  /** `true` when every chunk so far was valid UTF-8 with no NUL and nothing is left unfinished. */
  ok(): boolean {
    if (!this.valid || this.nul) return false;
    try {
      this.decoder.decode(new Uint8Array(0));
      return true;
    } catch {
      return false;
    }
  }
}

export interface Judgement {
  readonly ok: true;
  readonly detectedMimeType: string;
  readonly detectedType: DetectedTypeToken;
}

export interface Refusal {
  readonly ok: false;
  readonly rejectionCode: Exclude<RejectionCode, 'hash_mismatch'>;
}

/**
 * Judge an object's type from what was declared, its first bytes, and — for the text family
 * — the whole-object check. The order is the one the header argues for: markup first, then
 * the allowlist, then the family's own signature.
 */
export function judgeContentType(
  declared: string,
  head: Buffer,
  textual: TextualCheck,
): Judgement | Refusal {
  const normalized = normalizeMediaType(declared);
  const family = familyFor(normalized);
  // SVG declared as SVG is the one markup family; its own `matches` is the narrower check.
  if (family?.markup !== true && looksLikeMarkup(head, family?.textual === true)) {
    return { ok: false, rejectionCode: 'type_not_allowed' };
  }
  if (!family) return { ok: false, rejectionCode: 'type_not_allowed' };
  // A zero-byte object is nothing: no signature, and no text to admit.
  if (head.length === 0) return { ok: false, rejectionCode: 'type_mismatch' };
  // An HTML page under an SVG label is refused for what it is, like any other markup.
  if (family.markup === true && namesHtml(head)) {
    return { ok: false, rejectionCode: 'type_not_allowed' };
  }
  const consistent = (family.textual !== true || textual.ok()) && family.matches(head);
  if (!consistent) return { ok: false, rejectionCode: 'type_mismatch' };
  const detectedType = family.members[normalized] as DetectedTypeToken;
  return { ok: true, detectedMimeType: MIME_BY_TOKEN[detectedType], detectedType };
}
