import { describe, expect, it } from 'vitest';
import {
  DRAW_COLOURS,
  DRAW_WIDTHS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  appendPenPoint,
  arrowHeadPath,
  canAddStroke,
  denormalisePoint,
  drawPinPoint,
  isMeaningfulStroke,
  normalisePoint,
  outlineToPath,
  penOutlinePath,
  readDrawAnchor,
  rectFromCorners,
  strokesBBox,
  toDrawAnchorInput,
  type DrawPoint,
  type DrawStroke,
} from '../src/lib/review-anchors';

/**
 * R4 slice 7 — the maths behind drawings: pointer pixels to relative points and back, the
 * drawing's box, the point budget the API allows, reading stored anchors defensively, and the
 * SVG geometry of pen, arrow and rectangle strokes.
 */

const RECT = { left: 100, top: 50, width: 800, height: 400 };

function pen(points: DrawPoint[], extra: Partial<DrawStroke> = {}): DrawStroke {
  return { tool: 'pen', color: '#d9474f', width: 4, points, ...extra };
}

describe('review anchors (R4 slice 7)', () => {
  it('turns pointer pixels into relative points, clamped and rounded, and back', () => {
    expect(normalisePoint(500, 250, RECT)).toEqual([0.5, 0.5]);
    expect(normalisePoint(100, 50, RECT)).toEqual([0, 0]);
    // Outside the artwork the point sticks to its edge.
    expect(normalisePoint(2000, -40, RECT)).toEqual([1, 0]);
    expect(normalisePoint(100.12345, 50, RECT)).toEqual([0.0002, 0]);
    expect(normalisePoint(10, 10, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    // Zoom-independent: the same spot at twice the size is the same point.
    const big = { left: 100, top: 50, width: 1600, height: 800 };
    expect(normalisePoint(900, 450, big)).toEqual(normalisePoint(500, 250, RECT));
    expect(denormalisePoint([0.25, 0.75], { width: 1000, height: 400 })).toEqual([250, 300]);
  });

  it('computes the box around every stroke', () => {
    expect(strokesBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(
      strokesBBox([
        pen([
          [0.2, 0.3],
          [0.4, 0.1],
        ]),
        {
          tool: 'rect',
          color: '#090a09',
          width: 6,
          points: [
            [0.7, 0.8],
            [0.5, 0.6],
          ],
        },
      ]),
    ).toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.7 });
    expect(drawPinPoint({ strokes: [], bbox: { x: 0.2, y: 0.1, w: 0.5, h: 0.7 } })).toEqual({
      x: 0.2,
      y: 0.1,
    });
  });

  it('drops pen points that barely moved and stops at the per-stroke cap', () => {
    let points: DrawPoint[] = [[0.5, 0.5]];
    points = appendPenPoint(points, [0.5005, 0.5005]);
    expect(points).toHaveLength(1);
    points = appendPenPoint(points, [0.51, 0.5]);
    expect(points).toHaveLength(2);
    const full: DrawPoint[] = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, i) => [
      (i % 100) / 100,
      Math.floor(i / 100) / 100,
    ]);
    expect(appendPenPoint(full, [0.99, 0.99])).toHaveLength(MAX_POINTS_PER_STROKE);
  });

  it('keeps only meaningful strokes and stays inside the API limits', () => {
    expect(isMeaningfulStroke(pen([[0.5, 0.5]]))).toBe(true);
    expect(isMeaningfulStroke(pen([]))).toBe(false);
    const arrow = (b: DrawPoint): DrawStroke => ({
      tool: 'arrow',
      color: '#090a09',
      width: 4,
      points: [[0.5, 0.5], b],
    });
    expect(isMeaningfulStroke(arrow([0.502, 0.502]))).toBe(false);
    expect(isMeaningfulStroke(arrow([0.6, 0.5]))).toBe(true);
    const rect: DrawStroke = {
      tool: 'rect',
      color: '#090a09',
      width: 4,
      points: [
        [0.1, 0.1],
        [0.1, 0.3],
      ],
    };
    expect(isMeaningfulStroke(rect)).toBe(true);

    expect(canAddStroke([])).toBe(true);
    const many = Array.from({ length: MAX_STROKES }, () => pen([[0.1, 0.1]]));
    expect(canAddStroke(many)).toBe(false);
    const heavy = Array.from({ length: 5 }, () =>
      pen(Array.from({ length: 2000 }, (_, i): DrawPoint => [i / 2000, 0.5])),
    );
    expect(canAddStroke(heavy)).toBe(false);
    expect(canAddStroke(heavy.slice(0, 4), 2000)).toBe(true);
  });

  it('sends arrows and rectangles as their two ends, pens with every point, widths kept', () => {
    const input = toDrawAnchorInput([
      pen([
        [0.1, 0.1],
        [0.2, 0.2],
        [0.3, 0.1],
      ]),
      {
        tool: 'arrow',
        color: '#7755c7',
        width: 9,
        points: [
          [0.1, 0.1],
          [0.2, 0.2],
          [0.4, 0.4],
        ],
      },
    ]);
    expect(input.strokes[0]!.points).toHaveLength(3);
    expect(input.strokes[1]).toEqual({
      tool: 'arrow',
      color: '#7755c7',
      width: 9,
      points: [
        [0.1, 0.1],
        [0.4, 0.4],
      ],
    });
  });

  it('reads stored drawings defensively', () => {
    expect(readDrawAnchor(null)).toBeNull();
    expect(readDrawAnchor({ x: 0.1, y: 0.2 })).toBeNull();
    expect(readDrawAnchor({ strokes: [] })).toBeNull();
    const drawing = readDrawAnchor({
      strokes: [
        { tool: 'laser', color: '#000000', points: [[0.1, 0.1]] },
        { tool: 'pen', color: 'red', points: [[0.1, 0.1]] },
        {
          tool: 'pen',
          color: '#D9474F',
          points: [
            [0.2, 0.4],
            [2, 'x'],
            [1.5, -1],
          ],
        },
        {
          tool: 'rect',
          color: '#090a09',
          width: 99,
          points: [
            [0.1, 0.1],
            [0.3, 0.3],
          ],
        },
      ],
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(drawing?.strokes).toHaveLength(2);
    // An old drawing without a width gets the thin line; widths are capped.
    expect(drawing?.strokes[0]).toEqual({
      tool: 'pen',
      color: '#D9474F',
      width: 4,
      points: [
        [0.2, 0.4],
        [1, 0],
      ],
    });
    expect(drawing?.strokes[1]!.width).toBe(24);
    // The box is recomputed from the points, never trusted from storage.
    expect(drawing?.bbox).toEqual({ x: 0.1, y: 0, w: 0.9, h: 0.4 });
  });

  it('draws pen outlines, arrow heads and rectangles in pixels', () => {
    expect(penOutlinePath([], 4, { width: 100, height: 100 })).toBe('');
    const path = penOutlinePath(
      [
        [0.1, 0.1],
        [0.5, 0.2],
        [0.9, 0.1],
      ],
      4,
      { width: 1000, height: 500 },
    );
    expect(path.startsWith('M')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect(outlineToPath([[0, 0]])).toBe('');
    expect(
      outlineToPath([
        [0, 0],
        [10, 0],
      ]),
    ).toBe('M0 0 Q0 0 5 0 Q10 0 5 0 Z');

    // A rightward arrow: both head lines end at the tip and sit behind it.
    const head = arrowHeadPath([0, 0], [100, 0], 4);
    const numbers = head.match(/-?\d+(\.\d+)?/gu)!.map(Number);
    expect(numbers.slice(2, 4)).toEqual([100, 0]);
    expect(numbers[0]).toBeLessThan(100);
    expect(numbers[4]).toBeLessThan(100);
    expect(numbers[1]).toBeCloseTo(-numbers[5]!, 5);

    expect(rectFromCorners([300, 200], [100, 50])).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
  });

  it('offers the seven swatches and three widths of the design', () => {
    expect(DRAW_COLOURS.map((colour) => colour.id)).toEqual([
      'danger',
      'warning',
      'accent',
      'success',
      'client',
      'live',
      'inverse',
    ]);
    expect(new Set(DRAW_COLOURS.map((colour) => colour.hex)).size).toBe(7);
    for (const colour of DRAW_COLOURS) expect(colour.hex).toMatch(/^#[0-9a-f]{6}$/u);
    expect(DRAW_WIDTHS).toEqual([4, 6, 9]);
  });
});
