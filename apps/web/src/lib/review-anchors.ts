import { getStroke } from 'perfect-freehand';

/**
 * R4 slice 7 — the numbers behind drawings on a file under review (V-12).
 *
 * A drawing is stored as strokes whose points are relative to the page or image they were drawn
 * on (0..1 on both axes, origin top-left of the artwork), exactly like pins and boxes: never
 * screen pixels and never mirrored for right-to-left screens. The stage turns them back into
 * pixels at whatever size it shows the artwork. The API keeps the same shape
 * (`{strokes:[{tool,color,width?,points}], bbox}`) and recomputes `bbox` itself.
 */

export type DrawTool = 'pen' | 'arrow' | 'rect';

export type DrawPoint = readonly [number, number];

export interface DrawStroke {
  readonly tool: DrawTool;
  /** `#rrggbb`, one of {@link DRAW_COLOURS}. */
  readonly color: string;
  /** Line width in screen pixels, one of {@link DRAW_WIDTHS}. */
  readonly width: number;
  readonly points: readonly DrawPoint[];
}

export interface DrawBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DrawAnchor {
  readonly strokes: readonly DrawStroke[];
  readonly bbox: DrawBox;
}

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The seven swatches of V-12 (`463:27461`): the six palette colours plus ink. Stored as hex so a
 * drawing keeps its colour in either theme — it sits on the client's artwork, not on our chrome.
 * `live` is the deeper lime (`--lime-600`) so it stays distinct from the accent lime beside it.
 */
export const DRAW_COLOURS = [
  { id: 'danger', hex: '#d9474f' },
  { id: 'warning', hex: '#c96f18' },
  { id: 'accent', hex: '#b7ff57' },
  { id: 'success', hex: '#1d8a63' },
  { id: 'client', hex: '#7755c7' },
  { id: 'live', hex: '#9cea3f' },
  { id: 'inverse', hex: '#090a09' },
] as const;

export type DrawColourId = (typeof DRAW_COLOURS)[number]['id'];

/** The three widths of V-12 (`Width 4 / 6 / 9`). */
export const DRAW_WIDTHS = [4, 6, 9] as const;
export const DEFAULT_DRAW_WIDTH = 4;
export const DEFAULT_DRAW_COLOUR = DRAW_COLOURS[0].hex;

/** The API's limits (review.service.ts): keep a drawing well inside them. */
export const MAX_STROKES = 50;
export const MAX_POINTS_PER_STROKE = 2000;
export const MAX_POINTS_TOTAL = 10_000;

/** Pen points closer than this (fraction of the artwork) to the last kept one are dropped. */
export const PEN_MIN_STEP = 0.002;

/** Arrows and rectangles shorter than this on both axes are a slip, not a mark. */
export const MIN_SHAPE_SIDE = 0.01;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A pointer position (client pixels) as a point on the artwork; `null` on a zero-size box. */
export function normalisePoint(
  clientX: number,
  clientY: number,
  rect: ClientRect,
): DrawPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return [
    round4(clamp01((clientX - rect.left) / rect.width)),
    round4(clamp01((clientY - rect.top) / rect.height)),
  ];
}

/** A stored point back in pixels of an artwork shown at `size`. */
export function denormalisePoint(point: DrawPoint, size: PixelSize): readonly [number, number] {
  return [point[0] * size.width, point[1] * size.height];
}

/** The smallest box around every point of every stroke (0..1); empty drawings give a zero box. */
export function strokesBBox(strokes: readonly DrawStroke[]): DrawBox {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (const stroke of strokes) {
    for (const [x, y] of stroke.points) {
      any = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!any) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: round4(minX), y: round4(minY), w: round4(maxX - minX), h: round4(maxY - minY) };
}

/**
 * Add a pointer point to a pen stroke being drawn: points that barely moved are dropped (a slow
 * hand would otherwise fill the API's point budget), and the stroke stops growing at the cap.
 */
export function appendPenPoint(points: readonly DrawPoint[], next: DrawPoint): DrawPoint[] {
  const last = points[points.length - 1];
  if (points.length >= MAX_POINTS_PER_STROKE) return points.slice();
  if (last && Math.hypot(next[0] - last[0], next[1] - last[1]) < PEN_MIN_STEP) {
    return points.slice();
  }
  return [...points, next];
}

/** Whether a finished stroke is worth keeping (a tap with the arrow or rectangle is not). */
export function isMeaningfulStroke(stroke: DrawStroke): boolean {
  if (stroke.points.length === 0) return false;
  if (stroke.tool === 'pen') return true;
  const [a, b] = [stroke.points[0]!, stroke.points[stroke.points.length - 1]!];
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return stroke.tool === 'arrow'
    ? Math.hypot(dx, dy) >= MIN_SHAPE_SIDE
    : dx >= MIN_SHAPE_SIDE || dy >= MIN_SHAPE_SIDE;
}

/** Whether one more stroke of `points` points still fits the API's limits. */
export function canAddStroke(strokes: readonly DrawStroke[], points = 2): boolean {
  if (strokes.length >= MAX_STROKES) return false;
  const total = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  return total + points <= MAX_POINTS_TOTAL;
}

/** The anchor the API takes for a drawing (`bbox` is recomputed by the server anyway). */
export function toDrawAnchorInput(strokes: readonly DrawStroke[]): {
  readonly strokes: readonly DrawStroke[];
} {
  return {
    strokes: strokes.map((stroke) => ({
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points:
        stroke.tool === 'pen'
          ? stroke.points
          : [stroke.points[0]!, stroke.points[stroke.points.length - 1]!],
    })),
  };
}

const TOOLS: ReadonlySet<string> = new Set(['pen', 'arrow', 'rect']);
const HEX = /^#[0-9a-f]{6}$/i;

/** Read a stored anchor as a drawing, or `null` when it is not one. Bad strokes are skipped. */
export function readDrawAnchor(
  anchor: Readonly<Record<string, unknown>> | null,
): DrawAnchor | null {
  if (!anchor || !Array.isArray(anchor['strokes'])) return null;
  const strokes: DrawStroke[] = [];
  for (const raw of anchor['strokes'] as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const tool = entry['tool'];
    const color = entry['color'];
    if (typeof tool !== 'string' || !TOOLS.has(tool)) continue;
    if (typeof color !== 'string' || !HEX.test(color)) continue;
    if (!Array.isArray(entry['points'])) continue;
    const points: DrawPoint[] = [];
    for (const point of entry['points'] as unknown[]) {
      if (!Array.isArray(point) || point.length !== 2) continue;
      const [x, y] = point as unknown[];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      points.push([clamp01(x), clamp01(y)]);
    }
    if (points.length === 0) continue;
    const width =
      typeof entry['width'] === 'number' && entry['width'] > 0
        ? entry['width']
        : DEFAULT_DRAW_WIDTH;
    strokes.push({ tool: tool as DrawTool, color, width: Math.min(24, width), points });
  }
  if (strokes.length === 0) return null;
  return { strokes, bbox: strokesBBox(strokes) };
}

/** Where a drawing's numbered pin sits: the top-left corner of its box (V-12 draft pin). */
export function drawPinPoint(drawing: DrawAnchor): { readonly x: number; readonly y: number } {
  return { x: drawing.bbox.x, y: drawing.bbox.y };
}

/** The filled outline of a pen stroke (perfect-freehand), as an SVG path in pixels. */
export function penOutlinePath(
  points: readonly DrawPoint[],
  width: number,
  size: PixelSize,
): string {
  if (points.length === 0) return '';
  const pixels = points.map((point) => denormalisePoint(point, size) as [number, number]);
  const outline = getStroke(pixels, {
    size: width,
    thinning: 0.35,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: true,
    last: true,
  });
  return outlineToPath(outline);
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Turn a closed outline into a smooth SVG path (quadratic segments through midpoints). */
export function outlineToPath(outline: readonly (readonly number[])[]): string {
  if (outline.length < 2) return '';
  const first = outline[0]!;
  const parts = [`M${fmt(first[0]!)} ${fmt(first[1]!)}`];
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index]!;
    const b = outline[(index + 1) % outline.length]!;
    parts.push(
      `Q${fmt(a[0]!)} ${fmt(a[1]!)} ${fmt((a[0]! + b[0]!) / 2)} ${fmt((a[1]! + b[1]!) / 2)}`,
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

/** The two short lines of an arrow's head at `to`, in pixels, scaled to the line width. */
export function arrowHeadPath(
  from: readonly [number, number],
  to: readonly [number, number],
  width: number,
): string {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const length = Math.max(12, width * 3.5);
  const spread = Math.PI / 7;
  const left = [
    to[0] - length * Math.cos(angle - spread),
    to[1] - length * Math.sin(angle - spread),
  ];
  const right = [
    to[0] - length * Math.cos(angle + spread),
    to[1] - length * Math.sin(angle + spread),
  ];
  return `M${fmt(left[0]!)} ${fmt(left[1]!)} L${fmt(to[0])} ${fmt(to[1])} L${fmt(right[0]!)} ${fmt(right[1]!)}`;
}

/** The rectangle between a stroke's two corners, in pixels, whichever way it was dragged. */
export function rectFromCorners(
  a: readonly [number, number],
  b: readonly [number, number],
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  };
}
