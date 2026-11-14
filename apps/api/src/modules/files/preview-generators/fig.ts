import { pngCodec } from './codecs.js';
import type { RgbaImage } from './codecs.js';
import { FigReadError, outlineOf, readCanvas, cleanName } from './fig-kiwi.js';
import type { FigOutline } from './fig-kiwi.js';
import { rasterOutcomes } from './raster.js';
import type { DecodedPage } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome, PreviewRefusal, PreviewRequest } from './types.js';
import { readZipDirectory, readZipPart, readZipText, ZipReadError } from './zip-reader.js';
import type { ZipDirectory, ZipLimits } from './zip-reader.js';

/**
 * Peter, 2026-11-10 (FIGMA item 10) — a `.fig` file uploaded to TManage.
 *
 * What is shown is what the file itself holds and nothing made up: the picture Figma saved inside
 * it (`thumbnail.png`, as `preview` + `thumb`, labelled "Preview saved inside the file"), and the
 * list of its pages and frames (`fig_outline`, facts only). Frames are not drawn: see
 * `fig-kiwi.ts`. To show every frame sharp, the team pastes the file's Figma link next to it.
 *
 * Container limits, all fail closed: at most 20 000 entries and 4 GB declared, `canvas.fig` at
 * most 32 MB (declared size checked before anything is inflated), `thumbnail.png` at most 16 MB, `meta.json` at most 64 KB; nothing is written to disk
 * and no entry path is used for anything but a lookup by its exact name. The upload itself passed
 * the archive inspection (no programs, no nested archives) before this runs.
 */

export const FIG_MIME = 'application/x-figma';

const FIG_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 4 * 1024 * 1024 * 1024 };
const MAX_CANVAS_BYTES = 32 * 1024 * 1024;
/**
 * Security review M3 (2026-11-14): the saved picture is small (Figma writes about 400 px); its
 * header is read before anything is decoded, and more than this many pixels is refused.
 */
export const MAX_THUMBNAIL_PIXELS = 16_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;

export interface FigFacts extends FigOutline {
  /** The name Figma saved in `meta.json`, when there is one. */
  readonly fileName: string | null;
}

function savedName(bytes: Uint8Array, directory: ZipDirectory): string | null {
  let text: string | null;
  try {
    text = readZipText(bytes, directory, 'meta.json', MAX_META_BYTES);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('file_name' in parsed)) return null;
    const name = cleanName(typeof parsed.file_name === 'string' ? parsed.file_name : undefined, '');
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/** The pages and frames of a `.fig`, read from `canvas.fig`. Throws when it cannot be read. */
export function figFactsFrom(bytes: Uint8Array, directory: ZipDirectory): FigFacts {
  const canvas = readZipPart(bytes, directory, 'canvas.fig', MAX_CANVAS_BYTES);
  if (canvas === null) throw new FigReadError('fig_unreadable');
  return { ...outlineOf(readCanvas(canvas)), fileName: savedName(bytes, directory) };
}

function codeOf(error: unknown): PreviewRefusal {
  if (error instanceof FigReadError && error.code === 'fig_too_large') {
    return unsupported('unsupported_too_large');
  }
  if (error instanceof ZipReadError && error.code === 'zip_bomb') {
    return unsupported('unsupported_zip_bomb');
  }
  if (error instanceof ZipReadError && error.code === 'zip_part_too_large') {
    return unsupported('unsupported_too_large');
  }
  return failed('fig_unreadable');
}

/** A PNG's size from its IHDR chunk, or `null` when the bytes are not a PNG. */
export function pngHeaderSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const type = String.fromCharCode(png[12] ?? 0, png[13] ?? 0, png[14] ?? 0, png[15] ?? 0);
  if (type !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function decodeThumbnail(
  bytes: Uint8Array,
  directory: ZipDirectory,
  maxPixels: number,
): DecodedPage {
  let png: Uint8Array | null;
  try {
    png = readZipPart(bytes, directory, 'thumbnail.png', MAX_THUMBNAIL_BYTES);
  } catch (error) {
    return codeOf(error);
  }
  if (png === null) return unsupported('unsupported_no_thumbnail');
  const size = pngHeaderSize(png);
  if (!size || size.width === 0 || size.height === 0) return failed('decode_failed');
  if (size.width * size.height > Math.min(maxPixels, MAX_THUMBNAIL_PIXELS)) {
    return unsupported('unsupported_too_large');
  }
  let image: RgbaImage;
  try {
    image = pngCodec().PNG.sync.read(Buffer.from(png));
  } catch {
    return failed('decode_failed');
  }
  if (image.width * image.height > maxPixels) return unsupported('unsupported_too_large');
  return { status: 'decoded', image, meta: { embeddedPreview: true } };
}

export const figGenerator: PreviewGenerator = {
  name: 'fig',
  mimeTypes: [FIG_MIME],
  plan() {
    return [{ kind: 'preview' }, { kind: 'thumb' }, { kind: 'fig_outline' }];
  },
  async generate(source, requests, limits) {
    let directory: ZipDirectory;
    try {
      directory = readZipDirectory(source.bytes, FIG_ZIP_LIMITS);
    } catch (error) {
      const answer = codeOf(error);
      return requests.map(() => answer);
    }

    const raster: PreviewRequest[] = requests.filter((request) => request.kind !== 'fig_outline');
    const rasterAnswers = await rasterOutcomes(raster, async () =>
      decodeThumbnail(source.bytes, directory, limits.maxPixels),
    );

    let outline: PreviewOutcome | null = null;
    if (requests.some((request) => request.kind === 'fig_outline')) {
      try {
        outline = {
          status: 'ready',
          body: null,
          mimeType: null,
          width: null,
          height: null,
          meta: { ...figFactsFrom(source.bytes, directory) },
        };
      } catch (error) {
        outline = codeOf(error);
      }
    }

    let next = 0;
    return requests.map((request): PreviewOutcome => {
      if (request.kind === 'fig_outline') return outline ?? failed('fig_unreadable');
      return rasterAnswers[next++] ?? failed('fig_unreadable');
    });
  },
};
