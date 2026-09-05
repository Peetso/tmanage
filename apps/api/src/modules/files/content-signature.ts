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
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'zip'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text_plain'
  | 'text_csv'
  | 'text_markdown';

interface Family {
  /** The declared types this family admits, normalised (lowercase, no parameters). */
  readonly members: Readonly<Record<string, DetectedTypeToken>>;
  /** The type recorded for a member the signature admits; `null` means "the declared member". */
  readonly canonical: string | null;
  /** Whether the head carries this family's signature at offset zero. */
  readonly matches: (head: Buffer) => boolean;
  /** `true` for the text family: the whole-object UTF-8 rule replaces a signature. */
  readonly textual?: boolean;
}

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0): boolean =>
  head.length >= offset + bytes.length &&
  bytes.every((byte, index) => head[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

const OOXML = 'application/vnd.openxmlformats-officedocument';

/**
 * Decision F5: the allowlist. Seven families, SVG and HTML absent on purpose — both are
 * active content in a browser (`27` SEC-06), and a file that is one is refused whatever it
 * was declared as. Widening is one edit here.
 */
export const FAMILIES: readonly Family[] = [
  {
    members: { 'application/pdf': 'pdf' },
    canonical: 'application/pdf',
    matches: (head) => startsWith(head, ascii('%PDF-')),
  },
  {
    members: { 'image/png': 'png' },
    canonical: 'image/png',
    matches: (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    members: { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg' },
    canonical: 'image/jpeg',
    matches: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  },
  {
    members: { 'image/gif': 'gif' },
    canonical: 'image/gif',
    matches: (head) => startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a')),
  },
  {
    members: { 'image/webp': 'webp' },
    canonical: 'image/webp',
    matches: (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  },
  {
    members: {
      'application/zip': 'zip',
      [`${OOXML}.wordprocessingml.document`]: 'docx',
      [`${OOXML}.spreadsheetml.sheet`]: 'xlsx',
      [`${OOXML}.presentationml.presentation`]: 'pptx',
    },
    // The container signature cannot tell the members apart; the declared member stands.
    canonical: null,
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
    canonical: null,
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

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const MARKUP_MARKERS = ['<?xml', '<svg', '<html', '<!doctype', '<script'] as const;

/**
 * Whether the head reads as markup — the SEC-06 refusal, made before any family is asked.
 * A leading BOM and ASCII whitespace are skipped; then the first byte being `<` is markup,
 * and with `deep` — the text family — so is any of the markers (case-insensitively)
 * anywhere in the window.
 */
export function looksLikeMarkup(head: Buffer, deep: boolean): boolean {
  let start = startsWith(head, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (start < head.length) {
    const byte = head[start] as number;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c) {
      start += 1;
    } else {
      break;
    }
  }
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
  if (looksLikeMarkup(head, family?.textual === true)) {
    return { ok: false, rejectionCode: 'type_not_allowed' };
  }
  if (!family) return { ok: false, rejectionCode: 'type_not_allowed' };
  // A zero-byte object is nothing: no signature, and no text to admit.
  if (head.length === 0) return { ok: false, rejectionCode: 'type_mismatch' };
  const consistent = family.textual ? textual.ok() : family.matches(head);
  if (!consistent) return { ok: false, rejectionCode: 'type_mismatch' };
  return {
    ok: true,
    detectedMimeType: family.canonical ?? normalized,
    detectedType: family.members[normalized] as DetectedTypeToken,
  };
}
