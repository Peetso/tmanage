import { createHash } from 'node:crypto';
import { judgeContentType, normalizeMediaType, TextualCheck } from '../files/content-signature.js';
import type { RgbaImage } from '../files/preview-generators/codecs.js';
import { decodeRaster, readRasterHeader } from '../files/preview-generators/image.js';
import { encodeWebp, orientRgba, resizeRgba } from '../files/preview-generators/raster.js';

/**
 * Profile photo (owner, 2026-11-23) — what the photo routes accept, and what they store.
 *
 * Two pure steps, so the service can scan between them:
 *
 * 1. {@link judgePhoto} decides from the bytes: JPEG, PNG or WebP only, by the same signature judge
 *    every upload uses (`files/content-signature.ts`, so a polyglot or markup labelled as an image
 *    is refused here as it is there); the header's pixel size is read without decoding, so a
 *    decompression bomb (a small file that would decode to a huge picture) is refused unread.
 * 2. {@link renderPhoto} decodes to pixels with the file pipeline's own decoders
 *    (`files/preview-generators`), stands the picture upright (EXIF orientation), cuts the centre
 *    square and writes two NEW WebP images, 256 px and 64 px. Only pixels cross: EXIF, GPS, ICC,
 *    comments and anything appended after the image end are not in the output. This is the
 *    "image rewriting" defence of the OWASP File Upload Cheat Sheet, applied to everything stored.
 *
 * Sizes. A person may pick a file of up to {@link PHOTO_PICK_MAX_BYTES} (5 MB); the browser crops it
 * and sends the square, so what reaches the API is at most {@link PHOTO_UPLOAD_MAX_BYTES} (512 KiB,
 * the same ceiling as the AI's inline upload and the company logo, inside Fastify's 1 MiB body
 * limit, which stays as it is for every JSON route).
 */

/** The largest file the Profile page lets a person pick (the brief's 5 MB). Checked in the browser. */
export const PHOTO_PICK_MAX_BYTES = 5 * 1024 * 1024;
/** The largest upload the API reads, after the browser's crop. */
export const PHOTO_UPLOAD_MAX_BYTES = 512 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoMimeType = (typeof PHOTO_TYPES)[number];
/** The shorter side must reach this, or the 64 px avatar would be an upscale. */
export const PHOTO_MIN_PX = 64;
/** Above this many pixels nothing is decoded (a 512 KiB file has no honest reason to be bigger). */
export const PHOTO_MAX_PIXELS = 25_000_000;
/** The two squares stored. 256 for the profile and large avatars, 64 for every small one. */
export const PHOTO_SIZES = [256, 64] as const;
export type PhotoSize = (typeof PHOTO_SIZES)[number];
const WEBP_QUALITY = 82;

export type PhotoRefusalCode =
  | 'empty'
  | 'too_large'
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'too_small'
  | 'too_many_pixels'
  | 'unreadable';

/** The sentence the Profile page and the AI show. Plain words, no developer text. */
export const PHOTO_REFUSALS: Readonly<Record<PhotoRefusalCode, string>> = {
  empty: 'That file is empty. Choose a JPEG, PNG or WebP photo.',
  too_large: 'The photo is too large. Choose a smaller photo and try again.',
  type_not_allowed: 'Choose a JPEG, PNG or WebP photo.',
  type_mismatch: 'That file is not the image type its name says. Save it again and try again.',
  too_small: 'The photo is too small. Use a photo at least 64 px wide and tall.',
  too_many_pixels: 'The photo is too large to process. Choose a smaller photo and try again.',
  unreadable: 'This photo could not be read. Save it again as JPEG or PNG and try again.',
};

export interface PhotoRefusal {
  readonly ok: false;
  readonly code: PhotoRefusalCode;
  readonly message: string;
}

export interface JudgedPhoto {
  readonly ok: true;
  readonly mimeType: PhotoMimeType;
  readonly orientation: number | undefined;
}

export interface RenderedPhoto {
  readonly ok: true;
  /** WebP bytes per stored size. */
  readonly images: Readonly<Record<PhotoSize, Uint8Array>>;
  /** SHA-256 hex of the 256 px image: the photo's identity and its cache key. */
  readonly sha256: string;
}

function refuse(code: PhotoRefusalCode): PhotoRefusal {
  return { ok: false, code, message: PHOTO_REFUSALS[code] };
}

function isPhotoType(value: string): value is PhotoMimeType {
  return (PHOTO_TYPES as readonly string[]).includes(value);
}

/** Step 1: the type from the bytes and the size from the header. Decodes nothing. */
export function judgePhoto(declared: string, bytes: Uint8Array): JudgedPhoto | PhotoRefusal {
  if (bytes.length === 0) return refuse('empty');
  if (bytes.length > PHOTO_UPLOAD_MAX_BYTES) return refuse('too_large');
  const normalized = normalizeMediaType(declared);
  const label = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  if (!isPhotoType(label)) return refuse('type_not_allowed');
  const head = Buffer.from(bytes.subarray(0, 8_192));
  const judgement = judgeContentType(label, head, new TextualCheck());
  if (!judgement.ok) {
    return refuse(
      judgement.rejectionCode === 'type_mismatch' ? 'type_mismatch' : 'type_not_allowed',
    );
  }
  const detected = judgement.detectedMimeType;
  if (!isPhotoType(detected)) return refuse('type_not_allowed');
  const size = readRasterHeader(bytes);
  if (size === null) return refuse('unreadable');
  if (size.width * size.height > PHOTO_MAX_PIXELS) return refuse('too_many_pixels');
  if (Math.min(size.width, size.height) < PHOTO_MIN_PX) return refuse('too_small');
  return { ok: true, mimeType: detected, orientation: size.orientation };
}

/** The centred square of an image (the browser has usually cropped already; this makes it sure). */
export function cropToSquare(image: RgbaImage): RgbaImage {
  const side = Math.min(image.width, image.height);
  if (image.width === side && image.height === side) return image;
  const left = Math.floor((image.width - side) / 2);
  const top = Math.floor((image.height - side) / 2);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    out.set(image.data.subarray(from, from + side * 4), y * side * 4);
  }
  return { width: side, height: side, data: out };
}

/** Step 2: decode, stand upright, square, and write the two new WebP images. */
export async function renderPhoto(
  bytes: Uint8Array,
  judged: JudgedPhoto,
): Promise<RenderedPhoto | PhotoRefusal> {
  let pixels: RgbaImage;
  try {
    pixels = await decodeRaster(
      { bytes, mimeType: judged.mimeType },
      { maxPixels: PHOTO_MAX_PIXELS, maxPages: 1 },
    );
  } catch {
    return refuse('unreadable');
  }
  const square = cropToSquare(orientRgba(pixels, judged.orientation));
  const large = resizeRgba(square, 256, 256);
  const small = resizeRgba(square, 64, 64);
  const [image256, image64] = await Promise.all([
    encodeWebp(large, WEBP_QUALITY),
    encodeWebp(small, WEBP_QUALITY),
  ]);
  return {
    ok: true,
    images: { 256: image256, 64: image64 },
    sha256: createHash('sha256').update(image256).digest('hex'),
  };
}

/** The cache key a photo's URL carries: the first 16 hex characters of its digest. */
export function photoVersion(sha256: string): string {
  return sha256.slice(0, 16);
}
