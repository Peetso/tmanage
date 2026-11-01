import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * R4 slice 3 — the pure-JS / WASM codecs the preview generators use, loaded on first use.
 *
 * Hostinger shared hosting runs one Node process with no native image tools (SPEC R4 §2), so every
 * codec here is JavaScript or WebAssembly: `jpeg-js`, `pngjs`, `omggif`, `utif`, `libheif-js`,
 * `@jsquash/webp` (Squoosh's libwebp), `@resvg/resvg-wasm`, and `dompurify` on `jsdom`.
 *
 * Nothing is loaded at import time: the API boots without paying for a 2 MB HEIF decoder or a
 * DOM, and a deployment that never sees a HEIC file never loads one. The packages without type
 * declarations are described here by the few members the generators call, so the rest of the
 * code is typed and none of it touches `any`.
 */

const require = createRequire(import.meta.url);

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Straight (not premultiplied) RGBA, 4 bytes a pixel, row-major. */
  readonly data: Uint8Array | Uint8ClampedArray;
}

interface JpegModule {
  decode(
    data: Uint8Array,
    options: {
      useTArray: true;
      formatAsRGBA: true;
      maxResolutionInMP: number;
      maxMemoryUsageInMB: number;
    },
  ): { width: number; height: number; data: Uint8Array };
  encode(
    image: { data: Uint8Array; width: number; height: number },
    quality: number,
  ): { data: Uint8Array };
}

interface PngModule {
  PNG: {
    sync: {
      read(data: Buffer): { width: number; height: number; data: Buffer };
      write(png: { width: number; height: number; data: Buffer }): Buffer;
    };
    new (options: { width: number; height: number }): {
      width: number;
      height: number;
      data: Buffer;
    };
  };
}

export interface GifReaderInstance {
  readonly width: number;
  readonly height: number;
  numFrames(): number;
  decodeAndBlitFrameRGBA(frame: number, pixels: Uint8Array): void;
}

interface GifModule {
  GifReader: new (data: Uint8Array) => GifReaderInstance;
}

export interface UtifIfd {
  readonly t256?: readonly number[];
  readonly t257?: readonly number[];
  width?: number;
  height?: number;
}

export interface UtifModule {
  decode(data: ArrayBuffer | Uint8Array): UtifIfd[];
  decodeImage(data: ArrayBuffer | Uint8Array, ifd: UtifIfd): void;
  toRGBA8(ifd: UtifIfd): Uint8Array;
  encodeImage(rgba: Uint8Array, width: number, height: number): ArrayBuffer;
  encode(ifds: object[]): ArrayBuffer;
}

export interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    done: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void;
  free?: () => void;
}

interface HeifModule {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

interface WebpCodec {
  init(module: WebAssembly.Module): Promise<void>;
  default(...args: unknown[]): Promise<unknown>;
}

interface ResvgModule {
  initWasm(module: Uint8Array | WebAssembly.Module): Promise<void>;
  Resvg: new (
    svg: string,
    options?: {
      fitTo?: { mode: 'width' | 'height' | 'original'; value?: number };
      font?: { loadSystemFonts: boolean };
      background?: string;
    },
  ) => {
    readonly width: number;
    readonly height: number;
    render(): {
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8Array;
      free?: () => void;
    };
    free?: () => void;
  };
}

export interface PurifyHookData {
  attrName: string;
  attrValue: string;
  keepAttr: boolean;
  tagName?: string;
}

export interface PurifyInstance {
  sanitize(source: string, config: Record<string, unknown>): string;
  addHook(
    hook: 'uponSanitizeAttribute' | 'uponSanitizeElement',
    run: (node: { nodeName: string; textContent: string | null }, data: PurifyHookData) => void,
  ): void;
}

function lazy<T>(load: () => T): () => T {
  let value: T | undefined;
  let loaded = false;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value as T;
  };
}

export const jpegCodec = lazy(() => require('jpeg-js') as JpegModule);
export const pngCodec = lazy(() => require('pngjs') as PngModule);
export const gifCodec = lazy(() => require('omggif') as GifModule);
export const utifCodec = lazy(() => require('utif') as UtifModule);
export const heifCodec = lazy(() => require('libheif-js/wasm-bundle') as HeifModule);

function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/** The runtime's WebAssembly (the API's `lib` has no DOM, so the value is reached by name). */
const wasm = (
  globalThis as unknown as {
    WebAssembly: { Module: new (bytes: Uint8Array) => WebAssembly.Module };
  }
).WebAssembly;

let webpReady: Promise<{ decode: WebpCodec; encode: WebpCodec }> | null = null;

/** libwebp's decoder and encoder, their WebAssembly compiled once from the package's own files. */
export function webpCodec(): Promise<{ decode: WebpCodec; encode: WebpCodec }> {
  webpReady ??= (async () => {
    const decode = (await import('@jsquash/webp/decode.js')) as unknown as WebpCodec;
    const encode = (await import('@jsquash/webp/encode.js')) as unknown as WebpCodec;
    const base = packageDir('@jsquash/webp');
    await decode.init(new wasm.Module(readFileSync(join(base, 'codec/dec/webp_dec.wasm'))));
    await encode.init(new wasm.Module(readFileSync(join(base, 'codec/enc/webp_enc.wasm'))));
    return { decode, encode };
  })();
  return webpReady;
}

let resvgReady: Promise<ResvgModule> | null = null;

/** resvg's SVG renderer (no system fonts, no network: it reads only the markup it is given). */
export function resvgCodec(): Promise<ResvgModule> {
  resvgReady ??= (async () => {
    const resvg = require('@resvg/resvg-wasm') as ResvgModule;
    await resvg.initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    return resvg;
  })();
  return resvgReady;
}

interface JsdomModule {
  JSDOM: new (html: string) => { window: object };
}

/** One DOMPurify instance on one jsdom window, built on first use. */
export const purifyFactory = lazy(() => {
  const { JSDOM } = require('jsdom') as JsdomModule;
  const createDOMPurify = require('dompurify') as (window: object) => PurifyInstance;
  return createDOMPurify(new JSDOM('').window);
});
