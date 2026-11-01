import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { jpegCodec, pngCodec, utifCodec } from './codecs.js';
import type { HeifImage, RgbaImage } from './codecs.js';
import { createHeicGenerator, heicGenerator } from './heic.js';
import { imageGenerator } from './image.js';
import { decodeWebp, encodeWebp, fitWithin, orientRgba, resizeRgba } from './raster.js';
import { sanitizeSvg, svgGenerator, unpremultiply } from './svg.js';
import { tiffGenerator } from './tiff.js';
import { DEFAULT_PREVIEW_LIMITS } from './types.js';
import type { PreviewOutcome, PreviewRequest } from './types.js';
import { generatorFor, previewMimeTypes, previewPlanFor } from './index.js';

/**
 * R4 slice 3 — the preview generators on tiny fixtures made in the test itself (no binary files
 * checked in): each answer decoded back and looked at, so "ready" means a real WebP of the right
 * size and, where it matters, the right way up.
 */

const require = createRequire(import.meta.url);
const PREVIEW: PreviewRequest = { kind: 'preview', pageNo: 0 };
const THUMB: PreviewRequest = { kind: 'thumb', pageNo: 0 };

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** Left half `left`, right half `right`. */
function halves(width: number, height: number, left: number[], right: number[]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(x < width / 2 ? left : right, (y * width + x) * 4);
  }
  return { width, height, data };
}

function png(image: RgbaImage): Uint8Array {
  const { PNG } = pngCodec();
  const out = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data).copy(out.data);
  return new Uint8Array(PNG.sync.write(out));
}

function jpeg(image: RgbaImage): Uint8Array {
  return new Uint8Array(
    jpegCodec().encode({ ...image, data: Uint8Array.from(image.data) }, 95).data,
  );
}

/** A JPEG with an EXIF APP1 segment carrying `orientation`, inserted after SOI. */
function jpegWithOrientation(image: RgbaImage, orientation: number): Uint8Array {
  const plain = jpeg(image);
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1];
  tiff.push(0, orientation, 0, 0, 0, 0, 0, 0);
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
  return Uint8Array.from([...plain.subarray(0, 2), ...app1, ...plain.subarray(2)]);
}

function gif(width: number, height: number): Uint8Array {
  const { GifWriter } = require('omggif') as {
    GifWriter: new (
      buf: Uint8Array,
      w: number,
      h: number,
      options: { palette: number[] },
    ) => {
      addFrame(x: number, y: number, w: number, h: number, pixels: number[]): void;
      end(): number;
    };
  };
  const buffer = new Uint8Array(4096);
  const writer = new GifWriter(buffer, width, height, { palette: [0xff0000, 0x0000ff] });
  writer.addFrame(0, 0, width, height, new Array<number>(width * height).fill(1));
  return buffer.slice(0, writer.end());
}

/** A big-endian TIFF with one uncompressed RGBA page per image (UTIF's own IFD shape). */
function tiff(pages: readonly RgbaImage[]): Uint8Array {
  let offset = 1000;
  const ifds = pages.map((page) => {
    const length = page.width * page.height * 4;
    const ifd = {
      t256: [page.width],
      t257: [page.height],
      t258: [8, 8, 8, 8],
      t259: [1],
      t262: [2],
      t273: [offset],
      t277: [4],
      t278: [page.height],
      t279: [length],
      t282: [1],
      t283: [1],
      t284: [1],
      t286: [0],
      t287: [0],
      t296: [1],
      t338: [1],
    };
    offset += length;
    return ifd;
  });
  const prefix = new Uint8Array(utifCodec().encode(ifds));
  const out = new Uint8Array(offset);
  out.set(prefix);
  let at = 1000;
  for (const page of pages) {
    out.set(page.data, at);
    at += page.data.length;
  }
  return out;
}

async function readyImage(outcome: PreviewOutcome | undefined): Promise<RgbaImage> {
  expect(outcome?.status).toBe('ready');
  if (outcome?.status !== 'ready') throw new Error('not ready');
  expect(outcome.mimeType).toBe('image/webp');
  const decoded = await decodeWebp(outcome.body);
  expect([decoded.width, decoded.height]).toEqual([outcome.width, outcome.height]);
  return decoded;
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.slice(i, i + 4));
}

const near = (actual: number[], expected: number[], tolerance = 40) =>
  actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);

describe('raster helpers', () => {
  it('fits the long side and never scales up', () => {
    expect(fitWithin(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin(300, 900, 320)).toEqual({ width: 107, height: 320 });
    expect(fitWithin(100, 50, 320)).toEqual({ width: 100, height: 50 });
  });

  it('averages area, weighting colour by alpha so a transparent pixel does not darken the edge', () => {
    const image: RgbaImage = {
      width: 2,
      height: 2,
      data: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]),
    };
    const out = resizeRgba(image, 1, 1);
    expect(pixel(out, 0, 0)).toEqual([255, 0, 0, 128]);
    const grey = resizeRgba(halves(4, 2, [0, 0, 0, 255], [200, 200, 200, 255]), 1, 1);
    expect(pixel(grey, 0, 0)).toEqual([100, 100, 100, 255]);
  });

  it('turns an image upright for EXIF 6 (90° clockwise) and 3 (180°)', () => {
    const image = halves(4, 2, [255, 0, 0, 255], [0, 0, 255, 255]);
    const six = orientRgba(image, 6);
    expect([six.width, six.height]).toEqual([2, 4]);
    expect(pixel(six, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(six, 0, 3)).toEqual([0, 0, 255, 255]);
    const three = orientRgba(image, 3);
    expect(pixel(three, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(orientRgba(image, 1)).toBe(image);
  });
});

describe('the kind map', () => {
  it('names a generator and starting rows for each slice-3 type, none for the rest', () => {
    expect(previewMimeTypes()).toEqual(
      expect.arrayContaining([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/svg+xml',
        'image/heic',
        'image/heif',
        'image/tiff',
      ]),
    );
    expect(previewPlanFor('image/png')).toEqual([{ kind: 'preview' }, { kind: 'thumb' }]);
    expect(previewPlanFor('image/gif')).toEqual([{ kind: 'thumb' }]);
    expect(previewPlanFor('image/svg+xml').map((spec) => spec.kind)).toEqual([
      'svg_safe',
      'preview',
      'thumb',
    ]);
    expect(previewPlanFor('image/tiff')).toEqual([
      { kind: 'preview', pageNo: 1 },
      { kind: 'thumb' },
    ]);
    expect(previewPlanFor('application/pdf')).toEqual([]);
    expect(generatorFor(null)).toBeNull();
  });
});

describe('imageGenerator', () => {
  it('makes a 1×1 PNG into a 1×1 preview and thumb (never scaled up)', async () => {
    const outcomes = await imageGenerator.generate(
      { bytes: png(solid(1, 1, [10, 200, 30, 255])), mimeType: 'image/png' },
      [PREVIEW, THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    expect([preview.width, preview.height]).toEqual([1, 1]);
    expect(near(pixel(preview, 0, 0), [10, 200, 30, 255])).toBe(true);
    await readyImage(outcomes[1]);
    expect(outcomes[0]?.status === 'ready' && outcomes[0].meta).toEqual({
      sourceWidth: 1,
      sourceHeight: 1,
    });
  });

  it('scales a wide PNG thumb to a 320 long side and keeps transparency', async () => {
    const outcomes = await imageGenerator.generate(
      { bytes: png(solid(640, 200, [0, 0, 0, 0])), mimeType: 'image/png' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const thumb = await readyImage(outcomes[0]);
    expect([thumb.width, thumb.height]).toEqual([320, 100]);
    expect(pixel(thumb, 5, 5)[3]).toBe(0);
  });

  it('stands a JPEG upright by its EXIF orientation', async () => {
    const bytes = jpegWithOrientation(halves(40, 20, [255, 0, 0, 255], [0, 0, 255, 255]), 6);
    const outcomes = await imageGenerator.generate(
      { bytes, mimeType: 'image/jpeg' },
      [PREVIEW],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    expect([preview.width, preview.height]).toEqual([20, 40]);
    expect(near(pixel(preview, 10, 2), [255, 0, 0, 255], 80)).toBe(true);
    expect(near(pixel(preview, 10, 37), [0, 0, 255, 255], 80)).toBe(true);
    expect(outcomes[0]?.status === 'ready' && outcomes[0].meta).toEqual({
      sourceWidth: 20,
      sourceHeight: 40,
    });
  });

  it('reads WebP and the first frame of a GIF', async () => {
    const webp = await encodeWebp(solid(30, 10, [0, 255, 0, 255]), 90);
    const fromWebp = await imageGenerator.generate(
      { bytes: webp, mimeType: 'image/webp' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect((await readyImage(fromWebp[0])).width).toBe(30);
    const fromGif = await imageGenerator.generate(
      { bytes: gif(8, 4), mimeType: 'image/gif' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const thumb = await readyImage(fromGif[0]);
    expect(near(pixel(thumb, 2, 2), [0, 0, 255, 255])).toBe(true);
  });

  it('refuses above the pixel cap from the header alone, and fails bytes that will not decode', async () => {
    const big = await imageGenerator.generate(
      { bytes: png(solid(100, 100, [0, 0, 0, 255])), mimeType: 'image/png' },
      [PREVIEW, THUMB],
      { ...DEFAULT_PREVIEW_LIMITS, maxPixels: 9_999 },
    );
    expect(big).toEqual([
      { status: 'unsupported', code: 'unsupported_too_large' },
      { status: 'unsupported', code: 'unsupported_too_large' },
    ]);
    const header = png(solid(4, 4, [0, 0, 0, 255])).subarray(0, 40);
    const broken = await imageGenerator.generate(
      { bytes: header, mimeType: 'image/png' },
      [PREVIEW],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(broken).toEqual([{ status: 'failed', code: 'decode_failed' }]);
  });

  it('answers a kind it does not make as unsupported', async () => {
    const outcomes = await imageGenerator.generate(
      { bytes: png(solid(2, 2, [0, 0, 0, 255])), mimeType: 'image/png' },
      [{ kind: 'zip_manifest', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcomes).toEqual([{ status: 'unsupported', code: 'kind_not_raster' }]);
  });
});

describe('tiffGenerator', () => {
  it('draws page 1 of a 2-page TIFF and names the rows the other page needs', async () => {
    const bytes = tiff([solid(50, 20, [255, 0, 0, 255]), solid(20, 30, [0, 0, 255, 255])]);
    const first = await tiffGenerator.generate(
      { bytes, mimeType: 'image/tiff' },
      [{ kind: 'preview', pageNo: 1 }, THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const page1 = await readyImage(first[0]);
    expect([page1.width, page1.height]).toEqual([50, 20]);
    expect(first[0]?.status === 'ready' && first[0].meta).toMatchObject({ pages: 2, pageNo: 1 });
    expect(first[0]?.status === 'ready' && first[0].followUps).toEqual([
      { kind: 'page_thumb', pageNo: 1 },
      { kind: 'page_thumb', pageNo: 2 },
      { kind: 'preview', pageNo: 2 },
    ]);
    expect(first[1]?.status === 'ready' && first[1].followUps).toBeUndefined();

    const second = await tiffGenerator.generate(
      { bytes, mimeType: 'image/tiff' },
      [
        { kind: 'preview', pageNo: 2 },
        { kind: 'page_thumb', pageNo: 3 },
      ],
      DEFAULT_PREVIEW_LIMITS,
    );
    const page2 = await readyImage(second[0]);
    expect([page2.width, page2.height]).toEqual([20, 30]);
    expect(near(pixel(page2, 5, 5), [0, 0, 255, 255])).toBe(true);
    expect(second[1]).toEqual({ status: 'unsupported', code: 'no_such_page' });
  });

  it('a single-page TIFF has no follow-ups; garbage fails', async () => {
    const one = await tiffGenerator.generate(
      { bytes: tiff([solid(4, 4, [9, 9, 9, 255])]), mimeType: 'image/tiff' },
      [{ kind: 'preview', pageNo: 1 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(one[0]?.status === 'ready' && one[0].followUps).toBeUndefined();
    const garbage = await tiffGenerator.generate(
      { bytes: Uint8Array.from([0x49, 0x49, 0x2a, 0, 1, 2]), mimeType: 'image/tiff' },
      [{ kind: 'preview', pageNo: 1 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(garbage).toEqual([{ status: 'failed', code: 'decode_failed' }]);
  });
});

describe('heicGenerator', () => {
  it('draws the primary image libheif hands back, and frees what it decoded', async () => {
    let freed = 0;
    const fake: HeifImage = {
      get_width: () => 64,
      get_height: () => 32,
      display: (target, done) => {
        target.data.fill(200);
        done(target);
      },
      free: () => {
        freed += 1;
      },
    };
    const generator = createHeicGenerator(() => [fake]);
    const outcomes = await generator.generate(
      { bytes: new Uint8Array(8), mimeType: 'image/heic' },
      [PREVIEW, THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    expect([preview.width, preview.height]).toEqual([64, 32]);
    expect(freed).toBe(1);
    const tooBig = await generator.generate(
      { bytes: new Uint8Array(8), mimeType: 'image/heic' },
      [PREVIEW],
      { ...DEFAULT_PREVIEW_LIMITS, maxPixels: 100 },
    );
    expect(tooBig).toEqual([{ status: 'unsupported', code: 'unsupported_too_large' }]);
  });

  it('the real libheif decoder fails a file that is not HEIC, without throwing', async () => {
    const bytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const outcomes = await heicGenerator.generate(
      { bytes, mimeType: 'image/heic' },
      [PREVIEW],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcomes).toEqual([{ status: 'failed', code: 'decode_failed' }]);
  }, 30_000);
});

const HOSTILE_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20" viewBox="0 0 40 20">
  <script>alert(1)</script>
  <style>@import url(https://evil.example/x.css); .a { fill: url(#g); } .b { fill: url(https://evil.example/p.svg#x); }</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <rect class="a" width="40" height="20" onload="steal()"/>
  <use xlink:href="#g"/>
  <image href="https://evil.example/tracker.png" width="1" height="1"/>
  <a href="javascript:alert(1)"><text x="1" y="10">hi&#160;there</text></a>
  <foreignObject width="10" height="10"><div>html</div></foreignObject>
</svg>`;

describe('svgGenerator', () => {
  it('sanitises: no script, handler, foreignObject, remote href or remote url(), and says so', () => {
    const safe = sanitizeSvg(HOSTILE_SVG);
    expect(safe).not.toBeNull();
    const markup = safe!.markup;
    expect(markup.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg')).toBe(true);
    expect(markup).not.toMatch(/<script|onload|foreignObject|javascript:|evil\.example|@import/i);
    expect(markup).toMatch(/url\(#g\)/);
    expect(markup).toMatch(/<use xlink:href="#g"/);
    expect(markup).toMatch(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(markup).not.toMatch(/&nbsp;/);
    expect(safe!.linkedImagesRemoved).toBe(true);
    expect(
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')?.linkedImagesRemoved,
    ).toBe(false);
    expect(sanitizeSvg('<div>not svg</div>')).toBeNull();
  });

  it('serves the sanitised copy and rasterises it for preview and thumb', async () => {
    const outcomes = await svgGenerator.generate(
      { bytes: new TextEncoder().encode(HOSTILE_SVG), mimeType: 'image/svg+xml' },
      [{ kind: 'svg_safe', pageNo: 0 }, PREVIEW, THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const safe = outcomes[0];
    expect(safe?.status).toBe('ready');
    if (safe?.status !== 'ready') return;
    expect(safe.mimeType).toBe('image/svg+xml');
    expect(new TextDecoder().decode(safe.body)).not.toMatch(/<script/);
    expect(safe.meta).toEqual({ sourceWidth: 40, sourceHeight: 20, linkedImagesRemoved: true });
    const preview = await readyImage(outcomes[1]);
    expect([preview.width, preview.height]).toEqual([2048, 1024]);
    expect(near(pixel(preview, 100, 100), [255, 0, 0, 255])).toBe(true);
    const thumb = await readyImage(outcomes[2]);
    expect([thumb.width, thumb.height]).toEqual([320, 160]);
  });

  it('turns resvg premultiplied pixels straight before encoding', async () => {
    expect(Array.from(unpremultiply(Uint8Array.from([128, 0, 0, 128, 9, 9, 9, 0])))).toEqual([
      255, 0, 0, 128, 0, 0, 0, 0,
    ]);
    const half =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000" fill-opacity="0.5"/></svg>';
    const [thumb] = await svgGenerator.generate(
      { bytes: new TextEncoder().encode(half), mimeType: 'image/svg+xml' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(near(pixel(await readyImage(thumb), 10, 10), [255, 0, 0, 128], 20)).toBe(true);
  });

  it('fails markup that is not SVG or not UTF-8, and refuses an oversized file', async () => {
    const notSvg = await svgGenerator.generate(
      { bytes: new TextEncoder().encode('<html><body/></html>'), mimeType: 'image/svg+xml' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(notSvg).toEqual([{ status: 'failed', code: 'svg_invalid' }]);
    const latin1 = await svgGenerator.generate(
      { bytes: Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]), mimeType: 'image/svg+xml' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(latin1).toEqual([{ status: 'failed', code: 'svg_invalid' }]);
    const huge = await svgGenerator.generate(
      { bytes: new Uint8Array(10 * 1024 * 1024 + 1), mimeType: 'image/svg+xml' },
      [THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(huge).toEqual([{ status: 'unsupported', code: 'unsupported_too_large' }]);
  });
});
