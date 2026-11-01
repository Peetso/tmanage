import { heifCodec } from './codecs.js';
import type { HeifImage, RgbaImage } from './codecs.js';
import { rasterOutcomes } from './raster.js';
import type { DecodedPage } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator } from './types.js';

/**
 * R4 slice 3 — HEIC / HEIF (iPhone photos), through libheif compiled to WebAssembly
 * (`libheif-js`, LGPL-3.0: allowed by the licence gate). Browsers do not show HEIC, so the viewer
 * shows these derivatives only. The primary image is used; libheif applies the file's own
 * rotation and mirror, so no EXIF step follows. Decoding is slow (a few seconds for 12 MP), which
 * is why the job runs one file at a time.
 */

const HEIC = 'image/heic';
const HEIF = 'image/heif';

/** The decoder, swappable in tests (there is no HEIC encoder to make a fixture with). */
export type HeifDecode = (bytes: Uint8Array) => HeifImage[];

const libheifDecode: HeifDecode = (bytes) => new (heifCodec().HeifDecoder)().decode(bytes);

function pixelsOf(image: HeifImage, width: number, height: number): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
      if (!result) reject(new Error('heif display failed'));
      else resolve({ width: result.width, height: result.height, data: result.data });
    });
  });
}

export function createHeicGenerator(decodeHeif: HeifDecode = libheifDecode): PreviewGenerator {
  return {
    name: 'heic',
    mimeTypes: [HEIC, HEIF],
    plan() {
      return [{ kind: 'preview' }, { kind: 'thumb' }];
    },
    async generate(source, requests, limits) {
      let images: HeifImage[] = [];
      try {
        images = decodeHeif(source.bytes);
      } catch {
        images = [];
      }
      const decodePage = async (pageNo: number): Promise<DecodedPage> => {
        if (pageNo !== 1) return unsupported('no_such_page');
        const primary = images[0];
        if (!primary) return failed('decode_failed');
        const width = primary.get_width();
        const height = primary.get_height();
        if (!(width > 0 && height > 0)) return failed('decode_failed');
        if (width * height > limits.maxPixels) return unsupported('unsupported_too_large');
        try {
          return { status: 'decoded', image: await pixelsOf(primary, width, height) };
        } catch {
          return failed('decode_failed');
        }
      };
      try {
        return await rasterOutcomes(requests, decodePage);
      } finally {
        for (const image of images) image.free?.();
      }
    },
  };
}

export const heicGenerator = createHeicGenerator();
