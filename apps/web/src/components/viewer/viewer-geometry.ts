/**
 * R4 slice 6 — the numbers behind pins and boxes.
 *
 * Every anchor is stored relative to the page or image it was drawn on (0..1 on both axes, origin
 * top-left of the artwork), never in screen pixels and never mirrored for right-to-left screens:
 * the artwork is the client's content, so an Arabic screen shows the pin on the same spot as an
 * English one. The stage converts to and from its own box at whatever zoom it is showing.
 */

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface NormalizedBox extends NormalizedPoint {
  readonly w: number;
  readonly h: number;
}

export interface StageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Rounded to 4 places: 0.01 % of the artwork is finer than any pointer. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A pointer position (client pixels) as a point on the artwork; `null` outside a zero-size box. */
export function toNormalizedPoint(
  clientX: number,
  clientY: number,
  rect: StageRect,
): NormalizedPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: round4(clamp01((clientX - rect.left) / rect.width)),
    y: round4(clamp01((clientY - rect.top) / rect.height)),
  };
}

/** Smallest box side kept (2 % of the artwork); a smaller drag is treated as a pin. */
export const MIN_BOX_SIDE = 0.02;

/** The box between two dragged corners, whichever way the drag went. `null` when too small. */
export function boxBetween(a: NormalizedPoint, b: NormalizedPoint): NormalizedBox | null {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) return null;
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/** Read a stored anchor as a point, or `null` when it is not one. */
export function readPoint(
  anchor: Readonly<Record<string, unknown>> | null,
): NormalizedPoint | null {
  if (!anchor) return null;
  const { x, y } = anchor;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x: clamp01(x), y: clamp01(y) };
}

/** Read a stored anchor as a box, or `null` when it is not one. */
export function readBox(anchor: Readonly<Record<string, unknown>> | null): NormalizedBox | null {
  const point = readPoint(anchor);
  if (!point || !anchor) return null;
  const { w, h } = anchor;
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  return { ...point, w: clamp01(w), h: clamp01(h) };
}

/** The zoom steps the − and + buttons walk through. */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next step up (or down) from a zoom that may sit between steps, e.g. after Fit. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM;
  }
  const lower = ZOOM_STEPS.filter((step) => step < current - 0.001);
  return lower[lower.length - 1] ?? MIN_ZOOM;
}

/**
 * The zoom that fits artwork of `natural` size into `available` space (both CSS pixels).
 * `width` fits the width only (a tall PDF page then scrolls); `contain` fits both sides.
 */
export function fitZoom(
  natural: { readonly width: number; readonly height: number },
  available: { readonly width: number; readonly height: number },
  mode: 'contain' | 'width',
): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  if (available.width <= 0 || available.height <= 0) return 1;
  const byWidth = available.width / natural.width;
  const zoom = mode === 'width' ? byWidth : Math.min(byWidth, available.height / natural.height);
  return clampZoom(zoom);
}

/**
 * Where the new-comment popover opens beside an anchor: after it, or before it when the anchor
 * sits in the last 40 % of the artwork, and above it near the bottom. Physical sides, because the
 * stage is laid out left-to-right in every language.
 */
export function popoverPlacement(point: NormalizedPoint): {
  readonly side: 'right' | 'left';
  readonly vertical: 'below' | 'above';
} {
  return {
    side: point.x > 0.6 ? 'left' : 'right',
    vertical: point.y > 0.6 ? 'above' : 'below',
  };
}
