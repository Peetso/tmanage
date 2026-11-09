import type JSZip from 'jszip';
import {
  all,
  attr,
  child,
  children,
  openPackage,
  readXml,
  relationshipId,
  relationships,
} from './ooxml';

/**
 * R4 slice 10 — a PowerPoint deck as plain shapes, read in the browser and drawn by
 * `OfficePptxStage`. A simple, honest renderer: positioned text boxes (size, weight, colour,
 * alignment), pictures, and filled rectangles, on the slide's own background colour. Charts,
 * SmartArt, gradients, effects and animations are not drawn — the stage says the layout is
 * approximate and offers the original.
 *
 * Every position is a fraction of the slide size from `ppt/presentation.xml`, so comment pins —
 * stored as fractions of the same slide box — stay put whatever the screen size.
 */

export interface SlideRun {
  readonly text: string;
  /** Font size in points; `null` = the deck's default (18 pt). */
  readonly sizePt: number | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: string | null;
}

export interface SlideParagraph {
  readonly align: 'start' | 'center' | 'end' | 'justify';
  readonly bullet: boolean;
  readonly runs: readonly SlideRun[];
}

export interface SlideShape {
  readonly kind: 'text' | 'picture';
  /** Fractions 0 … 1 of the slide width / height. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string | null;
  readonly paragraphs: readonly SlideParagraph[];
  /** Picture: the media part inside the package (`ppt/media/image1.png`). */
  readonly media: string | null;
}

export interface Slide {
  readonly background: string | null;
  readonly shapes: readonly SlideShape[];
}

export interface Deck {
  /** EMU (914 400 a inch). */
  readonly width: number;
  readonly height: number;
  readonly slides: readonly Slide[];
  /** Media part → its bytes as a browser object URL, made once per deck. */
  readonly media: ReadonlyMap<string, string>;
}

const DEFAULT_WIDTH = 12_192_000;
const DEFAULT_HEIGHT = 6_858_000;
export const MAX_SLIDES = 300;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

type Theme = ReadonlyMap<string, string>;

interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Placeholder {
  readonly type: string | null;
  readonly idx: string | null;
}

function emu(element: Element | null, name: string): number | null {
  const raw = attr(element, name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function frameOf(properties: Element | null): Frame | null {
  const xfrm = child(properties, 'xfrm');
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  const x = emu(off, 'x');
  const y = emu(off, 'y');
  const w = emu(ext, 'cx');
  const h = emu(ext, 'cy');
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

function hex(value: string | null): string | null {
  return value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : null;
}

/**
 * A colour element's own `<a:alpha val="…"/>` (thousandths of a percent) applied to its colour:
 * a 10 % tint stays a tint, rather than becoming a solid block that hides text of the same colour.
 */
function withAlpha(element: Element, colour: string | null): string | null {
  const alphaElement = child(element, 'alpha');
  if (!colour || !alphaElement) return colour;
  const raw = Number(attr(alphaElement, 'val'));
  if (!Number.isFinite(raw) || raw >= 100000) return colour;
  const alpha = Math.max(0, raw) / 100000;
  const value = colour.slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

/** A colour element's colour: `srgbClr`, `sysClr` or a theme `schemeClr`, with its alpha. */
function colourOf(holder: Element | null, theme: Theme): string | null {
  if (!holder) return null;
  const srgb = child(holder, 'srgbClr');
  if (srgb) return withAlpha(srgb, hex(attr(srgb, 'val')));
  const sys = child(holder, 'sysClr');
  if (sys) return withAlpha(sys, hex(attr(sys, 'lastClr')));
  const scheme = child(holder, 'schemeClr');
  if (scheme) {
    const name = attr(scheme, 'val') ?? '';
    const alias: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' };
    const base = theme.get(alias[name] ?? name) ?? null;
    return base && base.startsWith('#') ? withAlpha(scheme, base) : base;
  }
  return null;
}

function themeColours(document: Document | null): Theme {
  const colours = new Map<string, string>();
  const scheme = document ? all(document, 'clrScheme')[0] : undefined;
  if (!scheme) return colours;
  for (const entry of Array.from(scheme.children)) {
    const colour = colourOf(entry, colours);
    if (colour) colours.set(entry.localName, colour);
  }
  return colours;
}

function placeholderOf(shape: Element): Placeholder | null {
  const ph = all(shape, 'ph')[0];
  return ph ? { type: attr(ph, 'type'), idx: attr(ph, 'idx') } : null;
}

/** Positions of the placeholders a layout or master defines, by type and by index. */
function placeholderFrames(document: Document | null): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  if (!document) return frames;
  for (const shape of all(document, 'sp')) {
    const ph = placeholderOf(shape);
    const frame = frameOf(child(shape, 'spPr'));
    if (!ph || !frame) continue;
    if (ph.idx) frames.set(`idx:${ph.idx}`, frame);
    frames.set(`type:${ph.type ?? 'body'}`, frame);
  }
  return frames;
}

function inheritedFrame(ph: Placeholder | null, ...sources: Map<string, Frame>[]): Frame | null {
  if (!ph) return null;
  for (const source of sources) {
    const found =
      (ph.idx ? source.get(`idx:${ph.idx}`) : undefined) ??
      source.get(`type:${ph.type ?? 'body'}`) ??
      (ph.type === 'ctrTitle' ? source.get('type:title') : undefined) ??
      (ph.type === 'subTitle' ? source.get('type:body') : undefined);
    if (found) return found;
  }
  return null;
}

function paragraphsOf(shape: Element, theme: Theme): SlideParagraph[] {
  const body = child(shape, 'txBody');
  if (!body) return [];
  return children(body, 'p').map((paragraph): SlideParagraph => {
    const properties = child(paragraph, 'pPr');
    const algn = attr(properties, 'algn');
    const runs = Array.from(paragraph.children)
      .filter(
        (node) => node.localName === 'r' || node.localName === 'fld' || node.localName === 'br',
      )
      .map((node): SlideRun => {
        if (node.localName === 'br') {
          return { text: '\n', sizePt: null, bold: false, italic: false, color: null };
        }
        const rPr = child(node, 'rPr');
        const size = Number(attr(rPr, 'sz'));
        return {
          text: child(node, 't')?.textContent ?? '',
          sizePt: Number.isFinite(size) && size > 0 ? size / 100 : null,
          bold: attr(rPr, 'b') === '1',
          italic: attr(rPr, 'i') === '1',
          color: colourOf(child(rPr, 'solidFill'), theme),
        };
      });
    return {
      align:
        algn === 'ctr' ? 'center' : algn === 'r' ? 'end' : algn === 'just' ? 'justify' : 'start',
      bullet: child(properties, 'buChar') !== null || child(properties, 'buAutoNum') !== null,
      runs,
    };
  });
}

interface SlideContext {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly rels: Map<string, string>;
  readonly layout: Map<string, Frame>;
  readonly master: Map<string, Frame>;
}

/** Group shapes move and scale their children: child frame → slide frame. */
interface Transform {
  readonly offX: number;
  readonly offY: number;
  readonly chX: number;
  readonly chY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const IDENTITY: Transform = { offX: 0, offY: 0, chX: 0, chY: 0, scaleX: 1, scaleY: 1 };

function apply(frame: Frame, transform: Transform): Frame {
  return {
    x: transform.offX + (frame.x - transform.chX) * transform.scaleX,
    y: transform.offY + (frame.y - transform.chY) * transform.scaleY,
    w: frame.w * transform.scaleX,
    h: frame.h * transform.scaleY,
  };
}

function shapesOf(tree: Element, context: SlideContext, transform: Transform): SlideShape[] {
  const shapes: SlideShape[] = [];
  const fraction = (frame: Frame): Pick<SlideShape, 'x' | 'y' | 'w' | 'h'> => ({
    x: frame.x / context.width,
    y: frame.y / context.height,
    w: frame.w / context.width,
    h: frame.h / context.height,
  });
  for (const node of Array.from(tree.children)) {
    if (node.localName === 'sp') {
      const properties = child(node, 'spPr');
      const ph = placeholderOf(node);
      const frame = frameOf(properties) ?? inheritedFrame(ph, context.layout, context.master);
      if (!frame) continue;
      const paragraphs = paragraphsOf(node, context.theme);
      const fill = colourOf(child(properties, 'solidFill'), context.theme);
      const hasText = paragraphs.some((p) => p.runs.some((run) => run.text.trim() !== ''));
      if (!hasText && !fill) continue;
      shapes.push({
        kind: 'text',
        ...fraction(apply(frame, transform)),
        fill,
        paragraphs: hasText ? paragraphs : [],
        media: null,
      });
    } else if (node.localName === 'pic') {
      const frame = frameOf(child(node, 'spPr'));
      const embed = attr(all(node, 'blip')[0], 'embed');
      const media = embed ? (context.rels.get(embed) ?? null) : null;
      if (!frame || !media) continue;
      shapes.push({
        kind: 'picture',
        ...fraction(apply(frame, transform)),
        fill: null,
        paragraphs: [],
        media,
      });
    } else if (node.localName === 'grpSp') {
      const xfrm = child(child(node, 'grpSpPr'), 'xfrm');
      const off = child(xfrm, 'off');
      const ext = child(xfrm, 'ext');
      const chOff = child(xfrm, 'chOff');
      const chExt = child(xfrm, 'chExt');
      const outer = apply(
        {
          x: emu(off, 'x') ?? 0,
          y: emu(off, 'y') ?? 0,
          w: emu(ext, 'cx') ?? 0,
          h: emu(ext, 'cy') ?? 0,
        },
        transform,
      );
      const innerW = emu(chExt, 'cx') || outer.w || 1;
      const innerH = emu(chExt, 'cy') || outer.h || 1;
      shapes.push(
        ...shapesOf(node, context, {
          offX: outer.x,
          offY: outer.y,
          chX: emu(chOff, 'x') ?? 0,
          chY: emu(chOff, 'y') ?? 0,
          scaleX: outer.w / innerW,
          scaleY: outer.h / innerH,
        }),
      );
    }
  }
  return shapes;
}

function backgroundOf(document: Document | null, theme: Theme): string | null {
  if (!document) return null;
  const bg = all(document, 'bg')[0];
  return bg ? colourOf(child(child(bg, 'bgPr'), 'solidFill'), theme) : null;
}

async function mediaUrls(zip: JSZip, parts: ReadonlySet<string>): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const part of parts) {
    const extension = part.split('.').pop()?.toLowerCase() ?? '';
    const type = IMAGE_TYPES[extension];
    const file = zip.file(part);
    if (!type || !file) continue;
    const bytes = await file.async('uint8array');
    urls.set(part, URL.createObjectURL(new Blob([bytes as BlobPart], { type })));
  }
  return urls;
}

/** Reads a deck's slides in presentation order. Throws when the bytes are not a deck. */
export async function readDeck(bytes: ArrayBuffer | Uint8Array): Promise<Deck> {
  const zip = await openPackage(bytes);
  const presentation = await readXml(zip, 'ppt/presentation.xml');
  if (!presentation) throw new Error('not a presentation');
  const size = all(presentation, 'sldSz')[0];
  const width = emu(size ?? null, 'cx') || DEFAULT_WIDTH;
  const height = emu(size ?? null, 'cy') || DEFAULT_HEIGHT;
  const rels = await relationships(zip, 'ppt/presentation.xml');
  const paths = all(presentation, 'sldId')
    .map((slide) => rels.get(relationshipId(slide) ?? ''))
    .filter((path): path is string => Boolean(path))
    .slice(0, MAX_SLIDES);

  const theme = themeColours(await readXml(zip, 'ppt/theme/theme1.xml'));
  const frameCache = new Map<string, Map<string, Frame>>();
  const framesFor = async (part: string | undefined): Promise<Map<string, Frame>> => {
    if (!part) return new Map();
    const cached = frameCache.get(part);
    if (cached) return cached;
    const frames = placeholderFrames(await readXml(zip, part));
    frameCache.set(part, frames);
    return frames;
  };

  const slides: Slide[] = [];
  const mediaParts = new Set<string>();
  for (const path of paths) {
    const document = await readXml(zip, path);
    const tree = document ? all(document, 'spTree')[0] : undefined;
    if (!document || !tree) {
      slides.push({ background: null, shapes: [] });
      continue;
    }
    const slideRels = await relationships(zip, path);
    const layoutPart = [...slideRels.values()].find((target) => target.includes('slideLayouts/'));
    const layoutRels = layoutPart
      ? await relationships(zip, layoutPart)
      : new Map<string, string>();
    const masterPart = [...layoutRels.values()].find((target) => target.includes('slideMasters/'));
    const shapes = shapesOf(
      tree,
      {
        width,
        height,
        theme,
        rels: slideRels,
        layout: await framesFor(layoutPart),
        master: await framesFor(masterPart),
      },
      IDENTITY,
    );
    for (const shape of shapes) if (shape.media) mediaParts.add(shape.media);
    const background =
      backgroundOf(document, theme) ??
      (layoutPart ? backgroundOf(await readXml(zip, layoutPart), theme) : null) ??
      (masterPart ? backgroundOf(await readXml(zip, masterPart), theme) : null);
    slides.push({ background, shapes });
  }
  return { width, height, slides, media: await mediaUrls(zip, mediaParts) };
}

/** Frees the object URLs a deck made for its pictures. */
export function releaseDeck(deck: Deck): void {
  for (const url of deck.media.values()) URL.revokeObjectURL(url);
}
