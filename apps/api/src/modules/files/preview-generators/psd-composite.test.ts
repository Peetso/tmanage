import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { jpegCodec } from './codecs.js';
import { labToRgb, PSD_COLOR_MODE, readForeignComposite } from './psd-composite.js';
import { psdGenerator } from './psd.js';
import { decodeWebp } from './raster.js';
import { DEFAULT_PREVIEW_LIMITS } from './types.js';
import type { PreviewOutcome } from './types.js';

/**
 * FIX6 item 5. The fixtures are written byte by byte from the PSD file layout, because ag-psd
 * (the RGB fixtures' writer) cannot write CMYK or Lab.
 */
const require = createRequire(import.meta.url);

function u16(value: number): number[] {
  return [(value >> 8) & 255, value & 255];
}
function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255];
}

interface Fixture {
  readonly mode: number;
  readonly width: number;
  readonly height: number;
  /** One value per channel, the whole plane filled with it. */
  readonly fill: readonly number[];
  readonly rle: boolean;
  /** Image resources section bytes. */
  readonly resources?: readonly number[];
  /** Leave the image data out (only a thumbnail can be used). */
  readonly noComposite?: boolean;
}

function file({
  mode,
  width,
  height,
  fill,
  rle,
  resources = [],
  noComposite,
}: Fixture): Uint8Array {
  const bytes: number[] = [
    ...[0x38, 0x42, 0x50, 0x53],
    ...u16(1),
    0,
    0,
    0,
    0,
    0,
    0,
    ...u16(fill.length),
    ...u32(height),
    ...u32(width),
    ...u16(8),
    ...u16(mode),
    ...u32(0),
    ...u32(resources.length),
    ...resources,
    ...u32(0),
  ];
  if (noComposite) {
    bytes.push(...u16(3)); // ZIP compression: not read here.
    return Uint8Array.from(bytes);
  }
  if (!rle) {
    bytes.push(...u16(0));
    for (const value of fill) for (let i = 0; i < width * height; i += 1) bytes.push(value);
    return Uint8Array.from(bytes);
  }
  // PackBits: each row is one run of `width` equal bytes: (1 - width) as int8, then the value.
  bytes.push(...u16(1));
  for (let c = 0; c < fill.length; c += 1)
    for (let y = 0; y < height; y += 1) bytes.push(...u16(2));
  for (const value of fill) {
    for (let y = 0; y < height; y += 1) bytes.push((1 - width) & 255, value);
  }
  return Uint8Array.from(bytes);
}

async function preview(
  bytes: Uint8Array,
): Promise<{ outcomes: readonly PreviewOutcome[]; rgba: number[] }> {
  const outcomes = await psdGenerator.generate(
    { bytes, mimeType: 'image/vnd.adobe.photoshop' },
    [
      { kind: 'preview', pageNo: 0 },
      { kind: 'psd_layers', pageNo: 0 },
    ],
    DEFAULT_PREVIEW_LIMITS,
  );
  const first = outcomes[0];
  if (first?.status !== 'ready' || !first.body) throw new Error(`preview: ${first?.status}`);
  const image = await decodeWebp(first.body);
  return { outcomes, rgba: Array.from(image.data.slice(0, 4)) };
}

/** The `meta` of a ready outcome; any other status fails the test with its status. */
function readyMeta(
  outcome: PreviewOutcome | undefined,
): Extract<PreviewOutcome, { status: 'ready' }>['meta'] {
  if (outcome?.status !== 'ready') throw new Error(`expected ready, got ${outcome?.status}`);
  return outcome.meta;
}

function near(actual: number[], expected: number[], tolerance = 6): void {
  actual.forEach((value, i) =>
    expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(tolerance),
  );
}

describe('PSD colour modes ag-psd does not open (FIX6 item 5)', () => {
  it('CMYK (PackBits): a pure cyan file previews cyan, marked approximate', async () => {
    // Stored inverted: C full ink = 0, no M/Y/K ink = 255.
    const bytes = file({
      mode: PSD_COLOR_MODE.cmyk,
      width: 6,
      height: 3,
      fill: [0, 255, 255, 255],
      rle: true,
    });
    const { outcomes, rgba } = await preview(bytes);
    near(rgba, [0, 255, 255, 255]);
    expect(readyMeta(outcomes[0])).toMatchObject({ approximate: true });
    expect(outcomes[1]).toMatchObject({ status: 'ready', width: 6, height: 3 });
  });

  it('CMYK (raw) with full black ink previews black', async () => {
    const bytes = file({
      mode: PSD_COLOR_MODE.cmyk,
      width: 2,
      height: 2,
      fill: [255, 255, 255, 0],
      rle: false,
    });
    near((await preview(bytes)).rgba, [0, 0, 0, 255]);
  });

  it('Lab: L 100, a 0, b 0 is white; the formula matches a known red', async () => {
    const bytes = file({
      mode: PSD_COLOR_MODE.lab,
      width: 3,
      height: 2,
      fill: [255, 128, 128],
      rle: true,
    });
    near((await preview(bytes)).rgba, [255, 255, 255, 255]);
    // sRGB red is about Lab(54.3, 80.8, 69.9) in D50.
    near(labToRgb(54.29, 80.81, 69.89), [255, 0, 0], 8);
  });

  it('without a readable composite, the embedded thumbnail is used', async () => {
    const thumb = jpegCodec().encode(
      {
        width: 4,
        height: 4,
        data: new Uint8Array(4 * 4 * 4)
          .fill(0)
          .map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)),
      },
      90,
    ).data;
    const block = [
      ...u32(1),
      ...u32(4),
      ...u32(4),
      ...u32(12),
      ...u32(48),
      ...u32(thumb.length),
      ...u16(24),
      ...u16(1),
    ];
    const data = [...block, ...thumb];
    const resource = [
      ...[0x38, 0x42, 0x49, 0x4d],
      ...u16(1036),
      0,
      0,
      ...u32(data.length),
      ...data,
      ...(data.length % 2 === 1 ? [0] : []),
    ];
    const bytes = file({
      mode: PSD_COLOR_MODE.cmyk,
      width: 40,
      height: 40,
      fill: [0, 0, 0, 0],
      rle: true,
      resources: resource,
      noComposite: true,
    });
    expect(readForeignComposite(bytes)?.thumbnailOnly).toBe(true);
    near((await preview(bytes)).rgba, [255, 0, 0, 255], 24);
  });

  it('a truncated file fails cleanly', async () => {
    const bytes = file({
      mode: PSD_COLOR_MODE.cmyk,
      width: 6,
      height: 3,
      fill: [0, 255, 255, 255],
      rle: true,
    });
    const outcomes = await psdGenerator.generate(
      { bytes: bytes.subarray(0, bytes.byteLength - 5), mimeType: 'image/vnd.adobe.photoshop' },
      [{ kind: 'preview', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcomes[0]?.status).toBe('failed');
  });

  it('a CMYK file with layers lists its layer tree; the header bytes are left as they were', async () => {
    const agPsd = require('ag-psd') as {
      writePsdUint8Array(psd: unknown, options?: { useImageData?: boolean }): Uint8Array;
    };
    const pixels = (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    });
    const rgb = agPsd.writePsdUint8Array(
      {
        width: 2,
        height: 2,
        imageData: pixels(2, 2),
        children: [
          { name: 'Background', top: 0, left: 0, bottom: 2, right: 2, imageData: pixels(2, 2) },
          {
            name: 'Logo',
            hidden: true,
            top: 0,
            left: 0,
            bottom: 1,
            right: 1,
            imageData: pixels(1, 1),
          },
        ],
      },
      { useImageData: true },
    );
    const bytes = Uint8Array.from(rgb);
    new DataView(bytes.buffer).setUint16(24, PSD_COLOR_MODE.cmyk);
    const outcomes = await psdGenerator.generate(
      { bytes, mimeType: 'image/vnd.adobe.photoshop' },
      [{ kind: 'psd_layers', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(readyMeta(outcomes[0])).toMatchObject({
      layers: [
        { name: 'Logo', visible: false },
        { name: 'Background', visible: true },
      ],
      approximate: true,
    });
    expect(new DataView(bytes.buffer).getUint16(24)).toBe(PSD_COLOR_MODE.cmyk);
  });
});
