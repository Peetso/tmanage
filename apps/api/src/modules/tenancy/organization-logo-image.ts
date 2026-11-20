import { createHash } from 'node:crypto';
import { judgeContentType, normalizeMediaType, TextualCheck } from '../files/content-signature.js';
import { sanitizeSvg } from './svg-sanitizer.js';
import type { SvgRefusal } from './svg-sanitizer.js';

/**
 * C6 — what the company-logo route accepts, decided from the bytes.
 *
 * PNG, JPEG and WebP are admitted when the bytes carry their own signature at offset zero (the
 * file pipeline's judge, `content-signature.ts`, so a polyglot or a markup file labelled as an
 * image is refused here exactly as it is there). SVG is admitted only through
 * {@link sanitizeSvg}: the stored bytes are the sanitiser's rebuilt document, never the input.
 */

/** The largest logo the route takes, before base64. A logo has no reason to be bigger. */
export const LOGO_MAX_BYTES = 512 * 1024;

export const LOGO_RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_SVG_TYPE = 'image/svg+xml';

export type LogoMimeType = (typeof LOGO_RASTER_TYPES)[number] | typeof LOGO_SVG_TYPE;

/**
 * QA-FIX-R L1 — the card says "at least 256 px", and a 120×40 PNG was taken. A raster logo's
 * longer side must reach this; a wordmark is wide and short, so the shorter side is not held to
 * it. SVG scales, so it has no pixel size to check. A raster whose header cannot be read is
 * judged by the type check alone (the size rule keeps a logo sharp; it is not a safety rule).
 */
export const LOGO_MIN_PX = 256;

export interface AcceptedLogo {
  readonly ok: true;
  readonly mimeType: LogoMimeType;
  readonly bytes: Buffer;
  readonly sha256: string;
  /** What the SVG sanitiser stripped; empty for a raster image or a clean SVG. */
  readonly removed: readonly string[];
}

export type LogoRefusalCode =
  'too_large' | 'too_small' | 'empty' | 'type_not_allowed' | 'type_mismatch' | `svg_${SvgRefusal}`;

export interface RefusedLogo {
  readonly ok: false;
  readonly code: LogoRefusalCode;
  /** The sentence the card shows. Plain words; no developer text. */
  readonly message: string;
}

const MESSAGES: Readonly<Record<LogoRefusalCode, string>> = {
  too_large: 'The logo is larger than 512 KB. Save a smaller file and try again.',
  too_small:
    'The logo is too small to stay sharp. Use an image at least 256 px wide or tall, or an SVG.',
  empty: 'That file is empty. Choose a PNG, JPEG, WebP or SVG logo.',
  type_not_allowed: 'Choose a PNG, JPEG, WebP or SVG file.',
  type_mismatch: 'That file is not the image type its name says. Save it again and try again.',
  svg_unreadable: 'This SVG could not be read. Save it again as plain SVG, or upload a PNG.',
  svg_not_svg: 'That file is not an SVG image. Choose a PNG, JPEG, WebP or SVG file.',
  svg_entity_definitions:
    'This SVG defines its own entities, which cannot be made safe. Save it again as plain SVG, or upload a PNG.',
  svg_unknown_entity:
    'This SVG uses entities that cannot be made safe. Save it again as plain SVG, or upload a PNG.',
  svg_too_deep: 'This SVG is nested too deeply to check. Simplify it, or upload a PNG.',
  svg_too_complex: 'This SVG has too many parts to check. Simplify it, or upload a PNG.',
  svg_empty:
    'Nothing would be left of this SVG once its scripts and external links are removed. Upload a PNG instead.',
};

function refuse(code: LogoRefusalCode): RefusedLogo {
  return { ok: false, code, message: MESSAGES[code] };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Judge (and, for SVG, sanitise) a candidate logo. `declared` is the browser's label. */
export function acceptLogo(declared: string, bytes: Buffer): AcceptedLogo | RefusedLogo {
  if (bytes.length === 0) return refuse('empty');
  if (bytes.length > LOGO_MAX_BYTES) return refuse('too_large');
  const normalized = normalizeMediaType(declared);

  if (normalized === LOGO_SVG_TYPE) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes('�') || text.includes('\u0000')) return refuse('svg_unreadable');
    const result = sanitizeSvg(text);
    if (!result.ok) return refuse(`svg_${result.reason}`);
    const clean = Buffer.from(result.svg, 'utf8');
    if (clean.length > LOGO_MAX_BYTES) return refuse('too_large');
    return {
      ok: true,
      mimeType: LOGO_SVG_TYPE,
      bytes: clean,
      sha256: digest(clean),
      removed: result.removed,
    };
  }

  if (
    !(LOGO_RASTER_TYPES as readonly string[]).includes(
      normalized === 'image/jpg' ? 'image/jpeg' : normalized,
    )
  ) {
    return refuse('type_not_allowed');
  }
  const textual = new TextualCheck();
  const judgement = judgeContentType(normalized, bytes.subarray(0, 8_192), textual);
  if (!judgement.ok) return refuse(judgement.rejectionCode);
  const size = rasterSize(judgement.detectedMimeType, bytes);
  if (size !== null && Math.max(size.width, size.height) < LOGO_MIN_PX) return refuse('too_small');
  return {
    ok: true,
    mimeType: judgement.detectedMimeType as LogoMimeType,
    bytes,
    sha256: digest(bytes),
    removed: [],
  };
}

/**
 * Decode the body's base64. Strict: only the base64 alphabet (whitespace ignored), so a value
 * that is not base64 is a 400 rather than whatever `Buffer.from` makes of it.
 */
export function decodeLogoBase64(raw: string): Buffer | null {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

/**
 * The pixel size a PNG, JPEG or WebP header declares, or null when it cannot be read. Only the
 * header is parsed; nothing is decoded. Layouts: PNG IHDR (W3C PNG spec), JPEG SOFn frame
 * header (ITU-T T.81 Annex B), WebP `VP8 `/`VP8L`/`VP8X` headers (RFC 9649).
 */
export function rasterSize(
  mimeType: string,
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') return jpegSize(bytes);
  if (mimeType === 'image/webp') return webpSize(bytes);
  return null;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers carry no length: TEM, RST0-7, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = bytes.readUInt16BE(i + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}
