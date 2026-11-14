import { inflateRawSync } from 'node:zlib';
import * as zlib from 'node:zlib';

/**
 * Peter, 2026-11-10 (FIGMA item 10) — what a `.fig` file says about itself, read without drawing.
 *
 * A file saved from Figma ("Save local copy") is a ZIP holding `canvas.fig`, `thumbnail.png` (the
 * small picture Figma draws of the first page), `meta.json` and the file's images. `canvas.fig`
 * is `fig-kiwi`, a version number, then length-prefixed chunks: chunk 1 is the Kiwi schema, chunk
 * 2 the document (`nodeChanges`), each deflated (newer files: zstd). Kiwi is Figma's open binary
 * format (github.com/evanw/kiwi); this is a small, bounded decoder of it, enough to list the
 * pages and the frames on them. Nothing here renders a frame: drawing one faithfully needs Figma's
 * own renderer (vector networks, text layout, effects), and a half-drawn frame would mislead a
 * client. Every count, length and depth is capped; anything outside the caps or the format throws
 * {@link FigReadError} and the caller fails closed.
 */

export class FigReadError extends Error {
  constructor(readonly code: 'fig_unreadable' | 'fig_too_large') {
    super(code);
    this.name = 'FigReadError';
  }
}

export interface FigCaps {
  /** Inflated schema chunk. */
  readonly maxSchemaBytes: number;
  /** Inflated document chunk. */
  readonly maxDocumentBytes: number;
  /** Definitions in the schema. */
  readonly maxDefinitions: number;
  /** Items in one array (nodes, paints, blobs …). */
  readonly maxArrayItems: number;
  /** Message nesting. */
  readonly maxDepth: number;
  /**
   * Objects built in all (messages and structs kept for the outline). This bounds the memory a
   * hostile file can make the decoder allocate: an empty message costs one input byte.
   */
  readonly maxObjects: number;
  /** Values read or skipped in all (bounds the time a hostile file can take). */
  readonly maxSteps: number;
  /**
   * Re-check of the security review (H2, 2026-11-14): values kept in all, every list item and
   * every number included. An item of a number list costs one input byte, so without this a
   * crafted file could make the decoder hold tens of millions of numbers.
   */
  readonly maxKeptItems: number;
  /** Bytes of text kept in all (names and other kept strings). */
  readonly maxKeptTextBytes: number;
  /** Bytes kept of any one string; a longer one is cut (a name is shown at 200 characters). */
  readonly maxStringBytes: number;
}

/**
 * Security review H2 (2026-11-14): the caps are what a page list needs, not what any file might
 * hold. Six real files saved from Figma (2-49 MB) list in under 200 ms each; the caps leave room
 * for a large file and stop a crafted one in about a second and a bounded amount of memory.
 */
export const FIG_CAPS: FigCaps = {
  maxSchemaBytes: 1024 * 1024,
  maxDocumentBytes: 64 * 1024 * 1024,
  maxDefinitions: 4000,
  maxArrayItems: 1_000_000,
  maxDepth: 64,
  maxObjects: 1_000_000,
  maxSteps: 10_000_000,
  maxKeptItems: 2_000_000,
  maxKeptTextBytes: 4 * 1024 * 1024,
  maxStringBytes: 1024,
};

/**
 * The fields the outline reads, per message. Every other field is skipped without building
 * anything (images, vector geometry, text, effects ...).
 */
export const OUTLINE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Message: new Set(['nodeChanges']),
  NodeChange: new Set([
    'guid',
    'parentIndex',
    'type',
    'name',
    'visible',
    'size',
    'transform',
    'internalOnly',
  ]),
};

const MAGIC = 'fig-kiwi';
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

type Kind = 'enum' | 'struct' | 'message';

interface FieldDef {
  readonly name: string;
  /** < 0: a primitive (−1 bool … −8 uint64); ≥ 0: a definition index. */
  readonly type: number;
  readonly array: boolean;
  readonly value: number;
}

interface Definition {
  readonly name: string;
  readonly kind: Kind;
  readonly fields: readonly FieldDef[];
}

/** A decoded Kiwi value. Byte arrays stay bytes; enums are their names. */
export type KiwiValue =
  | boolean
  | number
  | string
  | Uint8Array
  | readonly KiwiValue[]
  | { readonly [key: string]: KiwiValue };

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw new FigReadError('fig_unreadable');
    const value = this.bytes[this.offset] as number;
    this.offset += 1;
    return value;
  }

  /** A varint up to 32 bits (Kiwi `uint`). */
  uint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      result += (byte & 127) * 2 ** shift;
      shift += 7;
      if ((byte & 128) === 0 || shift >= 35) return result >>> 0;
    }
  }

  /** A varint up to 64 bits, kept as a number (precision past 2^53 does not matter here). */
  uint64(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      result += (byte & 127) * 2 ** shift;
      shift += 7;
      if ((byte & 128) === 0) return result;
      if (shift >= 70) throw new FigReadError('fig_unreadable');
    }
  }

  int(): number {
    const value = this.uint();
    return value & 1 ? ~(value >>> 1) : value >>> 1;
  }

  int64(): number {
    const value = this.uint64();
    return value % 2 === 1 ? -((value + 1) / 2) : value / 2;
  }

  float(): number {
    if (this.offset >= this.bytes.length) throw new FigReadError('fig_unreadable');
    if (this.bytes[this.offset] === 0) {
      this.offset += 1;
      return 0;
    }
    if (this.offset + 4 > this.bytes.length) throw new FigReadError('fig_unreadable');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const stored = view.getUint32(0, true);
    this.offset += 4;
    const bits = ((stored << 23) | (stored >>> 9)) >>> 0;
    const out = new DataView(new ArrayBuffer(4));
    out.setUint32(0, bits);
    return out.getFloat32(0);
  }

  /**
   * A zero-terminated string. Only its first `maxBytes` are decoded (cut back to a whole UTF-8
   * character); the rest is passed over. `kept` is the number of bytes decoded.
   */
  string(maxBytes = Number.POSITIVE_INFINITY): { readonly text: string; readonly kept: number } {
    const end = this.bytes.indexOf(0, this.offset);
    if (end === -1) throw new FigReadError('fig_unreadable');
    let cut = Math.min(end, this.offset + maxBytes);
    while (cut < end && cut > this.offset && ((this.bytes[cut] as number) & 0xc0) === 0x80) {
      cut -= 1;
    }
    const text = utf8.decode(this.bytes.subarray(this.offset, cut));
    const kept = cut - this.offset;
    this.offset = end + 1;
    return { text, kept };
  }

  /** Passes over a zero-terminated string without decoding it. */
  skipString(): void {
    const end = this.bytes.indexOf(0, this.offset);
    if (end === -1) throw new FigReadError('fig_unreadable');
    this.offset = end + 1;
  }

  take(length: number): Uint8Array {
    if (length > this.remaining) throw new FigReadError('fig_unreadable');
    const part = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return part;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

const KINDS: readonly Kind[] = ['enum', 'struct', 'message'];

export function decodeSchema(bytes: Uint8Array, caps: FigCaps = FIG_CAPS): Definition[] {
  const reader = new Reader(bytes);
  const count = reader.uint();
  if (count > caps.maxDefinitions) throw new FigReadError('fig_too_large');
  const definitions: Definition[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = reader.string(256).text;
    const kind = KINDS[reader.byte()];
    if (!kind) throw new FigReadError('fig_unreadable');
    const fieldCount = reader.uint();
    if (fieldCount > reader.remaining) throw new FigReadError('fig_unreadable');
    const fields: FieldDef[] = [];
    for (let at = 0; at < fieldCount; at += 1) {
      const fieldName = reader.string(256).text;
      const type = reader.int();
      const array = (reader.byte() & 1) === 1;
      const value = reader.uint();
      if (type < -8 || type >= count) throw new FigReadError('fig_unreadable');
      fields.push({ name: fieldName, type, array, value });
    }
    definitions.push({ name, kind, fields });
  }
  return definitions;
}

/** Decodes `root` (a message) from `bytes` with `definitions`. */
export function decodeMessage(
  definitions: readonly Definition[],
  bytes: Uint8Array,
  root: string,
  caps: FigCaps = FIG_CAPS,
  /** Per message name, the fields to build; other fields are skipped. `null`: build all. */
  keep: Readonly<Record<string, ReadonlySet<string>>> | null = null,
): { readonly [key: string]: KiwiValue } {
  const reader = new Reader(bytes);
  const rootIndex = definitions.findIndex((definition) => definition.name === root);
  if (rootIndex === -1 || definitions[rootIndex]?.kind !== 'message') {
    throw new FigReadError('fig_unreadable');
  }
  const byValue = definitions.map(
    (definition) => new Map(definition.fields.map((field) => [field.value, field])),
  );
  let steps = 0;
  let objects = 0;
  let kept = 0;
  let textBytes = 0;
  const step = () => {
    steps += 1;
    if (steps > caps.maxSteps) throw new FigReadError('fig_too_large');
  };
  const built = () => {
    objects += 1;
    if (objects > caps.maxObjects) throw new FigReadError('fig_too_large');
  };

  /** Reads past one value without building it. */
  const skip = (type: number, depth: number): void => {
    step();
    switch (type) {
      case -1:
      case -2:
        reader.byte();
        return;
      case -3:
      case -4:
        reader.uint();
        return;
      case -5:
        reader.float();
        return;
      case -6:
        reader.skipString();
        return;
      case -7:
      case -8:
        reader.uint64();
        return;
      default:
        break;
    }
    const definition = definitions[type];
    if (!definition) throw new FigReadError('fig_unreadable');
    if (depth > caps.maxDepth) throw new FigReadError('fig_too_large');
    if (definition.kind === 'enum') {
      reader.uint();
      return;
    }
    if (definition.kind === 'struct') {
      for (const field of definition.fields) skipField(field, depth + 1);
      return;
    }
    const fields = byValue[type];
    if (!fields) throw new FigReadError('fig_unreadable');
    for (;;) {
      const tag = reader.uint();
      if (tag === 0) return;
      const field = fields.get(tag);
      if (!field) throw new FigReadError('fig_unreadable');
      skipField(field, depth + 1);
    }
  };

  const skipField = (field: FieldDef, depth: number): void => {
    if (!field.array) {
      skip(field.type, depth);
      return;
    }
    const length = reader.uint();
    if (field.type === -2) {
      reader.take(length);
      return;
    }
    if (length > caps.maxArrayItems || length > reader.remaining) {
      throw new FigReadError(length > caps.maxArrayItems ? 'fig_too_large' : 'fig_unreadable');
    }
    for (let index = 0; index < length; index += 1) skip(field.type, depth);
  };

  const value = (type: number, depth: number): KiwiValue => {
    step();
    kept += 1;
    if (kept > caps.maxKeptItems) throw new FigReadError('fig_too_large');
    switch (type) {
      case -1:
        return reader.byte() !== 0;
      case -2:
        return reader.byte();
      case -3:
        return reader.int();
      case -4:
        return reader.uint();
      case -5:
        return reader.float();
      case -6: {
        const { text, kept: bytes } = reader.string(caps.maxStringBytes);
        textBytes += bytes;
        if (textBytes > caps.maxKeptTextBytes) throw new FigReadError('fig_too_large');
        return text;
      }
      case -7:
        return reader.int64();
      case -8:
        return reader.uint64();
      default:
        break;
    }
    const definition = definitions[type];
    if (!definition) throw new FigReadError('fig_unreadable');
    if (depth > caps.maxDepth) throw new FigReadError('fig_too_large');
    if (definition.kind === 'enum') {
      const raw = reader.uint();
      return definition.fields.find((field) => field.value === raw)?.name ?? raw;
    }
    built();
    const out: Record<string, KiwiValue> = {};
    if (definition.kind === 'struct') {
      for (const field of definition.fields) out[field.name] = fieldValue(field, depth + 1);
      return out;
    }
    const fields = byValue[type];
    if (!fields) throw new FigReadError('fig_unreadable');
    const wanted = keep ? keep[definition.name] : undefined;
    for (;;) {
      const tag = reader.uint();
      if (tag === 0) return out;
      const field = fields.get(tag);
      if (!field) throw new FigReadError('fig_unreadable');
      if (keep && !wanted?.has(field.name)) skipField(field, depth + 1);
      else out[field.name] = fieldValue(field, depth + 1);
    }
  };

  const fieldValue = (field: FieldDef, depth: number): KiwiValue => {
    if (!field.array) return value(field.type, depth);
    const length = reader.uint();
    if (field.type === -2) return reader.take(length);
    // Every item takes at least one byte: a longer count is a lie.
    if (length > caps.maxArrayItems || length > reader.remaining) {
      throw new FigReadError(length > caps.maxArrayItems ? 'fig_too_large' : 'fig_unreadable');
    }
    const items: KiwiValue[] = [];
    for (let index = 0; index < length; index += 1) items.push(value(field.type, depth));
    return items;
  };

  const result = value(rootIndex, 0);
  if (!isNode(result)) throw new FigReadError('fig_unreadable');
  return result;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** One chunk, inflated, at most `maxBytes` long. */
export function inflateChunk(chunk: Uint8Array, maxBytes: number): Uint8Array {
  try {
    if (startsWith(chunk, ZSTD_MAGIC)) {
      // Node 22.15 and later; an older runtime cannot read the newer files.
      if (typeof zlib.zstdDecompressSync !== 'function') throw new FigReadError('fig_unreadable');
      return zlib.zstdDecompressSync(chunk, { maxOutputLength: maxBytes });
    }
    return inflateRawSync(chunk, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof FigReadError) throw error;
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new FigReadError('fig_too_large');
    throw new FigReadError('fig_unreadable');
  }
}

/** The chunks of a `canvas.fig` (`fig-kiwi`, version, then length-prefixed parts). */
export function canvasChunks(canvas: Uint8Array): Uint8Array[] {
  if (canvas.length < 12 || utf8.decode(canvas.subarray(0, 8)) !== MAGIC) {
    throw new FigReadError('fig_unreadable');
  }
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  // Only the schema and the document: any later chunk is never read or inflated.
  while (offset + 4 <= canvas.length && chunks.length < 2) {
    const length = view.getUint32(offset, true);
    const start = offset + 4;
    if (start + length > canvas.length) throw new FigReadError('fig_unreadable');
    chunks.push(canvas.subarray(start, start + length));
    offset = start + length;
  }
  if (chunks.length < 2) throw new FigReadError('fig_unreadable');
  return chunks;
}

/** The decoded document (`Message`) of a `canvas.fig`. */
export function readCanvas(
  canvas: Uint8Array,
  caps: FigCaps = FIG_CAPS,
): { readonly [key: string]: KiwiValue } {
  const [schemaChunk, documentChunk] = canvasChunks(canvas);
  if (!schemaChunk || !documentChunk) throw new FigReadError('fig_unreadable');
  const definitions = decodeSchema(inflateChunk(schemaChunk, caps.maxSchemaBytes), caps);
  return decodeMessage(
    definitions,
    inflateChunk(documentChunk, caps.maxDocumentBytes),
    'Message',
    caps,
    OUTLINE_FIELDS,
  );
}

// ── The outline: pages and the frames on them ─────────────────────────────

export interface FigOutlineFrame {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  /** The section the frame sits in, when there is one. */
  readonly section: string | null;
}

export interface FigOutlinePage {
  readonly name: string;
  /** Every frame on the page, even past the listed ones. */
  readonly frameCount: number;
  readonly frames: readonly FigOutlineFrame[];
}

export interface FigOutline {
  readonly pages: readonly FigOutlinePage[];
  readonly frameCount: number;
  /** More pages or frames than are listed. */
  readonly truncated: boolean;
}

export interface OutlineCaps {
  readonly maxPages: number;
  readonly maxFrames: number;
  readonly maxSectionDepth: number;
  /** Nodes looked at in all while walking pages and sections (fail closed past it). */
  readonly maxVisits: number;
}

export const OUTLINE_CAPS: OutlineCaps = {
  maxPages: 200,
  maxFrames: 2000,
  maxSectionDepth: 4,
  maxVisits: 200_000,
};

/** Node types listed as frames (Kiwi spelling: a component is `SYMBOL`). */
const FRAME_TYPES: ReadonlySet<string> = new Set(['FRAME', 'SYMBOL', 'INSTANCE']);

type Node = { readonly [key: string]: KiwiValue };

function isNode(value: KiwiValue | undefined): value is { readonly [key: string]: KiwiValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function guidKey(value: KiwiValue | undefined): string | null {
  if (!isNode(value)) return null;
  const session = value['sessionID'];
  const local = value['localID'];
  return typeof session === 'number' && typeof local === 'number' ? `${session}:${local}` : null;
}

function numberOf(node: Node | undefined, key: string): number {
  const value = node?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Bidi and control characters are dropped; long names are cut. */
export function cleanName(value: KiwiValue | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '')
    .trim()
    .slice(0, 200);
  return clean === '' ? fallback : clean;
}

/** The pages (internal canvases left out) and their frames, in Figma's order. */
export function outlineOf(
  document: { readonly [key: string]: KiwiValue },
  caps: OutlineCaps = OUTLINE_CAPS,
): FigOutline {
  const raw = document['nodeChanges'];
  const nodes = Array.isArray(raw) ? raw.filter(isNode) : [];
  const children = new Map<string, { readonly node: Node; readonly position: string }[]>();
  for (const node of nodes) {
    const parent = node['parentIndex'];
    if (!isNode(parent)) continue;
    const parentKey = guidKey(parent['guid']);
    if (!parentKey) continue;
    const position = typeof parent['position'] === 'string' ? parent['position'] : '';
    const list = children.get(parentKey) ?? [];
    list.push({ node, position });
    children.set(parentKey, list);
  }
  // Security review H1 (2026-11-14): each parent's children are sorted once.
  const sorted = new Map<string, Node[]>();
  const ordered = (key: string | null): Node[] => {
    if (key === null) return [];
    const cached = sorted.get(key);
    if (cached) return cached;
    const list = [...(children.get(key) ?? [])]
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
      .map((entry) => entry.node);
    sorted.set(key, list);
    return list;
  };
  // Security review H1: a page or section is walked at most once, whatever its guid claims (a
  // crafted file can give many sections one guid, or a node its parent's guid), and the walk has a
  // hard budget. Past it the file is refused, never half-listed.
  const walked = new Set<string>();
  let visits = 0;
  const visit = () => {
    visits += 1;
    if (visits > caps.maxVisits) throw new FigReadError('fig_too_large');
  };

  const document_ = nodes.find((node) => node['type'] === 'DOCUMENT');
  const canvases = (
    document_
      ? ordered(guidKey(document_['guid']))
      : nodes.filter((node) => node['type'] === 'CANVAS')
  ).filter((node) => {
    if (node['type'] !== 'CANVAS' || node['internalOnly'] === true) return false;
    const key = guidKey(node['guid']);
    if (key === null || walked.has(key)) return false;
    walked.add(key);
    return true;
  });

  let listed = 0;
  let total = 0;
  let truncated = canvases.length > caps.maxPages;
  const pages: FigOutlinePage[] = [];
  for (const [index, canvas] of canvases.slice(0, caps.maxPages).entries()) {
    const frames: FigOutlineFrame[] = [];
    let frameCount = 0;
    const walk = (
      parent: Node,
      section: string | null,
      offsetX: number,
      offsetY: number,
      depth: number,
    ) => {
      const parentKey = guidKey(parent['guid']);
      for (const node of ordered(parentKey)) {
        visit();
        if (node['visible'] === false) continue;
        const transform = isNode(node['transform']) ? node['transform'] : undefined;
        const x = offsetX + numberOf(transform, 'm02');
        const y = offsetY + numberOf(transform, 'm12');
        const type = node['type'];
        if (type === 'SECTION') {
          const key = guidKey(node['guid']);
          if (key === null || key === parentKey || walked.has(key)) continue;
          walked.add(key);
          if (depth < caps.maxSectionDepth) {
            walk(node, cleanName(node['name'], 'Section'), x, y, depth + 1);
          }
          continue;
        }
        if (typeof type !== 'string' || !FRAME_TYPES.has(type)) continue;
        frameCount += 1;
        if (listed >= caps.maxFrames) {
          truncated = true;
          continue;
        }
        const size = isNode(node['size']) ? node['size'] : undefined;
        frames.push({
          name: cleanName(node['name'], 'Frame'),
          width: Math.round(numberOf(size, 'x')),
          height: Math.round(numberOf(size, 'y')),
          x: Math.round(x),
          y: Math.round(y),
          section,
        });
        listed += 1;
      }
    };
    walk(canvas, null, 0, 0, 0);
    total += frameCount;
    pages.push({ name: cleanName(canvas['name'], `Page ${index + 1}`), frameCount, frames });
  }
  return { pages, frameCount: total, truncated };
}
