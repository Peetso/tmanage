import { describe, expect, it } from 'vitest';
import type { FigmaFrameRow } from '../../common/database/schema.js';
import {
  diffFrames,
  parsePageFilter,
  parseStoredOutline,
  placeFrames,
  storedOutlineJson,
  type PlannedFrame,
} from './figma-outline.js';

/**
 * Peter, 2026-11-10 ("it's not capturing the whole page with all its frames") — which frames a
 * link captures and in what order, and what "Refresh from Figma" changes, as pure functions.
 */

function planned(nodeId: string, pageId: string, over: Partial<PlannedFrame> = {}): PlannedFrame {
  return {
    nodeId,
    name: nodeId,
    width: 390,
    height: 844,
    x: 0,
    y: 0,
    pageId,
    pageName: pageId,
    sectionName: null,
    ...over,
  };
}

function row(nodeId: string, over: Partial<FigmaFrameRow> = {}): FigmaFrameRow {
  return {
    id: `row-${nodeId}`,
    organizationId: 'o',
    linkId: 'l',
    nodeId,
    name: nodeId,
    width: 390,
    height: 844,
    snapshotObjectKey: null,
    snapshotHash: null,
    snapshotStatus: 'ready',
    snapshotAttempts: 0,
    claimedAt: null,
    capturedAt: new Date('2026-11-01T00:00:00Z'),
    sizeChanged: false,
    sortOrder: 0,
    pageId: 'p1',
    pageName: 'p1',
    sectionName: null,
    posX: 0,
    posY: 0,
    captureRank: 0,
    goneAt: null,
    hasThumb: false,
    snapshotError: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  };
}

const FILE = [
  planned('1:1', 'p1'),
  planned('2:1', 'p2'),
  planned('1:2', 'p1'),
  planned('2:2', 'p2'),
  planned('3:1', 'p3'),
];

describe('placeFrames', () => {
  it('captures the linked frame first, then its page, then the rest in Figma order', () => {
    const placed = placeFrames(FILE, '2:2', null);
    const order = [...placed.entries()]
      .sort((a, b) => a[1].captureRank - b[1].captureRank)
      .map(([id]) => id);
    expect(order).toEqual(['2:2', '2:1', '1:1', '1:2', '3:1']);
    // The viewer keeps Figma's order.
    expect(placed.get('2:1')?.sortOrder).toBe(1);
  });

  it('a link to a page captures that page first', () => {
    const placed = placeFrames(FILE, 'p3', null);
    expect(placed.get('3:1')?.captureRank).toBe(0);
  });

  it('captures at most the limit, and only the chosen pages', () => {
    const limited = placeFrames(FILE, null, null, 2);
    expect([...limited.values()].filter((place) => place.captured)).toHaveLength(2);
    const chosen = placeFrames(FILE, null, new Set(['p2']));
    expect([...chosen.entries()].filter(([, place]) => place.captured).map(([id]) => id)).toEqual([
      '2:1',
      '2:2',
    ]);
  });
});

describe('diffFrames (Refresh from Figma)', () => {
  it('inserts new frames, updates kept ones in place, marks missing ones gone', () => {
    const rows = [row('1:1'), row('9:9'), row('8:8', { goneAt: new Date() })];
    const now = [planned('1:1', 'p1', { name: 'Renamed', x: 50 }), planned('1:5', 'p1')];
    const diff = diffFrames(rows, now, placeFrames(now, null, null));
    expect(diff.inserts.map((item) => item.frame.nodeId)).toEqual(['1:5']);
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]).toMatchObject({ row: { id: 'row-1:1' }, frame: { name: 'Renamed' } });
    expect(diff.updates[0]?.sizeChanged).toBe(false);
    // Already gone stays gone (not reported twice); 9:9 is newly gone.
    expect(diff.gone.map((item) => item.nodeId)).toEqual(['9:9']);
  });

  it('says "Frame changed" when a captured frame has another size now', () => {
    const now = [planned('1:1', 'p1', { height: 900 })];
    const diff = diffFrames([row('1:1')], now, placeFrames(now, null, null));
    expect(diff.updates[0]?.sizeChanged).toBe(true);
  });
});

describe('stored outline and page filter', () => {
  it('round-trips and reads bad data defensively', () => {
    const json = storedOutlineJson({ pages: [{ id: '0:1', name: 'Mobile' }], truncated: true });
    expect(parseStoredOutline(json)).toEqual({
      pages: [{ id: '0:1', name: 'Mobile' }],
      truncated: true,
    });
    expect(parseStoredOutline(null)).toEqual({ pages: [], truncated: false });
    expect(parseStoredOutline('{nope')).toEqual({ pages: [], truncated: false });
    expect(parsePageFilter('["0:1", 4]')).toEqual(new Set(['0:1']));
    expect(parsePageFilter(null)).toBeNull();
    expect(parsePageFilter('"x"')).toBeNull();
  });
});
