/**
 * Peter, 2026-11-09 (viewer item 8) — the preview picture a CAD file saves inside itself.
 *
 * AutoCAD (2013 and later), SketchUp and Revit store a small PNG thumbnail in the file. The
 * browser cannot draw the model, but it can show that picture: this finds the first whole PNG
 * (signature, chunks, `IEND`) in the first bytes of the file and returns exactly those bytes. A PNG
 * that is cut off, or chunks that run past the end, are not a picture: `null`.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** How much of the original the viewer reads looking for the thumbnail. */
export const THUMBNAIL_SCAN_BYTES = 8 * 1024 * 1024;

/** The smallest picture worth showing (a 1×1 placeholder is not a preview). */
const MIN_PNG_BYTES = 200;

function matchesAt(bytes: Uint8Array, offset: number): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[offset + index] === byte);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) +
      ((bytes[offset + 1] as number) << 16) +
      ((bytes[offset + 2] as number) << 8) +
      (bytes[offset + 3] as number)) >>>
    0
  );
}

/** The end (exclusive) of a whole PNG starting at `start`, or `null`. */
function pngEnd(bytes: Uint8Array, start: number): number | null {
  let offset = start + PNG_SIGNATURE.length;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    if (first && type !== 'IHDR') return null;
    if (!/^[A-Za-z]{4}$/u.test(type)) return null;
    first = false;
    const next = offset + 12 + length;
    if (next > bytes.length) return null;
    if (type === 'IEND') return next;
    offset = next;
  }
  return null;
}

/** The first whole embedded PNG in `bytes`, or `null`. */
export function findEmbeddedPng(bytes: Uint8Array): Uint8Array | null {
  for (let index = 0; index + PNG_SIGNATURE.length <= bytes.length; index += 1) {
    if (bytes[index] !== 0x89 || !matchesAt(bytes, index)) continue;
    const end = pngEnd(bytes, index);
    if (end !== null && end - index >= MIN_PNG_BYTES) return bytes.subarray(index, end);
  }
  return null;
}

/**
 * Reads at most `limit` bytes of `src` (the session cookie goes along) and stops the download
 * there: a 200 MB model is not fetched whole to find a picture in its first megabytes.
 */
export async function fetchHead(src: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`original ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  if (total >= limit) void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}
