import { createRequire } from 'node:module';
import type * as AgPsdModule from 'ag-psd';
import type { Layer, Psd, ReadOptions } from 'ag-psd';
import type { RgbaImage } from './codecs.js';
import {
  agPsdReadsColorMode,
  psdHeader,
  readForeignComposite,
  withRgbHeader,
} from './psd-composite.js';
import { rasterOutcomes } from './raster.js';
import type { DecodedPage } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome, PreviewRequest } from './types.js';

/**
 * R4 slice 10 — Photoshop (PSD and PSB), read with ag-psd (MIT, pure JavaScript).
 *
 * - `preview` + `thumb`: WebP rasters of the composite image Photoshop saved inside the file
 *   ("Maximize compatibility"). That is exactly what Photoshop showed: smart objects, adjustment
 *   layers and layer effects are as saved, nothing is re-rendered.
 * - When the file was saved without that composite, the visible pixel layers are stacked
 *   bottom-up with normal blending and their opacity, and every row says `approximate: true`;
 *   the viewer then says the preview is approximate.
 * - `psd_layers` (facts only): the layer tree — name, kind (group, pixel, text, smart object,
 *   adjustment), visible, opacity %, blend mode — read-only in the viewer (no toggling in R4).
 *
 * Caps: the document's pixel count is checked from the header before anything is decoded
 * (`unsupported_too_large`); the job's input cap (300 MB) applies before the file is read.
 */

const PSD = 'image/vnd.adobe.photoshop';
/** Layers listed per file, and how deep the tree goes; the rest is counted, not listed. */
const MAX_LISTED_LAYERS = 500;
const MAX_DEPTH = 12;

type AgPsd = typeof AgPsdModule;

const require = createRequire(import.meta.url);
let loadedAgPsd: AgPsd | null = null;

/**
 * ag-psd, loaded on first use. It asks for a canvas to hold pixels unless told otherwise; Node
 * has none, so pixels are kept as plain arrays (`useImageData`) and a canvas is never made.
 */
function agPsd(): AgPsd {
  if (loadedAgPsd) return loadedAgPsd;
  const loaded = require('ag-psd') as AgPsd;
  loaded.initializeCanvas(
    () => {
      throw new Error('no canvas on the server');
    },
    ((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })) as unknown as NonNullable<Parameters<AgPsd['initializeCanvas']>[1]>,
  );
  loadedAgPsd = loaded;
  return loaded;
}

export type PsdLayerKind = 'group' | 'pixel' | 'text' | 'smart_object' | 'adjustment';

export interface PsdLayerFact {
  readonly name: string;
  readonly kind: PsdLayerKind;
  readonly visible: boolean;
  /** 0 … 100. */
  readonly opacity: number;
  readonly blendMode: string;
  readonly children?: readonly PsdLayerFact[];
}

export interface PsdLayerTree {
  readonly layers: readonly PsdLayerFact[];
  readonly layerCount: number;
  readonly groupCount: number;
}

function kindOf(layer: Layer): PsdLayerKind {
  if (layer.children) return 'group';
  if (layer.adjustment) return 'adjustment';
  if (layer.placedLayer) return 'smart_object';
  if (layer.text) return 'text';
  return 'pixel';
}

/**
 * The layer tree, top layer first (as Photoshop's Layers panel lists it). ag-psd gives the
 * bottom layer first, so each level is reversed.
 */
export function layerTreeOf(children: readonly Layer[] | undefined): PsdLayerTree {
  let listed = 0;
  let layerCount = 0;
  let groupCount = 0;
  const walk = (level: readonly Layer[] | undefined, depth: number): PsdLayerFact[] => {
    const facts: PsdLayerFact[] = [];
    for (const layer of [...(level ?? [])].reverse()) {
      const kind = kindOf(layer);
      if (kind === 'group') groupCount += 1;
      else layerCount += 1;
      const nested = kind === 'group' ? walk(layer.children, depth + 1) : undefined;
      if (listed >= MAX_LISTED_LAYERS || depth > MAX_DEPTH) continue;
      listed += 1;
      facts.push({
        name: (layer.name ?? '').slice(0, 200),
        kind,
        visible: layer.hidden !== true,
        opacity: Math.round(Math.min(1, Math.max(0, layer.opacity ?? 1)) * 100),
        blendMode: layer.blendMode ?? 'normal',
        ...(nested ? { children: nested } : {}),
      });
    }
    return facts;
  };
  return { layers: walk(children, 0), layerCount, groupCount };
}

interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
}

/** 16- and 32-bit documents come back wider than a byte a channel; the preview is 8-bit. */
function toRgba8(pixels: PixelData): RgbaImage {
  const { data } = pixels;
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return { width: pixels.width, height: pixels.height, data };
  }
  const out = new Uint8ClampedArray(data.length);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i += 1) out[i] = data[i]! >> 8;
  } else {
    for (let i = 0; i < data.length; i += 1) out[i] = Math.round(data[i]! * 255);
  }
  return { width: pixels.width, height: pixels.height, data: out };
}

/**
 * Stacks the visible pixel layers bottom-up onto a transparent canvas: normal blending, layer and
 * group opacity. Adjustments, effects, masks and other blend modes are not re-created — that is
 * why the result is marked approximate.
 */
export function flattenLayers(psd: Psd): RgbaImage {
  const width = psd.width;
  const height = psd.height;
  const out = new Uint8ClampedArray(width * height * 4);
  const paint = (layers: readonly Layer[] | undefined, groupOpacity: number): void => {
    for (const layer of layers ?? []) {
      if (layer.hidden) continue;
      const opacity = groupOpacity * Math.min(1, Math.max(0, layer.opacity ?? 1));
      if (layer.children) {
        paint(layer.children, opacity);
        continue;
      }
      if (layer.adjustment || !layer.imageData) continue;
      const image = toRgba8(layer.imageData as PixelData);
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      for (let y = 0; y < image.height; y += 1) {
        const ty = top + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < image.width; x += 1) {
          const tx = left + x;
          if (tx < 0 || tx >= width) continue;
          const s = (y * image.width + x) * 4;
          const alpha = (image.data[s + 3]! / 255) * opacity;
          if (alpha <= 0) continue;
          const d = (ty * width + tx) * 4;
          const below = out[d + 3]! / 255;
          const outAlpha = alpha + below * (1 - alpha);
          for (let c = 0; c < 3; c += 1) {
            out[d + c] =
              (image.data[s + c]! * alpha + out[d + c]! * below * (1 - alpha)) / outAlpha;
          }
          out[d + 3] = outAlpha * 255;
        }
      }
    }
  };
  paint(psd.children, 1);
  return { width, height, data: out };
}

function read(bytes: Uint8Array, options: ReadOptions): Psd | null {
  try {
    return agPsd().readPsd(bytes, {
      useImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      ...options,
    });
  } catch {
    return null;
  }
}

function layersOutcome(
  tree: PsdLayerTree,
  size: { width: number; height: number },
  approximate: boolean,
): PreviewOutcome {
  return {
    status: 'ready',
    body: null,
    mimeType: null,
    width: size.width,
    height: size.height,
    meta: { ...tree, approximate },
  };
}

export const psdGenerator: PreviewGenerator = {
  name: 'psd',
  mimeTypes: [PSD],
  plan() {
    return [{ kind: 'preview' }, { kind: 'thumb' }, { kind: 'psd_layers' }];
  },
  async generate(source, requests, limits) {
    // Width × height (and the colour mode) from the 26-byte header, before decoding anything.
    const header = psdHeader(source.bytes);
    if (!header || header.width === 0 || header.height === 0) {
      return requests.map(() => failed('decode_failed'));
    }
    const size = { width: header.width, height: header.height };
    if (size.width * size.height > limits.maxPixels) {
      return requests.map(() => unsupported('unsupported_too_large'));
    }

    const wantsRaster = requests.some((request) => request.kind !== 'psd_layers');
    if (!agPsdReadsColorMode(header.colorMode)) {
      // FIX6 item 5: CMYK, Lab, multichannel, duotone — read here, colours approximate.
      const treeOnly = withRgbHeader(source.bytes, () =>
        read(source.bytes, { skipLayerImageData: true, skipCompositeImageData: true }),
      );
      const foreign = wantsRaster ? readForeignComposite(source.bytes) : null;
      return answer(requests, layerTreeOf(treeOnly?.children), size, foreign?.image ?? null, true);
    }
    // First pass: the composite and the tree, without every layer's pixels.
    const psd = read(source.bytes, {
      skipLayerImageData: true,
      skipCompositeImageData: !wantsRaster,
    });
    if (!psd) return requests.map(() => failed('decode_failed'));
    const tree = layerTreeOf(psd.children);

    const realComposite = psd.imageResources?.versionInfo?.hasRealMergedData !== false;
    let approximate = !realComposite || (wantsRaster && !psd.imageData);
    let image: RgbaImage | null = null;
    if (wantsRaster) {
      if (!approximate && psd.imageData) {
        image = toRgba8(psd.imageData as PixelData);
      } else {
        // No usable composite: read the layers' pixels too and stack them.
        const layered = read(source.bytes, { skipCompositeImageData: true });
        if (layered?.children && layered.children.length > 0) {
          image = flattenLayers(layered);
        } else if (psd.imageData) {
          image = toRgba8(psd.imageData as PixelData);
        }
        approximate = true;
      }
    }

    return answer(requests, tree, size, image, approximate);
  },
};

/** One outcome per request: the rasters from `image` (or a decode failure), and the tree. */
async function answer(
  requests: readonly PreviewRequest[],
  tree: PsdLayerTree,
  size: { width: number; height: number },
  image: RgbaImage | null,
  approximate: boolean,
): Promise<PreviewOutcome[]> {
  const raster: PreviewRequest[] = requests.filter((request) => request.kind !== 'psd_layers');
  const rasterAnswers = image
    ? await rasterOutcomes(raster, async (): Promise<DecodedPage> => ({
        status: 'decoded',
        image,
        meta: { approximate },
      }))
    : raster.map(() => failed('decode_failed'));
  let next = 0;
  return requests.map((request) =>
    request.kind === 'psd_layers' ? layersOutcome(tree, size, approximate) : rasterAnswers[next++]!,
  );
}
