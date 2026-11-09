import { useLayoutEffect, useState } from 'react';

/**
 * Anchored placement for floating surfaces (tooltips, coach marks), Floating UI style but with no
 * dependency: the surface sits on a side of its anchor, flips to another side when there is no
 * room, shifts along the anchor so it never leaves the viewport, and reports where its arrow must
 * sit to point at the anchor's centre.
 *
 * Sides are logical on the inline axis: `start`/`end` follow the reading direction, so in Arabic
 * (`dir="rtl"`) `end` is the anchor's left. The result is in physical viewport pixels, for a
 * `position: fixed` surface.
 */
export type AnchoredSide = 'top' | 'bottom' | 'start' | 'end';
export type PhysicalSide = 'top' | 'bottom' | 'left' | 'right';

export interface AnchorRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface AnchoredPositionInput {
  readonly anchor: AnchorRect;
  readonly floating: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Sides to try, most wanted first; the first one with room wins. */
  readonly placements: readonly AnchoredSide[];
  readonly dir?: 'ltr' | 'rtl';
  /** Gap between anchor and surface (room for the arrow). */
  readonly offset?: number;
  /** The surface keeps at least this far from every viewport edge. */
  readonly padding?: number;
  /** The arrow keeps at least this far from the surface's corners. */
  readonly arrowPadding?: number;
}

export interface AnchoredPosition {
  /** Physical viewport coordinates of the surface's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** The logical side chosen, after flipping. */
  readonly side: AnchoredSide;
  /** The same side in physical terms (what the arrow's CSS keys on). */
  readonly physicalSide: PhysicalSide;
  /** Arrow offset along the surface's cross axis, from its left (top/bottom) or top (left/right). */
  readonly arrow: number;
  /** False when no side had room and the surface was pulled over the anchor to stay on screen. */
  readonly fits: boolean;
  /** The anchor rectangle the position was computed from (for a spotlight drawn around it). */
  readonly anchor: AnchorRect;
}

export function toPhysicalSide(side: AnchoredSide, dir: 'ltr' | 'rtl' = 'ltr'): PhysicalSide {
  if (side === 'start') return dir === 'rtl' ? 'right' : 'left';
  if (side === 'end') return dir === 'rtl' ? 'left' : 'right';
  return side;
}

const clamp = (value: number, min: number, max: number) =>
  max < min ? min : Math.min(Math.max(value, min), max);

export function computeAnchoredPosition(input: AnchoredPositionInput): AnchoredPosition {
  const { anchor, floating, viewport, dir = 'ltr' } = input;
  const offset = input.offset ?? 8;
  const padding = input.padding ?? 8;
  const arrowPadding = input.arrowPadding ?? 12;
  const placements = input.placements.length > 0 ? input.placements : (['top'] as const);
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;

  const room = (side: PhysicalSide) => {
    switch (side) {
      case 'top':
        return anchor.top - padding;
      case 'bottom':
        return viewport.height - bottom - padding;
      case 'left':
        return anchor.left - padding;
      case 'right':
        return viewport.width - right - padding;
    }
  };
  const need = (side: PhysicalSide) =>
    (side === 'top' || side === 'bottom' ? floating.height : floating.width) + offset;

  let chosen = placements.find(
    (side) => room(toPhysicalSide(side, dir)) >= need(toPhysicalSide(side, dir)),
  );
  const fits = chosen !== undefined;
  if (chosen === undefined) {
    // Nothing has room: take the side with the most, and let the clamp below keep it on screen.
    chosen = placements.reduce((best, side) =>
      room(toPhysicalSide(side, dir)) > room(toPhysicalSide(best, dir)) ? side : best,
    );
  }
  const physicalSide = toPhysicalSide(chosen, dir);
  const vertical = physicalSide === 'top' || physicalSide === 'bottom';

  let x: number;
  let y: number;
  if (vertical) {
    x = anchor.left + anchor.width / 2 - floating.width / 2;
    y = physicalSide === 'top' ? anchor.top - offset - floating.height : bottom + offset;
  } else {
    y = anchor.top + anchor.height / 2 - floating.height / 2;
    x = physicalSide === 'left' ? anchor.left - offset - floating.width : right + offset;
  }
  x = clamp(x, padding, viewport.width - floating.width - padding);
  y = clamp(y, padding, viewport.height - floating.height - padding);

  const arrow = vertical
    ? clamp(anchor.left + anchor.width / 2 - x, arrowPadding, floating.width - arrowPadding)
    : clamp(anchor.top + anchor.height / 2 - y, arrowPadding, floating.height - arrowPadding);

  return {
    x,
    y,
    side: chosen,
    physicalSide,
    arrow,
    fits,
    anchor: { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height },
  };
}

/** The anchor's reading direction: computed style, or the nearest `dir` where none is computed. */
function readDirection(element: HTMLElement): 'ltr' | 'rtl' {
  const computed = getComputedStyle(element).direction;
  if (computed === 'rtl' || computed === 'ltr') return computed;
  return element.closest('[dir]')?.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';
}

export interface UseAnchoredPositionOptions {
  readonly placements: readonly AnchoredSide[];
  readonly offset?: number;
  readonly padding?: number;
  readonly arrowPadding?: number;
}

/**
 * Keeps a `position: fixed` surface placed against its anchor while `active`: measured before
 * paint, and again on scroll (any scroller), resize, and when either element changes size.
 */
export function useAnchoredPosition(
  anchor: HTMLElement | null,
  floating: HTMLElement | null,
  active: boolean,
  options: UseAnchoredPositionOptions,
): AnchoredPosition | null {
  const [position, setPosition] = useState<AnchoredPosition | null>(null);
  const placementsKey = options.placements.join(',');
  const { offset, padding, arrowPadding } = options;

  useLayoutEffect(() => {
    if (!active || anchor === null || floating === null) {
      setPosition(null);
      return undefined;
    }
    const update = () => {
      const a = anchor.getBoundingClientRect();
      const f = floating.getBoundingClientRect();
      const dir = readDirection(anchor);
      const next = computeAnchoredPosition({
        anchor: a,
        floating: { width: f.width, height: f.height },
        viewport: {
          width: document.documentElement.clientWidth || window.innerWidth,
          height: document.documentElement.clientHeight || window.innerHeight,
        },
        placements: placementsKey.split(',') as AnchoredSide[],
        dir,
        ...(offset === undefined ? {} : { offset }),
        ...(padding === undefined ? {} : { padding }),
        ...(arrowPadding === undefined ? {} : { arrowPadding }),
      });
      setPosition((prev) =>
        prev !== null &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.side === next.side &&
        prev.physicalSide === next.physicalSide &&
        prev.arrow === next.arrow &&
        prev.fits === next.fits &&
        prev.anchor.top === next.anchor.top &&
        prev.anchor.left === next.anchor.left &&
        prev.anchor.width === next.anchor.width &&
        prev.anchor.height === next.anchor.height
          ? prev
          : next,
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
    observer?.observe(anchor);
    observer?.observe(floating);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [active, anchor, floating, placementsKey, offset, padding, arrowPadding]);

  return position;
}
