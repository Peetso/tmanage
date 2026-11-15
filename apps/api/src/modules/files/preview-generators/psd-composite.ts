import type { RgbaImage } from './codecs.js';
import { jpegCodec } from './codecs.js';

/**
 * FIX6 item 5 — the PSD colour modes ag-psd refuses to open (CMYK, Lab, multichannel,
 * duotone; ag-psd reads bitmap, greyscale, indexed and RGB). A live CMYK file showed "The preview
 * didn't work". This reads only what a preview needs, straight from the file layout (Adobe
 * Photoshop File Format Specification, "File Header" … "Image Data Section"):
 *
 * - the merged composite Photoshop saved at the end of the file, 8- or 16-bit, raw or
 *   PackBits; converted to sRGB with the plain formulas (CMYK without an ICC profile, Lab with D50
 *   white), so the colours are close, not proofed — the caller marks the preview approximate;
 * - otherwise the small JPEG thumbnail Photoshop keeps in image resource 1036.
 *
 * Everything is bounds-checked: a short or inconsistent file gives `null`, never a throw past
 * the caller. The pixel count was already checked against the cap from the header.
 */

export const PSD_COLOR_MODE = {
  bitmap: 0,
  grayscale: 1,
  indexed: 2,
  rgb: 3,
  cmyk: 4,
  multichannel: 7,
  duotone: 8,
  lab: 9,
} as const;

/** The modes ag-psd reads itself. */
const AG_PSD_MODES: ReadonlySet<number> = new Set([
  PSD_COLOR_MODE.bitmap,
  PSD_COLOR_MODE.grayscale,
  PSD_COLOR_MODE.indexed,
  PSD_COLOR_MODE.rgb,
]);

export interface PsdHeader {
  /** 1 = PSD, 2 = PSB (large document). */
  readonly version: number;
  readonly channels: number;
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  readonly colorMode: number;
}

export function psdHeader(bytes: Uint8Array): PsdHeader | null {
  if (bytes.byteLength < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x38425053) return null; // `8BPS`
  const version = view.getUint16(4);
  if (version !== 1 && version !== 2) return null;
  return {
    version,
    channels: view.getUint16(12),
    height: view.getUint32(14),
    width: view.getUint32(18),
    depth: view.getUint16(22),
    colorMode: view.getUint16(24),
  };
}

/** Whether ag-psd can open this file at all (otherwise only {@link readForeignComposite}). */
export function agPsdReadsColorMode(colorMode: number): boolean {
  return AG_PSD_MODES.has(colorMode);
}

interface Sections {
  readonly resources: { readonly start: number; readonly end: number };
  /** Start of the image data section (compression word). */
  readonly imageData: number;
}

function sections(bytes: Uint8Array, header: PsdHeader): Sections | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 26;
  const u32 = (): number | null => {
    if (at + 4 > bytes.byteLength) return null;
    const value = view.getUint32(at);
    at += 4;
    return value;
  };
  const colorData = u32();
  if (colorData === null) return null;
  at += colorData;
  const resourcesLength = u32();
  if (resourcesLength === null) return null;
  const resources = { start: at, end: at + resourcesLength };
  at = resources.end;
  let layerLength: number | null;
  if (header.version === 2) {
    const high = u32();
    const low = u32();
    layerLength = high === null || low === null ? null : high * 2 ** 32 + low;
  } else {
    layerLength = u32();
  }
  if (layerLength === null) return null;
  at += layerLength;
  if (resources.end > bytes.byteLength || at + 2 > bytes.byteLength) return null;
  return { resources, imageData: at };
}

/** PackBits rows into `out` (one channel plane), `false` when the data runs short. */
function unpackBits(
  bytes: Uint8Array,
  from: number,
  length: number,
  out: Uint8Array,
  outAt: number,
  outLength: number,
): boolean {
  let at = from;
  const end = from + length;
  let written = 0;
  while (at < end && written < outLength) {
    const n = (bytes[at]! << 24) >> 24;
    at += 1;
    if (n >= 0) {
      const count = n + 1;
      if (at + count > end) return false;
      const take = Math.min(count, outLength - written);
      out.set(bytes.subarray(at, at + take), outAt + written);
      written += take;
      at += count;
    } else if (n !== -128) {
      const count = 1 - n;
      if (at >= end) return false;
      const take = Math.min(count, outLength - written);
      out.fill(bytes[at]!, outAt + written, outAt + written + take);
      written += take;
      at += 1;
    }
  }
  return written === outLength;
}

/** The composite's channel planes, each width × height × bytes-per-sample, or `null`. */
function planes(
  bytes: Uint8Array,
  header: PsdHeader,
  start: number,
  count: number,
): Uint8Array[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sample = header.depth === 16 ? 2 : 1;
  const rowBytes = header.width * sample;
  const planeBytes = rowBytes * header.height;
  const compression = view.getUint16(start);
  let at = start + 2;
  const result: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < count; c += 1) {
      if (at + planeBytes > bytes.byteLength) return null;
      result.push(bytes.subarray(at, at + planeBytes));
      at += planeBytes;
    }
    return result;
  }
  if (compression !== 1) return null;
  // Row byte counts for every channel of the file (not only the ones used), then the rows.
  const countSize = header.version === 2 ? 4 : 2;
  const rows = header.channels * header.height;
  if (at + rows * countSize > bytes.byteLength) return null;
  const lengths: number[] = [];
  for (let i = 0; i < rows; i += 1) {
    lengths.push(countSize === 4 ? view.getUint32(at) : view.getUint16(at));
    at += countSize;
  }
  for (let c = 0; c < count; c += 1) {
    const plane = new Uint8Array(planeBytes);
    for (let y = 0; y < header.height; y += 1) {
      const length = lengths[c * header.height + y]!;
      if (!unpackBits(bytes, at, length, plane, y * rowBytes, rowBytes)) return null;
      at += length;
    }
    result.push(plane);
  }
  return result;
}

const clamp = (value: number): number => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value));

/** sRGB companding of a linear 0…1 value. */
function srgb(linear: number): number {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return clamp(v * 255);
}

/** CIE Lab (D50, as Photoshop stores it) to sRGB (Bradford-adapted to D65). */
export function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const inv = (f: number) => (f ** 3 > e ? f ** 3 : (116 * f - 16) / k);
  const x = inv(fx) * 0.9642;
  const y = (l > k * e ? fy ** 3 : l / k) * 1.0;
  const z = inv(fz) * 0.8249;
  // XYZ (D50) to linear sRGB, Bradford-adapted (Lindbloom's matrix).
  const r = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const g = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const bl = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  return [srgb(r), srgb(g), srgb(bl)];
}

function compositeImage(bytes: Uint8Array, header: PsdHeader, imageData: number): RgbaImage | null {
  if (header.depth !== 8 && header.depth !== 16) return null;
  const mode = header.colorMode;
  const wanted =
    mode === PSD_COLOR_MODE.cmyk
      ? 4
      : mode === PSD_COLOR_MODE.lab
        ? 3
        : header.channels >= 1
          ? 1
          : 0;
  if (wanted === 0 || header.channels < wanted) return null;
  const data = planes(bytes, header, imageData, wanted);
  if (!data) return null;
  const pixels = header.width * header.height;
  const out = new Uint8ClampedArray(pixels * 4);
  const wide = header.depth === 16;
  const at = (plane: Uint8Array, i: number): number => (wide ? plane[i * 2]! : plane[i]!);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    if (mode === PSD_COLOR_MODE.cmyk) {
      // Photoshop stores CMYK inverted: 255 = no ink.
      const k = at(data[3]!, i) / 255;
      out[o] = clamp(at(data[0]!, i) * k);
      out[o + 1] = clamp(at(data[1]!, i) * k);
      out[o + 2] = clamp(at(data[2]!, i) * k);
    } else if (mode === PSD_COLOR_MODE.lab) {
      const [r, g, b] = labToRgb(
        (at(data[0]!, i) / 255) * 100,
        at(data[1]!, i) - 128,
        at(data[2]!, i) - 128,
      );
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    } else {
      // Multichannel and duotone: the first channel, as grey (the ink colours are not applied).
      const v = at(data[0]!, i);
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
    out[o + 3] = 255;
  }
  return { width: header.width, height: header.height, data: out };
}

/** The JPEG thumbnail in image resource 1036, decoded (1033, the older one, is BGR: skipped). */
function thumbnailImage(bytes: Uint8Array, resources: Sections['resources']): RgbaImage | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = resources.start;
  while (at + 12 <= resources.end) {
    if (view.getUint32(at) !== 0x3842494d) return null; // `8BIM`
    const id = view.getUint16(at + 4);
    const nameLength = bytes[at + 6]!;
    at += 6 + ((nameLength + 2) & ~1);
    if (at + 4 > resources.end) return null;
    const size = view.getUint32(at);
    at += 4;
    const start = at;
    at += (size + 1) & ~1;
    if (start + size > resources.end) return null;
    if (id === 1036 && size > 28 && view.getUint32(start) === 1) {
      try {
        const decoded = jpegCodec().decode(bytes.subarray(start + 28, start + size), {
          useTArray: true,
          formatAsRGBA: true,
          // A thumbnail is at most 160 px a side; anything far larger is not one.
          maxResolutionInMP: 4,
          maxMemoryUsageInMB: 64,
        });
        return { width: decoded.width, height: decoded.height, data: decoded.data };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface ForeignComposite {
  readonly image: RgbaImage;
  /** `true` when only the small thumbnail was usable. */
  readonly thumbnailOnly: boolean;
}

/**
 * The preview picture of a PSD in a colour mode ag-psd does not open: the saved composite,
 * converted, or else the embedded thumbnail. `null` when neither can be read.
 */
export function readForeignComposite(bytes: Uint8Array): ForeignComposite | null {
  const header = psdHeader(bytes);
  if (!header || header.width === 0 || header.height === 0) return null;
  const parts = sections(bytes, header);
  if (!parts) return null;
  const composite = compositeImage(bytes, header, parts.imageData);
  if (composite) return { image: composite, thumbnailOnly: false };
  const thumbnail = thumbnailImage(bytes, parts.resources);
  return thumbnail ? { image: thumbnail, thumbnailOnly: true } : null;
}

/**
 * Runs `read` while the file's header says RGB, so ag-psd lists the layer tree (names, kinds,
 * visibility, opacity) of a CMYK or Lab file: the tree does not depend on the colour mode, and the
 * caller skips every pixel in that read. The two header bytes are put back before returning
 * (no copy of a file that may be hundreds of megabytes).
 */
export function withRgbHeader<T>(bytes: Uint8Array, read: () => T): T {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mode = view.getUint16(24);
  view.setUint16(24, PSD_COLOR_MODE.rgb);
  try {
    return read();
  } finally {
    view.setUint16(24, mode);
  }
}
