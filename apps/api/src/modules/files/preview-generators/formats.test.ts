import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { utifCodec } from './codecs.js';
import type { RgbaImage } from './codecs.js';
import { embeddedTiff, epsGenerator } from './eps.js';
import { officeFactsFrom, officeMetaGenerator } from './office-meta.js';
import { flattenLayers, layerTreeOf, psdGenerator } from './psd.js';
import { decodeWebp } from './raster.js';
import { DEFAULT_PREVIEW_LIMITS } from './types.js';
import type { PreviewOutcome, PreviewRequest } from './types.js';
import { readZipDirectory, readZipPart, ZipReadError } from './zip-reader.js';
import { zipFactsFrom, zipGenerator } from './zip.js';
import { generatorFor, previewPlanFor } from './index.js';

/**
 * R4 slice 10 — PSD, ZIP, EPS and Office facts on fixtures built in the test (no binary files
 * checked in): PSDs written with ag-psd itself (with and without a saved composite), ZIPs and
 * Office packages written by a tiny ZIP writer below, a DOS-EPS wrapping a real TIFF.
 */

const require = createRequire(import.meta.url);
const PREVIEW: PreviewRequest = { kind: 'preview', pageNo: 0 };
const THUMB: PreviewRequest = { kind: 'thumb', pageNo: 0 };
const OOXML = 'application/vnd.openxmlformats-officedocument';

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

async function readyImage(outcome: PreviewOutcome | undefined): Promise<RgbaImage> {
  expect(outcome?.status).toBe('ready');
  if (outcome?.status !== 'ready' || outcome.body === null) throw new Error('not ready');
  expect(outcome.mimeType).toBe('image/webp');
  return decodeWebp(outcome.body);
}

/** WebP is lossy: colours come back within a few steps. */
function expectColour(actual: number[], expected: number[]): void {
  actual.slice(0, 3).forEach((value, index) => {
    expect(Math.abs(value - expected[index]!)).toBeLessThanOrEqual(8);
  });
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(at, at + 4));
}

// ── ZIP writer ─────────────────────────────────────────────────────────────

interface ZipInput {
  readonly path: string;
  readonly body?: string;
  /** Overrides the declared unpacked size in the central directory (bomb fixtures). */
  readonly declaredSize?: number;
  readonly deflate?: boolean;
}

function zip(files: readonly ZipInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const raw = Buffer.from(file.body ?? '', 'utf8');
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const method = file.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE((14 << 11) | (5 << 5), 12); // 14:05:00
    central.writeUInt16LE(((2026 - 1980) << 9) | (10 << 5) | 28, 14); // 2026-10-28
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

// ── PSD writer (ag-psd itself) ─────────────────────────────────────────────

interface AgPsdWrite {
  writePsdUint8Array(psd: unknown, options?: { useImageData?: boolean }): Uint8Array;
}

function psd(document: unknown): Uint8Array {
  // The generator module sets ag-psd up for plain pixel arrays on first use.
  layerTreeOf([]);
  return (require('ag-psd') as AgPsdWrite).writePsdUint8Array(document, { useImageData: true });
}

/** A big-endian TIFF with one uncompressed RGBA page (UTIF's own IFD shape). */
function tiff(page: RgbaImage): Uint8Array {
  const length = page.width * page.height * 4;
  const ifd = {
    t256: [page.width],
    t257: [page.height],
    t258: [8, 8, 8, 8],
    t259: [1],
    t262: [2],
    t273: [1000],
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
  const prefix = new Uint8Array(utifCodec().encode([ifd]));
  const out = new Uint8Array(1000 + length);
  out.set(prefix);
  out.set(page.data, 1000);
  return out;
}

/** A DOS-EPS: the 30-byte binary header, the PostScript, then an optional TIFF preview. */
function dosEps(preview: Uint8Array | null): Uint8Array {
  const postscript = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n');
  const header = Buffer.alloc(30);
  header.set([0xc5, 0xd0, 0xd3, 0xc6]);
  header.writeUInt32LE(30, 4);
  header.writeUInt32LE(postscript.length, 8);
  header.writeUInt32LE(preview ? 30 + postscript.length : 0, 20);
  header.writeUInt32LE(preview ? preview.length : 0, 24);
  header.writeUInt16LE(0xffff, 28);
  return new Uint8Array(Buffer.concat([header, postscript, Buffer.from(preview ?? [])]));
}

afterEach(() => {
  delete process.env['PREVIEW_ZIP_MAX_ENTRIES'];
});

describe('kind map (slice 10)', () => {
  it('routes PSD, EPS, ZIP and Office types to their generators', () => {
    expect(generatorFor('image/vnd.adobe.photoshop')?.name).toBe('psd');
    expect(generatorFor('application/postscript')?.name).toBe('eps');
    expect(generatorFor('application/zip')?.name).toBe('zip');
    expect(generatorFor(`${OOXML}.presentationml.presentation`)?.name).toBe('office-meta');
    expect(previewPlanFor('image/vnd.adobe.photoshop').map((row) => row.kind)).toEqual([
      'preview',
      'thumb',
      'psd_layers',
    ]);
    expect(previewPlanFor('application/zip')).toEqual([{ kind: 'zip_manifest' }]);
    expect(previewPlanFor(`${OOXML}.spreadsheetml.sheet`)).toEqual([{ kind: 'office_meta' }]);
    // An Illustrator file saved PDF-compatible is recorded as a PDF: pdf.js draws it in the
    // browser, no server derivative.
    expect(previewPlanFor('application/pdf')).toEqual([]);
  });
});

describe('psdGenerator', () => {
  const tree = {
    width: 4,
    height: 2,
    children: [
      {
        name: 'Background',
        top: 0,
        left: 0,
        bottom: 2,
        right: 4,
        imageData: solid(4, 2, [255, 255, 255, 255]),
      },
      {
        name: 'Photo',
        opened: true,
        children: [
          {
            name: 'Lobby retouch',
            top: 0,
            left: 0,
            bottom: 2,
            right: 2,
            opacity: 0.6,
            blendMode: 'soft light',
            imageData: solid(2, 2, [0, 0, 255, 255]),
          },
        ],
      },
      {
        name: 'Colour grade',
        hidden: true,
        top: 0,
        left: 2,
        bottom: 2,
        right: 4,
        imageData: solid(2, 2, [0, 255, 0, 255]),
      },
    ],
  };

  it('draws the composite Photoshop saved and lists the layers, top first', async () => {
    const bytes = psd({ ...tree, imageData: solid(4, 2, [200, 10, 10, 255]) });
    const outcomes = await psdGenerator.generate(
      { bytes, mimeType: 'image/vnd.adobe.photoshop' },
      [PREVIEW, THUMB, { kind: 'psd_layers', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    expect([preview.width, preview.height]).toEqual([4, 2]);
    expectColour(pixel(preview, 3, 1), [200, 10, 10]);
    await readyImage(outcomes[1]);
    const layers = outcomes[2];
    expect(layers?.status).toBe('ready');
    if (layers?.status !== 'ready') return;
    expect(layers.body).toBeNull();
    expect(layers.meta).toMatchObject({ layerCount: 3, groupCount: 1, approximate: false });
    expect(layers.meta?.['layers']).toEqual([
      { name: 'Colour grade', kind: 'pixel', visible: false, opacity: 100, blendMode: 'normal' },
      {
        name: 'Photo',
        kind: 'group',
        visible: true,
        opacity: 100,
        blendMode: 'pass through',
        children: [
          {
            name: 'Lobby retouch',
            kind: 'pixel',
            visible: true,
            opacity: 60,
            blendMode: 'soft light',
          },
        ],
      },
      { name: 'Background', kind: 'pixel', visible: true, opacity: 100, blendMode: 'normal' },
    ]);
  });

  it('stacks the visible layers when the file has no composite, and says it is approximate', async () => {
    const bytes = psd({
      ...tree,
      imageData: solid(4, 2, [255, 255, 255, 255]),
      imageResources: {
        versionInfo: {
          hasRealMergedData: false,
          writerName: 'Adobe Photoshop',
          readerName: 'Adobe Photoshop 2026',
          fileVersion: 1,
        },
      },
    });
    const outcomes = await psdGenerator.generate(
      { bytes, mimeType: 'image/vnd.adobe.photoshop' },
      [PREVIEW, { kind: 'psd_layers', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    // Left half: white under 60 % blue (normal blend); right half: white (the green is hidden).
    expectColour(pixel(preview, 0, 0), [102, 102, 255]);
    expectColour(pixel(preview, 3, 0), [255, 255, 255]);
    expect(outcomes[0]?.status === 'ready' && outcomes[0].meta?.['approximate']).toBe(true);
    expect(outcomes[1]?.status === 'ready' && outcomes[1].meta?.['approximate']).toBe(true);
  });

  it('refuses a document above the pixel cap before decoding it', async () => {
    const bytes = psd({ width: 40, height: 40, imageData: solid(40, 40, [0, 0, 0, 255]) });
    const outcomes = await psdGenerator.generate(
      { bytes, mimeType: 'image/vnd.adobe.photoshop' },
      [PREVIEW, { kind: 'psd_layers', pageNo: 0 }],
      { ...DEFAULT_PREVIEW_LIMITS, maxPixels: 1000 },
    );
    expect(outcomes).toEqual([
      { status: 'unsupported', code: 'unsupported_too_large' },
      { status: 'unsupported', code: 'unsupported_too_large' },
    ]);
  });

  it('fails a file that only looks like a PSD', async () => {
    // A valid 26-byte header (3 channels, 4 × 2, 8-bit RGB), then nothing that parses.
    const header = Buffer.alloc(26);
    header.write('8BPS', 0, 'latin1');
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(3, 12);
    header.writeUInt32BE(2, 14);
    header.writeUInt32BE(4, 18);
    header.writeUInt16BE(8, 22);
    header.writeUInt16BE(3, 24);
    const bytes = new Uint8Array(Buffer.concat([header, Buffer.alloc(8, 0xff)]));
    const outcomes = await psdGenerator.generate(
      { bytes, mimeType: 'image/vnd.adobe.photoshop' },
      [PREVIEW],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcomes[0]?.status).toBe('failed');
  });

  it('flattens with layer and group opacity, skipping hidden layers', () => {
    const image = flattenLayers({
      width: 1,
      height: 1,
      children: [
        {
          name: 'g',
          opacity: 0.5,
          children: [{ name: 'red', imageData: solid(1, 1, [255, 0, 0, 255]) }],
        },
        { name: 'hidden', hidden: true, imageData: solid(1, 1, [0, 255, 0, 255]) },
      ],
    } as never);
    expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 128]);
  });
});

describe('zipGenerator', () => {
  it('lists files and the folders they imply, with sizes and dates, nothing extracted', async () => {
    const bytes = zip([
      { path: 'Logos/atlas-logo-primary.svg', body: '<svg/>', deflate: true },
      { path: 'Logos/', body: '' },
      { path: 'Photography/lobby-01.jpg', body: 'x'.repeat(100), deflate: true },
      { path: '__MACOSX/Logos/._atlas-logo-primary.svg', body: 'junk' },
      { path: 'README.txt', body: 'hello' },
    ]);
    const [outcome] = await zipGenerator.generate(
      { bytes, mimeType: 'application/zip' },
      [{ kind: 'zip_manifest', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome?.status).toBe('ready');
    if (outcome?.status !== 'ready') return;
    expect(outcome.body).toBeNull();
    expect(outcome.meta).toMatchObject({
      fileCount: 3,
      folderCount: 2,
      totalBytes: 111,
      encrypted: false,
    });
    expect(outcome.meta?.['entries']).toEqual([
      { path: 'Logos/', folder: true, sizeBytes: 0, modifiedAt: null },
      {
        path: 'Logos/atlas-logo-primary.svg',
        folder: false,
        sizeBytes: 6,
        modifiedAt: '2026-10-28T14:05:00',
      },
      { path: 'Photography/', folder: true, sizeBytes: 0, modifiedAt: null },
      {
        path: 'Photography/lobby-01.jpg',
        folder: false,
        sizeBytes: 100,
        modifiedAt: '2026-10-28T14:05:00',
      },
      { path: 'README.txt', folder: false, sizeBytes: 5, modifiedAt: '2026-10-28T14:05:00' },
    ]);
  });

  it('refuses a ZIP bomb by its declared unpacked size, without inflating anything', async () => {
    const bytes = zip([
      { path: 'a.bin', body: 'a', declaredSize: 0xfffffff0 },
      { path: 'b.bin', body: 'b', declaredSize: 0xfffffff0 },
    ]);
    const [outcome] = await zipGenerator.generate(
      { bytes, mimeType: 'application/zip' },
      [{ kind: 'zip_manifest', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome).toEqual({ status: 'unsupported', code: 'unsupported_zip_bomb' });
  });

  it('refuses a ZIP with more entries than the cap', () => {
    process.env['PREVIEW_ZIP_MAX_ENTRIES'] = '2';
    const bytes = zip([{ path: 'a' }, { path: 'b' }, { path: 'c' }]);
    expect(() => zipFactsFrom(bytes)).toThrow(ZipReadError);
  });

  it('fails bytes that are not a ZIP', async () => {
    const [outcome] = await zipGenerator.generate(
      {
        bytes: new Uint8Array(Buffer.from('PK\u0003\u0004 not really a zip at all')),
        mimeType: 'application/zip',
      },
      [{ kind: 'zip_manifest', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome).toEqual({ status: 'failed', code: 'zip_unreadable' });
  });

  it('stops inflating a part at its ceiling', () => {
    const bytes = zip([
      { path: 'big.xml', body: 'a'.repeat(50_000), deflate: true, declaredSize: 10 },
    ]);
    const directory = readZipDirectory(bytes);
    expect(() => readZipPart(bytes, directory, 'big.xml', 1000)).toThrow(ZipReadError);
    expect(readZipPart(bytes, directory, 'missing.xml', 1000)).toBeNull();
  });
});

describe('officeMetaGenerator', () => {
  it('reads a PowerPoint slide size and count', async () => {
    const bytes = zip([
      {
        path: 'ppt/presentation.xml',
        deflate: true,
        body:
          '<p:presentation xmlns:p="p"><p:sldIdLst><p:sldId id="256" r:id="rId2"/>' +
          '<p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst>' +
          '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/></p:presentation>',
      },
    ]);
    const [outcome] = await officeMetaGenerator.generate(
      { bytes, mimeType: `${OOXML}.presentationml.presentation` },
      [{ kind: 'office_meta', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome?.status === 'ready' && outcome.meta).toEqual({
      format: 'pptx',
      pages: 3,
      pageWidth: 9_144_000,
      pageHeight: 6_858_000,
      sheets: [],
      approximate: true,
    });
  });

  it('reads a Word page size and the page count Word saved', () => {
    const bytes = zip([
      {
        path: 'word/document.xml',
        body: '<w:document><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:document>',
      },
      { path: 'docProps/app.xml', body: '<Properties><Pages>8</Pages></Properties>' },
    ]);
    expect(officeFactsFrom(bytes, `${OOXML}.wordprocessingml.document`)).toEqual({
      format: 'docx',
      pages: 8,
      pageWidth: 11906,
      pageHeight: 16838,
      sheets: [],
    });
  });

  it('reads Excel sheet names in order, hidden ones marked, entities decoded', () => {
    const bytes = zip([
      {
        path: 'xl/workbook.xml',
        body:
          '<workbook><sheets><sheet name="Rates" sheetId="1" r:id="rId1"/>' +
          '<sheet name="Seasons &amp; events" sheetId="2" r:id="rId2"/>' +
          '<sheet name="Old" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>',
      },
    ]);
    expect(officeFactsFrom(bytes, `${OOXML}.spreadsheetml.sheet`)?.sheets).toEqual([
      { name: 'Rates', hidden: false },
      { name: 'Seasons & events', hidden: false },
      { name: 'Old', hidden: true },
    ]);
  });

  it('fails a package without its main part', async () => {
    const [outcome] = await officeMetaGenerator.generate(
      {
        bytes: zip([{ path: 'other.xml', body: '<x/>' }]),
        mimeType: `${OOXML}.spreadsheetml.sheet`,
      },
      [{ kind: 'office_meta', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(outcome).toEqual({ status: 'failed', code: 'office_unreadable' });
  });
});

describe('epsGenerator', () => {
  it('draws the TIFF preview a DOS-EPS carries, and says it is the embedded one', async () => {
    const bytes = dosEps(tiff(solid(6, 3, [20, 120, 220, 255])));
    expect(embeddedTiff(bytes)).not.toBeNull();
    const outcomes = await epsGenerator.generate(
      { bytes, mimeType: 'application/postscript' },
      [PREVIEW, THUMB],
      DEFAULT_PREVIEW_LIMITS,
    );
    const preview = await readyImage(outcomes[0]);
    expect([preview.width, preview.height]).toEqual([6, 3]);
    expectColour(pixel(preview, 1, 1), [20, 120, 220]);
    expect(outcomes[0]?.status === 'ready' && outcomes[0].meta?.['embeddedPreview']).toBe(true);
    expect(outcomes[0]?.status === 'ready' && outcomes[0].followUps).toBeUndefined();
  });

  it('says there is no preview for plain PostScript or a DOS-EPS without a TIFF', async () => {
    const plain = new Uint8Array(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\nshowpage\n'));
    for (const bytes of [plain, dosEps(null)]) {
      const outcomes = await epsGenerator.generate(
        { bytes, mimeType: 'application/postscript' },
        [PREVIEW, THUMB],
        DEFAULT_PREVIEW_LIMITS,
      );
      expect(outcomes).toEqual([
        { status: 'unsupported', code: 'eps_no_preview' },
        { status: 'unsupported', code: 'eps_no_preview' },
      ]);
    }
  });
});
