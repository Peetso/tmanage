import { purifyFactory, resvgCodec } from './codecs.js';
import type { PurifyInstance } from './codecs.js';
import { encodeWebp, longSideFor, WEBP_MIME } from './raster.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome } from './types.js';

/**
 * R4 slice 3 — SVG: the one admitted markup type (slice 1), so the one generator that is a
 * security control as much as a converter (SPEC R4 §6.6).
 *
 * - `svg_safe` is a sanitised copy, and the only SVG TManage ever serves inline (slice 4 adds
 *   `Content-Security-Policy: sandbox; default-src 'none'` on top). DOMPurify's SVG profiles strip
 *   scripts, event handlers and `foreignObject`; the hooks here also strip every reference that
 *   leaves the file — `href`/`xlink:href` other than `#fragment` (or an inline raster `data:`
 *   image on `<image>`), `url(…)` other than `url(#…)` in attributes, and `@import` / remote
 *   `url(…)` inside `<style>`. When anything was removed, `meta.linkedImagesRemoved` is `true` and
 *   the viewer says "linked images removed". The original SVG stays a download (`attachment`).
 * - `preview` and `thumb` are WebP rasters of the **sanitised** markup, drawn by resvg in
 *   WebAssembly (no network, no system fonts: text in a font the file does not embed falls back).
 *
 * The sanitised copy must still parse as SVG on its own: resvg parses it before it is accepted, so
 * a file that only made sense with what was removed fails (`svg_invalid`) instead of shipping a
 * broken derivative.
 */

const SVG = 'image/svg+xml';
/** SVG is text: anything bigger than this is not a drawing a browser should be asked to show. */
export const SVG_MAX_BYTES = 10 * 1024 * 1024;

const LOCAL_REFERENCE = /^#/;
const INLINE_RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const URL_CALL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

interface SanitizeState {
  removed: boolean;
}

let state: SanitizeState = { removed: false };
let purify: PurifyInstance | null = null;

function onlyLocalUrls(value: string): boolean {
  for (const match of value.matchAll(URL_CALL)) {
    if (!LOCAL_REFERENCE.test((match[2] ?? '').trim())) return false;
  }
  return true;
}

function cleanStyleSheet(css: string): string {
  let text = css.replace(/@import[^;]*;?/gi, () => {
    state.removed = true;
    return '';
  });
  text = text.replace(URL_CALL, (call: string, _quote: string, target: string) => {
    if (LOCAL_REFERENCE.test(target.trim())) return call;
    state.removed = true;
    return 'none';
  });
  return text;
}

function sanitizer(): PurifyInstance {
  if (purify) return purify;
  const instance = purifyFactory();
  instance.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = cleanStyleSheet(node.textContent);
    }
  });
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue.trim();
    if (name === 'href' || name === 'xlink:href') {
      if (LOCAL_REFERENCE.test(value)) return;
      if (node.nodeName.toLowerCase() === 'image' && INLINE_RASTER.test(value)) return;
      data.keepAttr = false;
      state.removed = true;
      return;
    }
    if (/url\s*\(/i.test(value) && !onlyLocalUrls(value)) {
      data.keepAttr = false;
      state.removed = true;
    }
  });
  purify = instance;
  return instance;
}

/** resvg answers premultiplied RGBA; WebP (and every other generator here) wants it straight. */
export function unpremultiply(pixels: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    out[i + 3] = alpha;
    if (alpha === 0) continue;
    out[i] = (pixels[i]! * 255) / alpha;
    out[i + 1] = (pixels[i + 1]! * 255) / alpha;
    out[i + 2] = (pixels[i + 2]! * 255) / alpha;
  }
  return out;
}

export interface SanitizedSvg {
  readonly markup: string;
  readonly linkedImagesRemoved: boolean;
}

/** The sanitised copy, or `null` when nothing that is an `<svg>` survives. */
export function sanitizeSvg(source: string): SanitizedSvg | null {
  state = { removed: false };
  const cleaned = sanitizer().sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    // The markup is handed out as a file, never inserted into a page, so the HTML parser's
    // serialisation is the output; it must still be well-formed XML (below).
    WHOLE_DOCUMENT: false,
  });
  let markup = cleaned.trim();
  if (!/^<svg[\s>]/i.test(markup)) return null;
  // The HTML serialiser writes U+00A0 as `&nbsp;`, an entity XML does not define.
  markup = markup.replace(/&nbsp;/g, '&#160;');
  if (!/^<svg[^>]*\sxmlns="/i.test(markup)) {
    markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (/\sxlink:/i.test(markup) && !/\sxmlns:xlink=/i.test(markup)) {
    markup = markup.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return {
    markup: `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`,
    linkedImagesRemoved: state.removed,
  };
}

export const svgGenerator: PreviewGenerator = {
  name: 'svg',
  mimeTypes: [SVG],
  plan() {
    return [{ kind: 'svg_safe' }, { kind: 'preview' }, { kind: 'thumb' }];
  },
  async generate(source, requests, limits) {
    if (source.bytes.byteLength > SVG_MAX_BYTES) {
      return requests.map(() => unsupported('unsupported_too_large'));
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
    } catch {
      return requests.map(() => failed('svg_invalid'));
    }
    const safe = sanitizeSvg(text);
    if (!safe) return requests.map(() => failed('svg_invalid'));

    const resvg = await resvgCodec();
    let intrinsic: { width: number; height: number };
    try {
      const probe = new resvg.Resvg(safe.markup, { font: { loadSystemFonts: false } });
      intrinsic = { width: probe.width, height: probe.height };
      probe.free?.();
    } catch {
      return requests.map(() => failed('svg_invalid'));
    }
    if (!(intrinsic.width > 0 && intrinsic.height > 0)) {
      return requests.map(() => failed('svg_invalid'));
    }
    const meta = {
      sourceWidth: Math.round(intrinsic.width),
      sourceHeight: Math.round(intrinsic.height),
      linkedImagesRemoved: safe.linkedImagesRemoved,
    };

    const outcomes: PreviewOutcome[] = [];
    for (const request of requests) {
      if (request.kind === 'svg_safe') {
        outcomes.push({
          status: 'ready',
          body: new TextEncoder().encode(safe.markup),
          mimeType: SVG,
          width: meta.sourceWidth,
          height: meta.sourceHeight,
          meta,
        });
        continue;
      }
      const longSide = longSideFor(request.kind);
      if (longSide === null || request.pageNo > 1) {
        outcomes.push(unsupported('kind_not_raster'));
        continue;
      }
      const landscape = intrinsic.width >= intrinsic.height;
      const scale = longSide / Math.max(intrinsic.width, intrinsic.height);
      if (intrinsic.width * scale * (intrinsic.height * scale) > limits.maxPixels) {
        outcomes.push(unsupported('unsupported_too_large'));
        continue;
      }
      try {
        const renderer = new resvg.Resvg(safe.markup, {
          fitTo: { mode: landscape ? 'width' : 'height', value: longSide },
          font: { loadSystemFonts: false },
        });
        const rendered = renderer.render();
        const image = {
          width: rendered.width,
          height: rendered.height,
          data: unpremultiply(rendered.pixels),
        };
        const body = await encodeWebp(image, request.kind === 'preview' ? 90 : 80);
        rendered.free?.();
        renderer.free?.();
        outcomes.push({
          status: 'ready',
          body,
          mimeType: WEBP_MIME,
          width: image.width,
          height: image.height,
          meta,
        });
      } catch {
        outcomes.push(failed('svg_render_failed'));
      }
    }
    return outcomes;
  },
};
