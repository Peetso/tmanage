import { webpCodec } from './codecs.js';
import type { RgbaImage } from './codecs.js';
import { PREVIEW_LONG_SIDE, THUMB_LONG_SIDE } from './types.js';
import type { PreviewOutcome, PreviewRequest } from './types.js';

/**
 * R4 slice 3 — the raster half every image generator shares: scale down, turn upright, encode.
 *
 * - **Scaling** is an area average (every source pixel contributes exactly its share), done row
 *   by row so the working memory is two output rows, never a second full-size image. Colour is
 *   averaged premultiplied by alpha, so a transparent edge does not bleed black. Nothing is ever
 *   scaled up: a small image keeps its size.
 * - **Orientation** (EXIF 1–8) is applied after scaling, on the small image, so a phone photo's
 *   preview stands the way the phone showed it — the pins a reviewer drops are on that picture.
 * - **Encoding** is WebP (libwebp in WebAssembly): one format for photos and transparency alike.
 */

export const WEBP_MIME = 'image/webp';

export function longSideFor(kind: PreviewRequest['kind']): number | null {
  if (kind === 'preview') return PREVIEW_LONG_SIDE;
  if (kind === 'thumb' || kind === 'page_thumb') return THUMB_LONG_SIDE;
  return null;
}

/** The size an image of `width × height` has once its long side is at most `longSide`. */
export function fitWithin(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= longSide) return { width, height };
  const scale = long / longSide;
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  };
}

/** Area-average downscale to `targetWidth × targetHeight` (each no larger than the source's). */
export function resizeRgba(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): RgbaImage {
  const { width: sw, height: sh, data: src } = source;
  const dw = Math.min(Math.max(1, Math.round(targetWidth)), sw);
  const dh = Math.min(Math.max(1, Math.round(targetHeight)), sh);
  if (dw === sw && dh === sh) return source;

  const sx = sw / dw;
  const sy = sh / dh;
  // For each source column: the output column it starts in and the share of it that falls there.
  const firstColumn = new Int32Array(sw);
  const firstShare = new Float64Array(sw);
  for (let x = 0; x < sw; x += 1) {
    const d = Math.min(Math.floor(x / sx), dw - 1);
    const boundary = (d + 1) * sx;
    firstColumn[x] = d;
    firstShare[x] = x + 1 <= boundary || d === dw - 1 ? 1 : boundary - x;
  }

  const out = new Uint8ClampedArray(dw * dh * 4);
  const row = new Float64Array(dw * 4);
  let current = new Float64Array(dw * 4);
  let next = new Float64Array(dw * 4);
  let currentRow = 0;
  const area = sx * sy;

  const flush = (target: number, acc: Float64Array): void => {
    const base = target * dw * 4;
    for (let d = 0; d < dw; d += 1) {
      const i = d * 4;
      const alpha = acc[i + 3]!;
      if (alpha <= 0) {
        out[base + i + 3] = 0;
        continue;
      }
      out[base + i] = acc[i]! / alpha;
      out[base + i + 1] = acc[i + 1]! / alpha;
      out[base + i + 2] = acc[i + 2]! / alpha;
      out[base + i + 3] = alpha / area;
    }
  };

  for (let y = 0; y < sh; y += 1) {
    row.fill(0);
    const offset = y * sw * 4;
    for (let x = 0; x < sw; x += 1) {
      const p = offset + x * 4;
      const a = src[p + 3]!;
      if (a === 0) continue;
      const r = src[p]! * a;
      const g = src[p + 1]! * a;
      const b = src[p + 2]! * a;
      const d = firstColumn[x]!;
      const share = firstShare[x]!;
      const i = d * 4;
      row[i] = row[i]! + r * share;
      row[i + 1] = row[i + 1]! + g * share;
      row[i + 2] = row[i + 2]! + b * share;
      row[i + 3] = row[i + 3]! + a * share;
      if (share < 1) {
        const rest = 1 - share;
        const j = i + 4;
        row[j] = row[j]! + r * rest;
        row[j + 1] = row[j + 1]! + g * rest;
        row[j + 2] = row[j + 2]! + b * rest;
        row[j + 3] = row[j + 3]! + a * rest;
      }
    }

    const target = Math.min(Math.floor(y / sy), dh - 1);
    const boundary = (target + 1) * sy;
    const share = y + 1 <= boundary || target === dh - 1 ? 1 : boundary - y;
    while (currentRow < target) {
      flush(currentRow, current);
      [current, next] = [next, current];
      next.fill(0);
      currentRow += 1;
    }
    for (let i = 0; i < row.length; i += 1) {
      const value = row[i]!;
      if (value === 0) continue;
      current[i] = current[i]! + value * share;
      if (share < 1) next[i] = next[i]! + value * (1 - share);
    }
  }
  while (currentRow < dh) {
    flush(currentRow, current);
    [current, next] = [next, current];
    next.fill(0);
    currentRow += 1;
  }
  return { width: dw, height: dh, data: out };
}

/** EXIF orientations 5–8 swap the sides. */
export function swapsSides(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/** Turn an image upright per its EXIF orientation (1 or unknown: as is). */
export function orientRgba(image: RgbaImage, orientation: number | undefined): RgbaImage {
  if (orientation === undefined || orientation < 2 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = swapsSides(orientation);
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let tx: number;
      let ty: number;
      switch (orientation) {
        case 2: tx = w - 1 - x; ty = y; break; // prettier-ignore
        case 3: tx = w - 1 - x; ty = h - 1 - y; break; // prettier-ignore
        case 4: tx = x; ty = h - 1 - y; break; // prettier-ignore
        case 5: tx = y; ty = x; break; // prettier-ignore
        case 6: tx = h - 1 - y; ty = x; break; // prettier-ignore
        case 7: tx = h - 1 - y; ty = w - 1 - x; break; // prettier-ignore
        default: tx = y; ty = w - 1 - x; break; // prettier-ignore
      }
      const s = (y * w + x) * 4;
      const t = (ty * ow + tx) * 4;
      out[t] = data[s]!;
      out[t + 1] = data[s + 1]!;
      out[t + 2] = data[s + 2]!;
      out[t + 3] = data[s + 3]!;
    }
  }
  return { width: ow, height: oh, data: out };
}

export async function encodeWebp(image: RgbaImage, quality: number): Promise<Uint8Array> {
  const { encode } = await webpCodec();
  const data =
    image.data instanceof Uint8ClampedArray
      ? image.data
      : new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const encoded = (await encode.default(
    { data, width: image.width, height: image.height, colorSpace: 'srgb' },
    { quality },
  )) as ArrayBuffer;
  return new Uint8Array(encoded);
}

export async function decodeWebp(bytes: Uint8Array): Promise<RgbaImage> {
  const { decode } = await webpCodec();
  const copy = bytes.slice().buffer;
  const image = (await decode.default(copy)) as RgbaImage;
  return image;
}

/** A decoded page, or the reason there is none. */
export type DecodedPage =
  | {
      readonly status: 'decoded';
      readonly image: RgbaImage;
      /** EXIF orientation still to apply (the image is as stored). */
      readonly orientation?: number;
      readonly meta?: Readonly<Record<string, unknown>>;
    }
  | Extract<PreviewOutcome, { status: 'unsupported' | 'failed' }>;

/**
 * Answer raster requests (`preview`, `thumb`, `page_thumb`) from one decoder. `thumb` (page 0) is
 * drawn from page 1; each page is decoded at most once per call; a kind no raster answers is
 * `unsupported`. `extra` adds what only the format knows (a TIFF's page count and follow-ups).
 */
export async function rasterOutcomes(
  requests: readonly PreviewRequest[],
  decodePage: (pageNo: number) => Promise<DecodedPage>,
  extra?: (
    request: PreviewRequest,
    page: Extract<DecodedPage, { status: 'decoded' }>,
  ) => Pick<Extract<PreviewOutcome, { status: 'ready' }>, 'followUps'> & {
    readonly meta?: Readonly<Record<string, unknown>>;
  },
): Promise<readonly PreviewOutcome[]> {
  const pages = new Map<number, DecodedPage>();
  const outcomes: PreviewOutcome[] = [];
  for (const request of requests) {
    const longSide = longSideFor(request.kind);
    if (longSide === null) {
      outcomes.push({ status: 'unsupported', code: 'kind_not_raster' });
      continue;
    }
    const pageNo = request.pageNo === 0 ? 1 : request.pageNo;
    let page = pages.get(pageNo);
    if (!page) {
      page = await decodePage(pageNo);
      pages.set(pageNo, page);
    }
    if (page.status !== 'decoded') {
      outcomes.push(page);
      continue;
    }
    const swap = swapsSides(page.orientation);
    const sourceWidth = swap ? page.image.height : page.image.width;
    const sourceHeight = swap ? page.image.width : page.image.height;
    const fitted = fitWithin(sourceWidth, sourceHeight, longSide);
    const scaled = resizeRgba(
      page.image,
      swap ? fitted.height : fitted.width,
      swap ? fitted.width : fitted.height,
    );
    const upright = orientRgba(scaled, page.orientation);
    const body = await encodeWebp(upright, request.kind === 'preview' ? 82 : 75);
    const more = extra?.(request, page);
    outcomes.push({
      status: 'ready',
      body,
      mimeType: WEBP_MIME,
      width: upright.width,
      height: upright.height,
      meta: { sourceWidth, sourceHeight, ...page.meta, ...more?.meta },
      ...(more?.followUps && more.followUps.length > 0 ? { followUps: more.followUps } : {}),
    });
  }
  return outcomes;
}
