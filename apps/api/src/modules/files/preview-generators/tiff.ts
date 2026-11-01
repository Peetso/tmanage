import { utifCodec } from './codecs.js';
import type { UtifIfd } from './codecs.js';
import { rasterOutcomes } from './raster.js';
import type { DecodedPage } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PendingPreviewSpec } from '../file-previews.repository.js';
import type { PreviewGenerator } from './types.js';

/**
 * R4 slice 3 — TIFF, single or multi-page, through UTIF (pure JS).
 *
 * A version starts with `preview` of page 1 and a `thumb`. Page 1's answer carries the page count
 * (`meta.pages`), and, for a multi-page file, the follow-up rows the viewer's page strip needs: a
 * `page_thumb` for every page and a `preview` for pages 2 … n, up to `maxPages` (20). The job
 * inserts those rows and the next batch draws them. CMYK and 16-bit pages are converted by UTIF
 * approximately — the viewer says "approximate colour" for TIFF proofs (SPEC R4 §2).
 */

const TIFF = 'image/tiff';

function dimensions(ifd: UtifIfd): { width: number; height: number } | null {
  const width = ifd.t256?.[0];
  const height = ifd.t257?.[0];
  if (!width || !height) return null;
  return { width, height };
}

export const tiffGenerator: PreviewGenerator = {
  name: 'tiff',
  mimeTypes: [TIFF],
  plan() {
    return [{ kind: 'preview', pageNo: 1 }, { kind: 'thumb' }];
  },
  async generate(source, requests, limits) {
    const utif = utifCodec();
    let pages: UtifIfd[] | null = null;
    try {
      pages = utif.decode(source.bytes).filter((ifd) => dimensions(ifd) !== null);
    } catch {
      pages = null;
    }
    const pageCount = pages?.length ?? 0;
    const decodePage = async (pageNo: number): Promise<DecodedPage> => {
      if (!pages || pageCount === 0) return failed('decode_failed');
      if (pageNo > Math.min(pageCount, limits.maxPages)) return unsupported('no_such_page');
      const ifd = pages[pageNo - 1]!;
      const size = dimensions(ifd)!;
      if (size.width * size.height > limits.maxPixels) return unsupported('unsupported_too_large');
      try {
        utif.decodeImage(source.bytes, ifd);
        const data = utif.toRGBA8(ifd);
        if (data.length < size.width * size.height * 4) return failed('decode_failed');
        return { status: 'decoded', image: { width: size.width, height: size.height, data } };
      } catch {
        return failed('decode_failed');
      }
    };
    return rasterOutcomes(requests, decodePage, (request) => {
      const shown = Math.min(pageCount, limits.maxPages);
      const meta = { pages: pageCount, pageNo: request.pageNo === 0 ? 1 : request.pageNo };
      if (request.kind !== 'preview' || request.pageNo !== 1 || shown < 2) return { meta };
      const followUps: PendingPreviewSpec[] = [];
      for (let page = 1; page <= shown; page += 1) {
        followUps.push({ kind: 'page_thumb', pageNo: page });
        if (page > 1) followUps.push({ kind: 'preview', pageNo: page });
      }
      return { meta, followUps };
    });
  },
};
