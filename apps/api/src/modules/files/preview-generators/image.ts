import { imageSize } from 'image-size';
import { gifCodec, jpegCodec, pngCodec } from './codecs.js';
import type { RgbaImage } from './codecs.js';
import { decodeWebp, rasterOutcomes } from './raster.js';
import type { DecodedPage } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewLimits, PreviewSource } from './types.js';

/**
 * R4 slice 3 — JPEG, PNG, WebP and GIF: a `preview` (long side ≤ 2048) and a `thumb` (320), WebP.
 *
 * The size is read from the header first (`image-size`), so an 80-megapixel-plus image is refused
 * before a byte of it is decoded (`unsupported_too_large`; the browser still shows the original).
 * A JPEG's EXIF orientation comes from the same header read and is applied to the derivatives.
 * A GIF gets a thumbnail of its first frame only: the viewer plays the original, so the animation
 * is kept (SPEC R4 §2).
 */

const JPEG = 'image/jpeg';
const PNG = 'image/png';
const WEBP = 'image/webp';
const GIF = 'image/gif';

function header(bytes: Uint8Array): { width: number; height: number; orientation?: number } | null {
  try {
    const size = imageSize(bytes);
    if (!size.width || !size.height) return null;
    return {
      width: size.width,
      height: size.height,
      ...(size.orientation ? { orientation: size.orientation } : {}),
    };
  } catch {
    return null;
  }
}

function decodeGif(bytes: Uint8Array): RgbaImage {
  const reader = new (gifCodec().GifReader)(bytes);
  const pixels = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, pixels);
  return { width: reader.width, height: reader.height, data: pixels };
}

async function decode(source: PreviewSource, limits: PreviewLimits): Promise<RgbaImage> {
  const { bytes, mimeType } = source;
  if (mimeType === JPEG) {
    return jpegCodec().decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: Math.ceil(limits.maxPixels / 1_000_000),
      maxMemoryUsageInMB: 1024,
    });
  }
  if (mimeType === PNG) return pngCodec().PNG.sync.read(Buffer.from(bytes));
  if (mimeType === WEBP) return decodeWebp(bytes);
  return decodeGif(bytes);
}

export const imageGenerator: PreviewGenerator = {
  name: 'image',
  mimeTypes: [JPEG, PNG, WEBP, GIF],
  plan(mimeType) {
    return mimeType === GIF ? [{ kind: 'thumb' }] : [{ kind: 'preview' }, { kind: 'thumb' }];
  },
  async generate(source, requests, limits) {
    const size = header(source.bytes);
    const decodePage = async (pageNo: number): Promise<DecodedPage> => {
      if (pageNo !== 1) return unsupported('no_such_page');
      if (!size) return failed('decode_failed');
      if (size.width * size.height > limits.maxPixels) return unsupported('unsupported_too_large');
      let image: RgbaImage;
      try {
        image = await decode(source, limits);
      } catch {
        return failed('decode_failed');
      }
      return {
        status: 'decoded',
        image,
        ...(source.mimeType === JPEG && size.orientation ? { orientation: size.orientation } : {}),
      };
    };
    return rasterOutcomes(requests, decodePage);
  },
};
