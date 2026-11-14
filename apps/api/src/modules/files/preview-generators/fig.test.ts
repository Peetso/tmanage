import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { judgeArchiveDirectory, ZIP_FAMILY_TOKENS } from '../archive-inspection.js';
import { judgeContentType } from '../content-signature.js';
import { figViewFrom, viewerKindFor } from '../file-preview.service.js';
import type { FilePreview } from '../file-previews.repository.js';
import { pngCodec } from './codecs.js';
import {
  canvasChunks,
  decodeMessage,
  decodeSchema,
  FIG_CAPS,
  FigReadError,
  inflateChunk,
  OUTLINE_CAPS,
  OUTLINE_FIELDS,
  outlineOf,
  readCanvas,
} from './fig-kiwi.js';
import {
  FIG_MIME,
  figFactsFrom,
  figGenerator,
  MAX_THUMBNAIL_PIXELS,
  pngHeaderSize,
} from './fig.js';
import { decodeWebp } from './raster.js';
import { DEFAULT_PREVIEW_LIMITS } from './types.js';
import type { PreviewRequest } from './types.js';
import { readZipDirectory } from './zip-reader.js';
import { generatorFor, previewPlanFor } from './index.js';

/**
 * Peter, 2026-11-10 (FIGMA item 10) — a `.fig` upload: admitted as itself, inspected like any ZIP,
 * its saved picture shown, its pages and frames listed, and nothing drawn that the file does not
 * hold. Fixtures are built here: a small Kiwi encoder writes a schema and a document in the shape
 * Figma uses (checked by hand against four real files saved from Figma on this machine).
 */

// ── Kiwi writer ────────────────────────────────────────────────────────────

class Writer {
  readonly bytes: number[] = [];
  uint(value: number): void {
    let rest = value >>> 0;
    do {
      const byte = rest & 127;
      rest >>>= 7;
      this.bytes.push(rest ? byte | 128 : byte);
    } while (rest);
  }
  int(value: number): void {
    this.uint(value < 0 ? (~value << 1) | 1 : value << 1);
  }
  byte(value: number): void {
    this.bytes.push(value & 255);
  }
  string(value: string): void {
    this.bytes.push(...Buffer.from(value, 'utf8'), 0);
  }
  float(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    const bits = view.getUint32(0);
    if (bits === 0) {
      this.bytes.push(0);
      return;
    }
    const stored = ((bits >>> 23) | (bits << 9)) >>> 0;
    const out = Buffer.alloc(4);
    out.writeUInt32LE(stored);
    this.bytes.push(...out);
  }
}

type FieldSpec = readonly [name: string, type: number, array: boolean];
type DefSpec = readonly [name: string, kind: 0 | 1 | 2, fields: readonly FieldSpec[]];

// Indexes: 0 NodeType, 1 GUID, 2 ParentIndex, 3 Vector, 4 Matrix, 5 NodeChange, 6 Message.
const BOOL = -1;
const UINT = -4;
const FLOAT = -5;
const STRING = -6;
const DEFS: readonly DefSpec[] = [
  [
    'NodeType',
    0,
    ['DOCUMENT', 'CANVAS', 'FRAME', 'SECTION', 'TEXT', 'SYMBOL'].map((name) => [name, 0, false]),
  ],
  [
    'GUID',
    1,
    [
      ['sessionID', UINT, false],
      ['localID', UINT, false],
    ],
  ],
  [
    'ParentIndex',
    1,
    [
      ['guid', 1, false],
      ['position', STRING, false],
    ],
  ],
  [
    'Vector',
    1,
    [
      ['x', FLOAT, false],
      ['y', FLOAT, false],
    ],
  ],
  ['Matrix', 1, ['m00', 'm01', 'm02', 'm10', 'm11', 'm12'].map((name) => [name, FLOAT, false])],
  [
    'NodeChange',
    2,
    [
      ['guid', 1, false],
      ['parentIndex', 2, false],
      ['type', 0, false],
      ['name', STRING, false],
      ['visible', BOOL, false],
      ['size', 3, false],
      ['transform', 4, false],
      ['internalOnly', BOOL, false],
      // Stands for the fields the outline never reads (geometry, paints, text …).
      ['extra', 5, true],
    ],
  ],
  [
    'Message',
    2,
    [
      ['nodeChanges', 5, true],
      ['blobs', -2, true],
    ],
  ],
];
const NODE_TYPES = ['DOCUMENT', 'CANVAS', 'FRAME', 'SECTION', 'TEXT', 'SYMBOL'];

function schemaBytes(): Uint8Array {
  const writer = new Writer();
  writer.uint(DEFS.length);
  for (const [name, kind, fields] of DEFS) {
    writer.string(name);
    writer.byte(kind);
    writer.uint(fields.length);
    fields.forEach(([fieldName, type, array], index) => {
      writer.string(fieldName);
      writer.int(type);
      writer.byte(array ? 1 : 0);
      writer.uint(kind === 0 ? index : index + 1);
    });
  }
  return new Uint8Array(writer.bytes);
}

interface NodeSpec {
  readonly id: number;
  readonly parent?: number;
  readonly position?: string;
  readonly type: string;
  readonly name: string;
  readonly visible?: boolean;
  readonly size?: readonly [number, number];
  readonly at?: readonly [number, number];
  readonly internalOnly?: boolean;
  /** This many empty messages in a field the outline does not read. */
  readonly extra?: number;
}

function guid(writer: Writer, id: number): void {
  writer.uint(0);
  writer.uint(id);
}

function documentBytes(nodes: readonly NodeSpec[]): Uint8Array {
  const writer = new Writer();
  writer.uint(1); // nodeChanges
  writer.uint(nodes.length);
  for (const node of nodes) {
    writer.uint(1);
    guid(writer, node.id);
    if (node.parent !== undefined) {
      writer.uint(2);
      guid(writer, node.parent);
      writer.string(node.position ?? '!');
    }
    writer.uint(3);
    writer.uint(NODE_TYPES.indexOf(node.type));
    writer.uint(4);
    writer.string(node.name);
    writer.uint(5);
    writer.byte(node.visible === false ? 0 : 1);
    if (node.size) {
      writer.uint(6);
      writer.float(node.size[0]);
      writer.float(node.size[1]);
    }
    if (node.at) {
      writer.uint(7);
      [1, 0, node.at[0], 0, 1, node.at[1]].forEach((value) => writer.float(value));
    }
    if (node.internalOnly) {
      writer.uint(8);
      writer.byte(1);
    }
    if (node.extra) {
      writer.uint(9);
      writer.uint(node.extra);
      for (let index = 0; index < node.extra; index += 1) writer.uint(0);
    }
    writer.uint(0);
  }
  writer.uint(2); // blobs: one empty byte array
  writer.uint(1);
  writer.uint(0);
  writer.uint(0);
  writer.uint(0);
  return new Uint8Array(writer.bytes);
}

function canvasFig(nodes: readonly NodeSpec[]): Uint8Array {
  const parts = [schemaBytes(), documentBytes(nodes)].map((part) => deflateRawSync(part));
  const head = Buffer.alloc(12);
  head.write('fig-kiwi', 0, 'latin1');
  head.writeUInt32LE(52, 8);
  const framed = parts.flatMap((part) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(part.length);
    return [length, part];
  });
  return new Uint8Array(Buffer.concat([head, ...framed]));
}

const FILE: readonly NodeSpec[] = [
  { id: 0, type: 'DOCUMENT', name: 'Document' },
  { id: 1, parent: 0, position: 'a', type: 'CANVAS', name: 'Mobile' },
  {
    id: 2,
    parent: 0,
    position: 'b',
    type: 'CANVAS',
    name: 'Internal Only Canvas',
    internalOnly: true,
  },
  { id: 3, parent: 0, position: 'c', type: 'CANVAS', name: 'Desktop‮' },
  { id: 10, parent: 1, position: 'b', type: 'FRAME', name: 'Home', size: [390, 844], at: [500, 0] },
  { id: 11, parent: 1, position: 'a', type: 'FRAME', name: 'Login', size: [390, 844], at: [0, 0] },
  { id: 12, parent: 1, position: 'c', type: 'SECTION', name: 'Checkout', at: [1000, 100] },
  {
    id: 13,
    parent: 12,
    position: 'a',
    type: 'FRAME',
    name: 'Cart',
    size: [390, 900],
    at: [20, 30],
  },
  { id: 14, parent: 1, position: 'd', type: 'TEXT', name: 'A note' },
  { id: 15, parent: 1, position: 'e', type: 'FRAME', name: 'Hidden', visible: false },
  { id: 20, parent: 3, position: 'a', type: 'SYMBOL', name: 'Button', size: [120, 40], at: [0, 0] },
];

// ── ZIP writer (binary bodies) ─────────────────────────────────────────────

function zip(files: readonly { readonly path: string; readonly body: Uint8Array }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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

function png(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 0);
  for (let at = 0; at < data.length; at += 4) data.set([30, 120, 220, 255], at);
  return new Uint8Array(pngCodec().PNG.sync.write({ width, height, data }));
}

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

function figFile(
  options: { readonly canvas?: Uint8Array; readonly thumbnail?: Uint8Array | null } = {},
) {
  return zip([
    { path: 'canvas.fig', body: options.canvas ?? canvasFig(FILE) },
    ...(options.thumbnail === null
      ? []
      : [{ path: 'thumbnail.png', body: options.thumbnail ?? png(400, 225) }]),
    { path: 'meta.json', body: utf8('{"file_name":"Atlas app","client_meta":{}}') },
    { path: 'images/', body: new Uint8Array() },
    { path: 'images/efc359123fcbda50070f638a6c7d67ea6682f503', body: png(2, 2) },
  ]);
}

const PREVIEW: PreviewRequest = { kind: 'preview', pageNo: 0 };
const THUMB: PreviewRequest = { kind: 'thumb', pageNo: 0 };
const OUTLINE: PreviewRequest = { kind: 'fig_outline', pageNo: 0 };

describe('.fig upload is admitted as itself (FIGMA item 10)', () => {
  it('a ZIP declared as a Figma file passes; anything else declared as one does not', () => {
    const head = Buffer.from(figFile().subarray(0, 64));
    expect(judgeContentType(FIG_MIME, head, { ok: () => false })).toMatchObject({
      ok: true,
      detectedMimeType: FIG_MIME,
      detectedType: 'fig',
    });
    const pdf = Buffer.from('%PDF-1.7\n', 'latin1');
    expect(judgeContentType(FIG_MIME, pdf, { ok: () => false })).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
  });

  it('its directory goes through the archive inspection, so a program inside is refused', () => {
    expect(ZIP_FAMILY_TOKENS.has('fig')).toBe(true);
    const clean = readZipDirectory(figFile());
    expect(judgeArchiveDirectory(clean, { channel: 'client', officeOpenXml: false })).toBeNull();
    const planted = readZipDirectory(
      zip([
        { path: 'canvas.fig', body: canvasFig(FILE) },
        { path: 'images/run.exe', body: utf8('MZ') },
      ]),
    );
    expect(
      judgeArchiveDirectory(planted, { channel: 'member', officeOpenXml: false }),
    ).toMatchObject({ code: 'archive_contains_blocked' });
  });

  it('the viewer kind and the preview plan', () => {
    expect(viewerKindFor(FIG_MIME)).toBe('fig');
    expect(generatorFor(FIG_MIME)).toBe(figGenerator);
    expect(previewPlanFor(FIG_MIME)).toEqual([
      { kind: 'preview' },
      { kind: 'thumb' },
      { kind: 'fig_outline' },
    ]);
  });
});

describe('the Kiwi decoder and the outline', () => {
  it('lists the pages (internal canvas left out) and their frames in Figma order', () => {
    const outline = outlineOf(readCanvas(canvasFig(FILE)));
    expect(outline.pages.map((page) => page.name)).toEqual(['Mobile', 'Desktop']);
    expect(outline.pages[0]?.frames).toEqual([
      { name: 'Login', width: 390, height: 844, x: 0, y: 0, section: null },
      { name: 'Home', width: 390, height: 844, x: 500, y: 0, section: null },
      { name: 'Cart', width: 390, height: 900, x: 1020, y: 130, section: 'Checkout' },
    ]);
    expect(outline.pages[1]?.frames.map((frame) => frame.name)).toEqual(['Button']);
    expect(outline).toMatchObject({ frameCount: 4, truncated: false });
  });

  it('caps the frames listed and says so', () => {
    const outline = outlineOf(readCanvas(canvasFig(FILE)), {
      maxPages: 200,
      maxFrames: 2,
      maxSectionDepth: 4,
    });
    expect(outline.pages.flatMap((page) => page.frames)).toHaveLength(2);
    expect(outline.pages[0]?.frameCount).toBe(3);
    expect(outline.truncated).toBe(true);
  });

  it('fails closed on a file that is not fig-kiwi, a lying array, or a bomb', () => {
    expect(() => canvasChunks(utf8('not a canvas file'))).toThrow(FigReadError);
    const definitions = decodeSchema(schemaBytes());
    // nodeChanges claims a million items in a five-byte body.
    expect(() =>
      decodeMessage(definitions, new Uint8Array([1, 0xc0, 0x84, 0x3d, 0]), 'Message'),
    ).toThrow(FigReadError);
    expect(() => readCanvas(canvasFig(FILE), { ...FIG_CAPS, maxDocumentBytes: 16 })).toThrow(
      expect.objectContaining({ code: 'fig_too_large' }),
    );
    expect(() => readCanvas(canvasFig(FILE), { ...FIG_CAPS, maxSteps: 10 })).toThrow(
      expect.objectContaining({ code: 'fig_too_large' }),
    );
  });
});

describe('hostile .fig files (security review 2026-11-14)', () => {
  it('H1: sections that all claim the page as parent and as themselves are walked once', () => {
    // 30 sections share the page's own guid: each would list all 30 again, 4 levels deep
    // (30^4 = 810 000 visits). Walked once each, the page lists its one real frame.
    const hostile: NodeSpec[] = [
      { id: 0, type: 'DOCUMENT', name: 'Document' },
      { id: 1, parent: 0, type: 'CANVAS', name: 'Page' },
      ...Array.from({ length: 30 }, (): NodeSpec => ({
        id: 1,
        parent: 1,
        type: 'SECTION',
        name: 'Loop',
      })),
      { id: 50, parent: 1, position: 'z', type: 'FRAME', name: 'Real', size: [10, 10], at: [0, 0] },
    ];
    const started = Date.now();
    const outline = outlineOf(readCanvas(canvasFig(hostile)));
    expect(outline.pages[0]?.frames.map((frame) => frame.name)).toEqual(['Real']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('H1: the walk has a hard budget and refuses past it', () => {
    const many: NodeSpec[] = [
      { id: 0, type: 'DOCUMENT', name: 'Document' },
      { id: 1, parent: 0, type: 'CANVAS', name: 'Page' },
      ...Array.from({ length: 50 }, (_, index): NodeSpec => ({
        id: 100 + index,
        parent: 1,
        type: 'FRAME',
        name: `F${index}`,
      })),
    ];
    expect(() =>
      outlineOf(readCanvas(canvasFig(many)), { ...OUTLINE_CAPS, maxVisits: 10 }),
    ).toThrow(expect.objectContaining({ code: 'fig_too_large' }));
  });

  it('H2: empty messages in a field the outline does not read build nothing', () => {
    // 20 000 empty messages cost 20 000 input bytes; built, each would be an object.
    const bloated: NodeSpec[] = [
      { id: 0, type: 'DOCUMENT', name: 'Document' },
      { id: 1, parent: 0, type: 'CANVAS', name: 'Page', extra: 20_000 },
    ];
    const caps = { ...FIG_CAPS, maxObjects: 1000 };
    expect(readCanvas(canvasFig(bloated), caps)).toMatchObject({ nodeChanges: expect.any(Array) });
    // Read with every field kept, the same file is refused at the object cap.
    const [schema, document] = canvasChunks(canvasFig(bloated)).map((chunk) =>
      inflateChunk(chunk, FIG_CAPS.maxDocumentBytes),
    );
    expect(() => decodeMessage(decodeSchema(schema!), document!, 'Message', caps)).toThrow(
      expect.objectContaining({ code: 'fig_too_large' }),
    );
  });

  it('H2: the caps are what a page list needs', () => {
    expect(FIG_CAPS.maxDocumentBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(FIG_CAPS.maxSchemaBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(FIG_CAPS.maxObjects).toBeLessThanOrEqual(1_000_000);
    expect(OUTLINE_FIELDS['Message']).toEqual(new Set(['nodeChanges']));
  });

  it('M3: a saved picture whose header claims 20 000 x 20 000 is refused before decoding', async () => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    ihdr.writeUInt32BE(20_000, 8);
    ihdr.writeUInt32BE(20_000, 12);
    ihdr.set([8, 6, 0, 0, 0], 16);
    const huge = new Uint8Array(
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]),
    );
    expect(pngHeaderSize(huge)).toEqual({ width: 20_000, height: 20_000 });
    const [preview] = await figGenerator.generate(
      { bytes: figFile({ thumbnail: huge }), mimeType: FIG_MIME },
      [PREVIEW],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(preview).toEqual({ status: 'unsupported', code: 'unsupported_too_large' });
    expect(MAX_THUMBNAIL_PIXELS).toBeLessThanOrEqual(16_000_000);
  });

  it('L1: a ZIP named .fig without canvas.fig is not a Figma file', () => {
    const plain = readZipDirectory(zip([{ path: 'notes.txt', body: utf8('hi') }]));
    expect(
      judgeArchiveDirectory(plain, { channel: 'member', officeOpenXml: false, figmaFile: true }),
    ).toMatchObject({ code: 'archive_unreadable' });
    expect(judgeArchiveDirectory(plain, { channel: 'member', officeOpenXml: false })).toBeNull();
    const real = readZipDirectory(figFile());
    expect(
      judgeArchiveDirectory(real, { channel: 'member', officeOpenXml: false, figmaFile: true }),
    ).toBeNull();
  });
});

describe('figGenerator', () => {
  it('shows the picture saved in the file and lists its pages, marked as the saved preview', async () => {
    const [preview, thumb, outline] = await figGenerator.generate(
      { bytes: figFile(), mimeType: FIG_MIME },
      [PREVIEW, THUMB, OUTLINE],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(preview).toMatchObject({ status: 'ready', meta: { embeddedPreview: true } });
    if (preview?.status !== 'ready' || preview.body === null) throw new Error('no preview');
    const image = await decodeWebp(preview.body);
    expect([image.width, image.height]).toEqual([400, 225]);
    expect(thumb).toMatchObject({ status: 'ready', width: 320 });
    expect(outline).toMatchObject({
      status: 'ready',
      body: null,
      meta: { fileName: 'Atlas app', frameCount: 4 },
    });
  });

  it('a file without a saved picture still lists its pages; a broken canvas fails only the list', async () => {
    const answers = await figGenerator.generate(
      { bytes: figFile({ thumbnail: null }), mimeType: FIG_MIME },
      [PREVIEW, OUTLINE],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(answers.map((answer) => answer.status)).toEqual(['unsupported', 'ready']);
    const broken = await figGenerator.generate(
      { bytes: figFile({ canvas: utf8('fig-kiwi....garbage') }), mimeType: FIG_MIME },
      [PREVIEW, OUTLINE],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(broken.map((answer) => answer.status)).toEqual(['ready', 'failed']);
  });

  it('a file that is not a ZIP fails every row', async () => {
    const answers = await figGenerator.generate(
      { bytes: utf8('PK\u0003\u0004 truncated'), mimeType: FIG_MIME },
      [PREVIEW, OUTLINE],
      DEFAULT_PREVIEW_LIMITS,
    );
    expect(answers.map((answer) => answer.status)).toEqual(['failed', 'failed']);
  });

  it('figFactsFrom reads the saved name', () => {
    const bytes = figFile();
    expect(figFactsFrom(bytes, readZipDirectory(bytes)).fileName).toBe('Atlas app');
  });
});

describe('figViewFrom (the manifest block)', () => {
  it('reads the stored list defensively', () => {
    const row = {
      kind: 'fig_outline',
      status: 'ready',
      meta: {
        fileName: 'Atlas',
        frameCount: 2,
        truncated: false,
        pages: [
          {
            name: 'Mobile',
            frameCount: 2,
            frames: [{ name: 'Home', width: 390.4, height: 844, x: 0, y: 0, section: null }, 'x'],
          },
          null,
        ],
      },
    } as unknown as FilePreview;
    expect(figViewFrom([row])).toEqual({
      fileName: 'Atlas',
      frameCount: 2,
      truncated: false,
      pages: [
        {
          name: 'Mobile',
          frameCount: 2,
          frames: [{ name: 'Home', width: 390, height: 844, x: 0, y: 0, section: null }],
        },
      ],
    });
    expect(figViewFrom([])).toBeNull();
  });
});
