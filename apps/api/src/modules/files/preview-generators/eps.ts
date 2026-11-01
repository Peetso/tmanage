import { tiffGenerator } from './tiff.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome } from './types.js';

/**
 * R4 slice 10 — EPS. PostScript cannot be drawn on Hostinger shared hosting with free tools
 * (Ghostscript is AGPL and native; there is no realistic pure-JS interpreter — SPEC R4 §2, risk 3).
 *
 * What can be shown: a DOS-EPS file (binary header `C5 D0 D3 C6`) often carries a small TIFF
 * preview its authoring app saved next to the PostScript. That TIFF is cut out and drawn like any
 * TIFF (`preview` + `thumb`, `meta.embeddedPreview`), and the screen labels it "Low-resolution
 * preview from the file". A plain `%!PS-Adobe` file, or one whose preview is a WMF, gets
 * `unsupported: eps_no_preview` and the viewer offers the download with general comments.
 *
 * Illustrator files saved PDF-compatible are detected as `application/pdf` (slice 1) and never
 * reach this generator; pdf.js draws them.
 */

const EPS = 'application/postscript';
const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6] as const;
const TIFF_HEADS = [
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
] as const;

/** The embedded TIFF preview of a DOS-EPS file, or `null` when there is none. */
export function embeddedTiff(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 30 || DOS_EPS.some((value, index) => bytes[index] !== value)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = data.getUint32(20, true);
  const length = data.getUint32(24, true);
  if (offset === 0 || length < 8 || offset + length > bytes.byteLength) return null;
  const tiff = bytes.subarray(offset, offset + length);
  const isTiff = TIFF_HEADS.some((head) => head.every((value, index) => tiff[index] === value));
  return isTiff ? tiff : null;
}

export const epsGenerator: PreviewGenerator = {
  name: 'eps',
  mimeTypes: [EPS],
  plan() {
    return [{ kind: 'preview' }, { kind: 'thumb' }];
  },
  async generate(source, requests, limits) {
    const tiff = embeddedTiff(source.bytes);
    if (tiff === null) return requests.map(() => unsupported('eps_no_preview'));
    const answers = await tiffGenerator.generate(
      { bytes: tiff, mimeType: 'image/tiff' },
      requests.map((request) => ({ kind: request.kind, pageNo: 0 })),
      { ...limits, maxPages: 1 },
    );
    return answers.map((answer): PreviewOutcome => {
      if (answer.status === 'failed') return failed('eps_preview_unreadable');
      if (answer.status !== 'ready') return answer;
      // Page 0 requests never carry TIFF follow-ups; the preview is one picture.
      return {
        status: 'ready',
        body: answer.body,
        mimeType: answer.mimeType,
        width: answer.width,
        height: answer.height,
        meta: { ...answer.meta, pages: null, embeddedPreview: true },
      };
    });
  },
};
